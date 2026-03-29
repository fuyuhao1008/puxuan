import { NextRequest, NextResponse } from 'next/server';
import { chordTransposer, Chord, TransposeResult, isKeyFlats, normalizeAccidentals } from '@/lib/chord-transposer';
import { ArkApiError, callArkChat, callArkChatDetailed, callArkParallel, type ChatMessage } from '@/lib/ark-client';
import { registerFont, createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';

const DEFAULT_CHORD_FONT_FAMILY = '"DejaVu Serif", "Times New Roman", Times, serif';

// 和弦/调号绘制字体（服务端 canvas）。
// 说明：在 Vercel 上，public 静态资源不一定存在于 Serverless 函数文件系统中。
// 这里会尝试：
// 1) 从本地文件系统读取 public/<path>
// 2) 若不存在且在 Vercel（有 VERCEL_URL），从 https://<VERCEL_URL>/<path> 拉取到临时目录再 registerFont
let CHORD_FONT_FAMILY = process.env.CHORD_FONT_FAMILY || DEFAULT_CHORD_FONT_FAMILY;

// 箭头字体：优先使用和弦字体，若缺字形则回退到符号字体，避免出现“白色方框”。
// 可在 .env.local 覆盖：ARROW_FONT_FAMILY="DejaVu Serif", "Segoe UI Symbol", serif
let ARROW_FONT_FAMILY = process.env.ARROW_FONT_FAMILY || `${CHORD_FONT_FAMILY}, "Segoe UI Symbol", serif`;

let fontsReadyPromise: Promise<void> | null = null;

function normalizePublicRelPath(input: string): string {
  return String(input ?? '').trim().replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

async function resolvePublicFileToLocalPath(publicRelPath: string): Promise<string | null> {
  const normalized = normalizePublicRelPath(publicRelPath);
  if (!normalized) return null;

  const candidates = [
    path.join(process.cwd(), 'public', normalized),
    path.join(__dirname, '..', '..', '..', '..', 'public', normalized),
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  const vercelUrl = process.env.VERCEL_URL;
  if (!vercelUrl) return null;

  const url = `https://${vercelUrl}/${normalized}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('⚠️ 无法从 Vercel 静态资源拉取字体:', url, 'status=', res.status);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmpPath = path.join(os.tmpdir(), `public-${path.basename(normalized)}`);
    await fs.promises.writeFile(tmpPath, buf);
    return tmpPath;
  } catch (error) {
    console.warn('⚠️ 拉取字体失败:', url, error);
    return null;
  }
}

async function ensureFontsReady(): Promise<void> {
  if (fontsReadyPromise) return fontsReadyPromise;
  fontsReadyPromise = (async () => {
    // 注册中文字体（用于显示"或"字）
    const orFontPath = await resolvePublicFileToLocalPath('fonts/or-font.ttf');
    if (orFontPath) {
      try {
        registerFont(orFontPath, { family: 'OrFont' });
        console.log('✅ 中文字体已注册: OrFont, 路径:', orFontPath);
      } catch (error) {
        console.warn('⚠️ 中文字体注册失败:', error);
      }
    } else {
      console.warn('⚠️ 中文字体文件未找到，"或"字可能显示异常');
    }

    // 可选：注册服务端绘制用的和弦字体（TTF/OTF）。
    const chordFontFile = process.env.CHORD_FONT_FILE;
    if (chordFontFile) {
      const chordFontPath = await resolvePublicFileToLocalPath(chordFontFile);
      if (chordFontPath) {
        try {
          registerFont(chordFontPath, { family: 'ChordFont' });
          console.log('✅ 和弦字体已注册: ChordFont, 路径:', chordFontPath);
          CHORD_FONT_FAMILY = `"ChordFont", ${process.env.CHORD_FONT_FAMILY || DEFAULT_CHORD_FONT_FAMILY}`;
          ARROW_FONT_FAMILY = process.env.ARROW_FONT_FAMILY || `${CHORD_FONT_FAMILY}, "Segoe UI Symbol", serif`;
        } catch (error) {
          console.warn('⚠️ 和弦字体注册失败，将使用系统默认字体:', error);
        }
      } else {
        console.warn('⚠️ CHORD_FONT_FILE 对应的字体无法解析为本地路径:', chordFontFile);
      }
    }
  })();
  return fontsReadyPromise;
}

/**
 * 视觉模型配置
 * 明确定义每个模型的类型和优先级
 */
interface VisionModelConfig {
  id: string;
  name: string;
  type: 'pure-vision' | 'multimodal';
  priority: number;
}

// 模型配置（使用环境变量，模型名称）
const MODEL_LITE = process.env.VISION_MODEL_LITE || 'doubao-seed-2-0-lite-260215';
const MODEL_VISION = process.env.VISION_MODEL_VISION || 'doubao-seed-1-6-vision-250815';

// CHORD_FONT_FAMILY / ARROW_FONT_FAMILY 在 ensureFontsReady() 内会按需更新。

// 默认主模型（准确度优先）
const MODEL_ACCURATE = MODEL_VISION;

// 可用模型列表（用于模型切换/降级）
const AVAILABLE_VISION_MODELS: VisionModelConfig[] = [
  { id: MODEL_VISION, name: 'Vision', type: 'pure-vision', priority: 1 },
  { id: MODEL_LITE, name: 'Lite', type: 'multimodal', priority: 2 },
];

// ========== 和弦结果合并相关函数 ==========

type ChordCenter = [string[], number, number];  // [["C", "C/E"], cx, cy]

type ParsedModelCenter = {
  text: string;
  chords: string[];
  cx: number;
  cy: number;
};

/**
 * 安全地格式化和弦文本用于日志输出
 */
function formatChordTexts(texts: string[]): string {
  if (!texts || texts.length === 0) return '';
  return texts.join(' 或 ');
}

/**
 * 按 y 坐标分行
 * @param centers 和弦数组（坐标为千分比 0-1000）
 * @param rowThresholdRatio 行阈值比例，默认 3%（基于千分比）
 */
function groupByRow(
  centers: ChordCenter[],
  rowThreshold: number = 30  // 千分比的 3%，即 1000 * 0.03
): { rowY: number; chords: ChordCenter[] }[] {
  const rows: { rowY: number; chords: ChordCenter[] }[] = [];

  for (const chord of centers) {
    const cy = chord[2];
    let foundRow = rows.find(r => Math.abs(r.rowY - cy) <= rowThreshold);

    if (!foundRow) {
      foundRow = { rowY: cy, chords: [] };
      rows.push(foundRow);
    }

    foundRow.chords.push(chord);
  }

  // 每行内按 x 排序
  for (const row of rows) {
    row.chords.sort((a, b) => a[1] - b[1]);
  }

  // 按 y 排序
  rows.sort((a, b) => a.rowY - b.rowY);

  return rows;
}

/**
 * 将 Lite 的行与 Pro 的行一一对应
 * @param rowThreshold 行匹配阈值（千分比）
 */
function matchRows(
  liteRows: { rowY: number; chords: ChordCenter[] }[],
  proRows: { rowY: number; chords: ChordCenter[] }[],
  rowThreshold: number = 30  // 千分比的 3%
): { liteRow: { rowY: number; chords: ChordCenter[] } | null; proRow: { rowY: number; chords: ChordCenter[] } | null }[] {
  const pairs: { liteRow: typeof liteRows[0] | null; proRow: typeof proRows[0] | null }[] = [];

  // 如果行数相同，直接按序数配对
  // Pro 虽然精度高，但有时 y 坐标偏差大；Lite y 坐标更稳定
  if (liteRows.length === proRows.length) {
    console.log(`  行数相同 (${liteRows.length} 行)，按序数直接配对`);
    for (let i = 0; i < liteRows.length; i++) {
      pairs.push({ liteRow: liteRows[i], proRow: proRows[i] });
    }
    return pairs;
  }

  // 行数不同时，按 y 坐标匹配
  console.log(`  行数不同 (Lite: ${liteRows.length}, Pro: ${proRows.length})，按 y 坐标匹配`);
  
  let li = 0, pi = 0;

  while (li < liteRows.length || pi < proRows.length) {
    const liteRow = liteRows[li] || null;
    const proRow = proRows[pi] || null;

    if (!liteRow) {
      pairs.push({ liteRow: null, proRow });
      pi++;
    } else if (!proRow) {
      pairs.push({ liteRow, proRow: null });
      li++;
    } else {
      const dy = Math.abs(liteRow.rowY - proRow.rowY);

      if (dy <= rowThreshold) {
        pairs.push({ liteRow, proRow });
        li++;
        pi++;
      } else if (liteRow.rowY < proRow.rowY) {
        pairs.push({ liteRow, proRow: null });
        li++;
      } else {
        pairs.push({ liteRow: null, proRow });
        pi++;
      }
    }
  }

  return pairs;
}

/**
 * 对单行进行补全
 * @param mainChords 主模型和弦（权重更高）
 * @param auxChords 辅助模型和弦（用于补全遗漏）
 * @param positionTolerance 位置容差（千分比），基于 x 坐标判断
 * @param mainWeight 主模型权重（默认 4，辅助权重为 1）
 * @param skipYWeightedAverage 是否跳过 y 坐标加权平均（精准模式下为 true）
 * 
 * 核心策略：
 * 1. 统计主/辅助模型中各和弦名称的出现次数
 * 2. 如果主模型中某和弦名称出现次数 >= 辅助模型次数，说明已匹配，不需补入
 * 3. 只有当主模型真正遗漏（次数少于辅助模型）时才补入
 */
function complementRow(
  mainChords: ChordCenter[],
  auxChords: ChordCenter[],
  positionTolerance: number = 40,  // 千分比的 4%
  mainWeight: number = 4,  // 主模型权重，辅助模型权重为 1
  skipYWeightedAverage: boolean = false
): ChordCenter[] {
  const result = [...mainChords];
  
  // 统计主模型中各和弦名称的出现次数
  const mainNameCounts = new Map<string, number>();
  for (const chord of mainChords) {
    for (const name of chord[0]) {
      mainNameCounts.set(name, (mainNameCounts.get(name) || 0) + 1);
    }
  }
  
  // 统计辅助模型中各和弦名称的出现次数
  const auxNameCounts = new Map<string, number>();
  for (const chord of auxChords) {
    for (const name of chord[0]) {
      auxNameCounts.set(name, (auxNameCounts.get(name) || 0) + 1);
    }
  }
  
  // 记录已处理的主模型和弦的 x 坐标
  const processedXSet = new Set<number>();
  
  // ========== 第一遍：处理匹配的和弦，收集加权平均后的 y 坐标 ==========
  const weightedYList: number[] = [];
  
  for (const auxChord of auxChords) {
    const auxX = auxChord[1];
    const auxY = auxChord[2];
    const auxChordTexts = auxChord[0];

    // 在主模型中查找 x 坐标相近且未被处理过的和弦
    const nearbyIndex = result.findIndex(mainChord => {
      const mainX = mainChord[1];
      return Math.abs(mainX - auxX) <= positionTolerance && !processedXSet.has(mainX);
    });

    if (nearbyIndex !== -1) {
      const nearbyMainChord = result[nearbyIndex];
      const mainX = nearbyMainChord[1];
      const mainChordTexts = nearbyMainChord[0];
      const mainY = nearbyMainChord[2];
      
      // 不再进行内容纠正，保留主模型结果
      // Vision模型可能会错误地把"C(A)"识别为"C或A"，而Lite模型格式是正确的
      
      // y 坐标处理：精准模式直接用主模型坐标，快速模式加权平均
      if (skipYWeightedAverage) {
        // 精准模式：直接用主模型的 y 坐标，不参与加权平均
        processedXSet.add(mainX);
        weightedYList.push(mainY);
        console.log(`  📍 精准模式保留主模型坐标: "${formatChordTexts(mainChordTexts)}" 主模型.y=${mainY}`);
      } else {
        // 快速模式：y 坐标加权平均
        const weightedY = Math.round((mainY * mainWeight + auxY * 1) / (mainWeight + 1));
        result[nearbyIndex] = [nearbyMainChord[0], nearbyMainChord[1], weightedY];
        processedXSet.add(mainX);
        weightedYList.push(weightedY);
        console.log(`  🔀 y坐标加权平均: "${formatChordTexts(mainChordTexts)}" 主模型.y=${mainY}(权重${mainWeight}), 辅助.y=${auxY}(权重1) → 加权.y=${weightedY}`);
      }
    }
  }
  
  // 计算加权平均后的 y 坐标均值（用于补入和弦的 y 坐标）
  const weightedYMean = weightedYList.length > 0 
    ? Math.round(weightedYList.reduce((sum, y) => sum + y, 0) / weightedYList.length)
    : (mainChords.length > 0 ? Math.round(mainChords.reduce((sum, c) => sum + c[2], 0) / mainChords.length) : null);
  
  // 记录已补入的和弦名称及次数
  const supplementedCounts = new Map<string, number>();
  
  // ========== 第二遍：处理需要补入的和弦 ==========
  for (const auxChord of auxChords) {
    const auxX = auxChord[1];
    const auxY = auxChord[2];
    const auxChordTexts = auxChord[0];

    // 检查是否已经被处理过（在第一遍中匹配上了）
    const wasProcessed = [...processedXSet].some(mainX => {
      const mainChord = result.find(c => c[1] === mainX);
      return mainChord && Math.abs(mainChord[1] - auxX) <= positionTolerance;
    });
    
    if (wasProcessed) continue;

    // 位置不相近，检查是否需要补入（基于次数统计）
    const auxName = auxChordTexts[0] || '';
    const mainCount = mainNameCounts.get(auxName) || 0;
    const auxCount = auxNameCounts.get(auxName) || 0;
    const supplementedCount = supplementedCounts.get(auxName) || 0;
    
    // 判断是否需要补入
    // x = 主模型中该和弦名称的出现次数
    // y = 辅助模型中该和弦名称的出现次数
    // z = 当前准备补入的数量（每次循环处理一个和弦，固定为 1）
    // 若 x + supplementedCount + z > y，则不补入；反之则补入
    if (mainCount + supplementedCount + 1 > auxCount) {
      console.log(`  ⏭️ 跳过(补入后会超过辅助模型次数): "${auxName}" 主${mainCount}+补${supplementedCount}+1 > 辅${auxCount}`);
      continue;
    }
    
    // 真正遗漏，补入
    let insertIndex = result.findIndex(c => c[1] > auxX);
    if (insertIndex === -1) insertIndex = result.length;
    
    // y 坐标使用加权平均后的 y 坐标均值，x 坐标沿用辅助模型的
    const finalY = weightedYMean !== null ? weightedYMean : auxY;
    const chordToInsert: ChordCenter = [auxChordTexts, auxX, finalY];
    
    result.splice(insertIndex, 0, chordToInsert);
    supplementedCounts.set(auxName, supplementedCount + 1);
    console.log(`  📌 补全和弦: "${auxName}" 主${mainCount}+补${supplementedCount + 1} <= 辅${auxCount} 于位置 (${auxX}, ${finalY})`);
  }

  return result;
}

/**
 * 对单个模型的识别结果进行和弦修正
 * 在合并前对主模型和辅助模型分别调用，确保合并时比较的是修正后的正确内容
 * 
 * @param modelResult 模型识别结果
 * @param originalKey 原调
 * @param isFastMode 是否快速模式
 * @returns 修正后的结果
 */
function correctModelResult(
  modelResult: { key: string | null; centers: ChordCenter[]; modelUsed?: string },
  originalKey: string,
  isFastMode: boolean
): { key: string | null; centers: ChordCenter[]; modelUsed?: string } {
  const correctedCenters = modelResult.centers.map(center => {
    const [chords, cx, cy] = center;
    // 对每个和弦文本进行修正
    const correctedChords = chords.map(chord => {
      const corrected = chordTransposer.correctChordByKey(chord, originalKey, isFastMode);
      if (corrected !== chord) {
        console.log(`  🔧 合并前修正(${modelResult.modelUsed || '模型'}): ${chord} → ${corrected}`);
      }
      return corrected;
    });
    return [correctedChords, cx, cy] as ChordCenter;
  });

  return {
    ...modelResult,
    centers: correctedCenters
  };
}

/**
 * 整合主模型和辅助模型的识别结果
 * 以主模型为主体，补充辅助模型识别出但主模型遗漏的和弦
 * 
 * @param mainResult 主模型结果（权重更高，坐标更可信）
 * @param auxResult 辅助模型结果（用于补全遗漏）
 * @param imgWidth 图片宽度
 * @param imgHeight 图片高度
 * @param mainWeight 主模型权重（默认 4，用于 y 坐标加权平均）
 * @param skipYWeightedAverage 是否跳过 y 坐标加权平均（精准模式下为 true，直接用主模型坐标）
 */
function mergeResults(
  mainResult: { key: string | null; centers: ChordCenter[]; modelUsed?: string },
  auxResult: { key: string | null; centers: ChordCenter[]; modelUsed?: string },
  imgWidth: number,
  imgHeight: number,
  mainWeight: number = 4,
  skipYWeightedAverage: boolean = false
): { key: string | null; centers: ChordCenter[] } {

  const mainModelName = mainResult.modelUsed || '主模型';
  const auxModelName = auxResult.modelUsed || '辅助模型';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 开始合并结果 (${mainModelName} 为主体)`);
  console.log(`${'='.repeat(60)}`);
  
  // ========== 日志：模型返回的完整结果 ==========
  console.log(`\n📋 【${mainModelName} 返回结果】(主体，权重${mainWeight})`);
  console.log(`   调号: ${mainResult.key || '未知'}`);
  console.log(`   和弦数: ${mainResult.centers.length}`);
  if (mainResult.centers.length > 0) {
    console.log(`   和弦详情 (文本, x, y):`);
    mainResult.centers.forEach((c, i) => {
      console.log(`     [${i}] "${c[0].join('或')}" (${c[1]}, ${c[2]})`);
    });
  }
  
  console.log(`\n📋 【${auxModelName} 返回结果】(辅助，权重1)`);
  console.log(`   调号: ${auxResult.key || '未知'}`);
  console.log(`   和弦数: ${auxResult.centers.length}`);
  if (auxResult.centers.length > 0) {
    console.log(`   和弦详情 (文本, x, y):`);
    auxResult.centers.forEach((c, i) => {
      console.log(`     [${i}] "${c[0].join('或')}" (${c[1]}, ${c[2]})`);
    });
  }
  
  console.log(`\n🔄 【合并过程】`);

  // 根据图片宽高比计算阈值（坐标为千分比 0-1000）
  // minDimension 对应千分比 1000，所以基础阈值是 1000 * 4% = 40
  // 但 y 方向需要按比例调整：rowThreshold = 40 * minDimension / imgHeight
  // 注：调大行阈值避免同一行的和弦被误判为两行（如 y=862 和 y=877）
  const minDimension = Math.min(imgWidth, imgHeight);
  const ROW_THRESHOLD = 25;  // 行匹配阈值（固定值25千分比）
  const POSITION_TOLERANCE = 40;  // 位置容差（x方向），千分比的 4%

  console.log(`   图片尺寸: ${imgWidth}×${imgHeight}, minDimension: ${minDimension}`);
  console.log(`   行阈值: ${ROW_THRESHOLD} (千分比), 位置容差: ${POSITION_TOLERANCE} (千分比)`);

  // 1. 分别分行
  const mainRows = groupByRow(mainResult.centers, ROW_THRESHOLD);
  const auxRows = groupByRow(auxResult.centers, ROW_THRESHOLD);

  console.log(`\n   📊 分行结果:`);
  console.log(`      ${mainModelName}: ${mainRows.length} 行`);
  mainRows.forEach((row, i) => {
    console.log(`        行${i}: y=${row.rowY}, 和弦=[${row.chords.map(c => `"${c[0].join('或')}"`).join(', ')}]`);
  });
  console.log(`      ${auxModelName}:  ${auxRows.length} 行`);
  auxRows.forEach((row, i) => {
    console.log(`        行${i}: y=${row.rowY}, 和弦=[${row.chords.map(c => `"${c[0].join('或')}"`).join(', ')}]`);
  });

  // 2. 行匹配
  console.log(`\n   📊 行匹配:`);
  const rowPairs = matchRows(mainRows, auxRows, ROW_THRESHOLD);
  rowPairs.forEach((pair, i) => {
    const mainInfo = pair.liteRow ? `${mainModelName}行${mainRows.indexOf(pair.liteRow)}(y=${pair.liteRow.rowY}, ${pair.liteRow.chords.length}个)` : 'null';
    const auxInfo = pair.proRow ? `${auxModelName}行${auxRows.indexOf(pair.proRow)}(y=${pair.proRow.rowY}, ${pair.proRow.chords.length}个)` : 'null';
    console.log(`      配对${i}: ${mainModelName}=${mainInfo}, ${auxModelName}=${auxInfo}`);
  });

  // 3. 逐行比对与补全
  console.log(`\n   📊 逐行比对与补全:`);
  const mergedCenters: ChordCenter[] = [];
  let supplementedCount = 0;

  for (let i = 0; i < rowPairs.length; i++) {
    const pair = rowPairs[i];
    const mainRow = pair.liteRow;  // 主模型行
    const auxRow = pair.proRow;    // 辅助模型行
    console.log(`\n      --- 配对${i} ---`);

    if (mainRow && auxRow) {
      // 两模型都有这行：对比和弦，补全主模型遗漏的
      console.log(`         两模型都有此行:`);
      console.log(`            ${mainModelName}: ${mainRow.chords.length} 个和弦`);
      console.log(`            ${auxModelName}:  ${auxRow.chords.length} 个和弦`);
      const beforeCount = mainRow.chords.length;
      const merged = complementRow(mainRow.chords, auxRow.chords, POSITION_TOLERANCE, mainWeight, skipYWeightedAverage);
      const afterCount = merged.length;
      supplementedCount += afterCount - beforeCount;
      if (afterCount > beforeCount) {
        console.log(`            ✅ 补全了 ${afterCount - beforeCount} 个和弦`);
      }
      mergedCenters.push(...merged);
    } else if (auxRow) {
      // 只有辅助模型有（可能是主模型遗漏整行）
      console.log(`         只有 ${auxModelName} 有此行 (${mainModelName} 遗漏):`);
      let addedCount = 0;
      for (const auxChord of auxRow.chords) {
        const auxX = auxChord[1];
        const auxY = auxChord[2];
        
        // 只检查位置是否已存在相近的和弦（不检查名称，因为同一名称可在不同行出现）
        const existsByPosition = mergedCenters.some(c =>
          Math.abs(c[1] - auxX) <= POSITION_TOLERANCE && Math.abs(c[2] - auxY) <= ROW_THRESHOLD
        );
        
        if (!existsByPosition) {
          mergedCenters.push(auxChord);
          supplementedCount++;
          addedCount++;
          console.log(`            📌 补入: "${auxChord[0].join('或')}" (${auxX}, ${auxY})`);
        } else {
          console.log(`            ⏭️ 跳过重复(位置): "${auxChord[0].join('或')}" (${auxX}, ${auxY})`);
        }
      }
      if (addedCount === 0) {
        console.log(`            无新和弦补入（均重复）`);
      }
    } else if (mainRow) {
      // 只有主模型有（辅助模型遗漏了整行），保留主模型的结果
      console.log(`         只有 ${mainModelName} 有此行 (${auxModelName} 遗漏):`);
      console.log(`            保留 ${mainModelName} 的 ${mainRow.chords.length} 个和弦`);
      mergedCenters.push(...mainRow.chords);
    }
  }

  // 4. 最终排序（按 y 再按 x）
  mergedCenters.sort((a, b) => {
    const dy = a[2] - b[2];
    if (Math.abs(dy) > ROW_THRESHOLD) return dy;
    return a[1] - b[1];
  });

  // ========== 日志：合并后最终结果 ==========
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ 【合并完成】`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   调号: ${mainResult.key || auxResult.key}`);
  console.log(`   补全和弦数: ${supplementedCount}`);
  console.log(`   最终和弦数: ${mergedCenters.length}`);
  console.log(`   最终和弦详情 (文本, x, y):`);
  mergedCenters.forEach((c, i) => {
    console.log(`     [${i}] "${c[0].join('或')}" (${c[1]}, ${c[2]})`);
  });
  console.log(`${'='.repeat(60)}\n`);

  return {
    key: mainResult.key || auxResult.key,  // 优先使用主模型的调号
    centers: mergedCenters
  };
}

// ========== 模型配置相关函数 ==========
function getModelConfig(modelId: string): VisionModelConfig | undefined {
  return AVAILABLE_VISION_MODELS.find((m) => m.id === modelId);
}

/**
 * 获取模型优先级
 */
function getVisionModelPriority(modelId: string): number {
  const config = getModelConfig(modelId);
  if (config) {
    return config.priority;
  }
  // 如果模型不在列表中，默认最低优先级
  return 3;
}

/**
 * 获取模型类型描述
 */
function getModelTypeDescription(modelId: string): string {
  const config = getModelConfig(modelId);
  if (config) {
    return config.type === 'pure-vision' ? '纯视觉模型 ✓' : '多模态模型';
  }
  return '未知模型';
}

/**
 * 获取用户配置的主模型
 * 支持通过 VISION_MODEL 环境变量指定任意模型名称
 * 默认使用 Pro 模型（准确度优先）
 */
function getPrimaryModel(): string {
  const configuredModel = process.env.VISION_MODEL;
  
  // 如果配置了模型，使用配置的模型
  if (configuredModel && configuredModel.trim() !== '') {
    return configuredModel.trim();
  }
  
  // 默认使用 Pro 模型（准确度优先）
  return MODEL_ACCURATE;
}

/**
 * 检查模型是否包含"视觉"或"vision"关键词（不区分大小写）
 */
function isVisionKeywordModel(model: VisionModelConfig): boolean {
  const lowerId = model.id.toLowerCase();
  const lowerName = model.name.toLowerCase();
  return lowerId.includes('vision') || lowerName.includes('vision') ||
         lowerId.includes('视觉') || lowerName.includes('视觉');
}

/**
 * 智能选择备用模型（优先视觉模型）
 * 优先级：1. 包含"视觉"/"vision"关键词的模型 2. 纯视觉模型 3. 多模态模型
 * 排除当前失败的模型
 */
function selectFallbackModel(excludedModel: string): string {
  const excludedConfig = getModelConfig(excludedModel);
  
  // 过滤掉已失败的模型
  const availableModels = AVAILABLE_VISION_MODELS.filter((m) => m.id !== excludedModel);
  
  if (availableModels.length === 0) {
    throw new Error('没有可用的备用模型');
  }
  
  // 策略1：优先选择包含"视觉"/"vision"关键词的模型
  const visionKeywordModels = availableModels.filter((m) => isVisionKeywordModel(m));
  if (visionKeywordModels.length > 0) {
    const selected = visionKeywordModels[0];
    return selected.id;
  }
  
  // 策略2：按模型类型优先级选择（纯视觉 > 多模态）
  const pureVisionModels = availableModels.filter((m) => m.type === 'pure-vision');
  const multimodalModels = availableModels.filter((m) => m.type === 'multimodal');
  
  // 优先选择纯视觉模型
  if (pureVisionModels.length > 0) {
    const selected = pureVisionModels[0];
    return selected.id;
  }
  
  // 其次选择多模态模型
  if (multimodalModels.length > 0) {
    const selected = multimodalModels[0];
    return selected.id;
  }
  
  // 如果所有策略都失败，返回第一个可用模型
  return availableModels[0].id;
}

export async function POST(request: NextRequest) {
  const fontsReady = ensureFontsReady();
  try {
    const totalStart = Date.now();
    const formData = await request.formData();
    const imageFile = formData.get('image') as File;
    const targetKey = formData.get('targetKey') as string;
    const originalKeyInput = formData.get('originalKey') as string;
    const anchorFirstStr = formData.get('anchorFirst') as string;
    const anchorLastStr = formData.get('anchorLast') as string;
    const directionStr = formData.get('direction') as string;
    const semitonesStr = formData.get('semitones') as string;
    const onlyRecognizeKey = formData.get('onlyRecognizeKey') as string;
    const chordsDataStr = formData.get('chordsData') as string; // 前端传递的预存和弦数据
    const chordColor = (formData.get('chordColor') as string) || '#2563EB'; // 默认蓝色
    const fontSizeStr = formData.get('fontSize') as string; // 字体大小参数
    const modelMode = formData.get('modelMode') as string; // 模型模式：'fast' | 'accurate'
    const isFastMode = modelMode === 'fast'; // 快速模式标志（用于和弦修正逻辑）

    if (!imageFile) {
      return NextResponse.json({ error: '请上传图片' }, { status: 400 });
    }

    // 如果只是识别原调（同时识别和弦，复用于转调）
    if (onlyRecognizeKey === 'true') {
      const tRecognizeStart = Date.now();
      // 将图片转换为 buffer
      const originalImageBuffer = Buffer.from(await imageFile.arrayBuffer());

      // 使用 Canvas 获取原始图片尺寸
      const originalImage = await loadImage(originalImageBuffer);
      const originalWidth = originalImage.width || 800;
      const originalHeight = originalImage.height || 1000;

      // 智能放大低分辨率图片（用于AI识别）
      const aiImage = await upscaleImageIfNeeded(originalImageBuffer, imageFile.type);
      const imgWidth = aiImage.width;
      const imgHeight = aiImage.height;

      if (aiImage.wasUpscaled) {
        console.log(`✅ AI识别使用放大图片: ${imgWidth}x${imgHeight}（原始: ${originalWidth}x${originalHeight}）`);
      }

      // 将图片转换为 base64
      const imageBase64 = `data:${aiImage.mimeType};base64,${aiImage.buffer.toString('base64')}`;

      console.log(
        `🖼️ AI输入图: inputType=${imageFile.type || 'unknown'} originalBytes=${originalImageBuffer.length} aiBytes=${aiImage.buffer.length} dataUrlChars=${imageBase64.length} upscaled=${aiImage.wasUpscaled}`
      );

      // 识别原调和和弦（一次调用，返回完整结果）
      const recognitionResult = await recognizeChordsFromImage(imageBase64, imageFile.type, imgWidth, imgHeight, modelMode || 'accurate');

      console.log(`⏱️ onlyRecognizeKey 总耗时: ${Date.now() - tRecognizeStart}ms`);

      // 确定原调（用于和弦修正）
      const detectedKey = recognitionResult.key ? chordTransposer.normalizeKey(recognitionResult.key) : null;
      
      // 规范化识别结果中的升降号（♯ → #, ♭ → b）并应用和弦修正
      const normalizedCenters = (recognitionResult.centers || []).map((center: any) => {
        // 处理 chords 数组中的每个和弦
        const correctedChords = center.chords?.map((chord: any) => {
          const chordText = typeof chord === 'string' ? chord : chord?.text || '';
          // 先规范化升降号
          let normalized = normalizeAccidentals(chordText);
          // 如果识别出了原调，应用和弦修正（如 C/D 调的 B→D 转换）
          if (detectedKey && isFastMode) {
            const corrected = chordTransposer.correctChordByKey(normalized, detectedKey, true);
            if (corrected !== normalized) {
              console.log(`  🔧 首次识别修正: ${normalized} → ${corrected} (原调: ${detectedKey})`);
            }
            normalized = corrected;
          }
          return normalized;
        }) || [];
        
        // 处理 text 字段
        let correctedText = normalizeAccidentals(center.text);
        if (detectedKey && isFastMode) {
          const corrected = chordTransposer.correctChordByKey(correctedText, detectedKey, true);
          if (corrected !== correctedText) {
            console.log(`  🔧 首次识别修正: ${correctedText} → ${corrected} (原调: ${detectedKey})`);
          }
          correctedText = corrected;
        }
        
        return {
          ...center,
          text: correctedText,
          chords: correctedChords,
        };
      });

      // 返回原调和完整的识别结果（前端会存储后者用于转调）
      const response = NextResponse.json({
        originalKey: detectedKey,
        recognizedCenters: normalizedCenters,
      });

      console.log(`⏱️ /api/transpose total: ${Date.now() - totalStart}ms (onlyRecognizeKey)`);
      return response;
    }

    // 正常转调流程
    if (!targetKey) {
      return NextResponse.json({ error: '请选择目标调' }, { status: 400 });
    }

    // 计算实际半音数
    let semitones = 0;
    if (directionStr && semitonesStr) {
      const dir = directionStr === 'up' ? 1 : -1;
      semitones = dir * parseFloat(semitonesStr);
    }

    // 解析用户指定的锚点（可选）
    let userAnchorFirst = null;
    let userAnchorLast = null;
    if (anchorFirstStr && anchorLastStr) {
      userAnchorFirst = JSON.parse(anchorFirstStr);
      userAnchorLast = JSON.parse(anchorLastStr);
    }

    const tProcessStart = Date.now();
    // 保存原始图片buffer（用于最终标注）
    const originalImageBuffer = Buffer.from(await imageFile.arrayBuffer());

    // 使用 Canvas 获取原始图片尺寸
    const originalImage = await loadImage(originalImageBuffer);
    const originalWidth = originalImage.width || 800;
    const originalHeight = originalImage.height || 1000;

    // 推导 AI 识别时使用的目标尺寸（不做实际重编码/放大）
    // 说明：如果本次请求能复用 centers，就不需要生成 AI 输入图（这是最耗时的部分）
    const aiDims = computeAiTargetDimensions(originalWidth, originalHeight);
    let imgWidth: number = aiDims.width;
    let imgHeight: number = aiDims.height;
    let wasUpscaled: boolean = aiDims.wasUpscaled;

    // 识别和弦：如果前端传递了预存数据，直接使用；否则调用大模型
    // 注意：只要 centers 数据存在，就使用它，不因为 key 为空而重新识别
    // key 为空只说明 AI 没识别出原调，用户可以手动选择
    let recognitionResult: any = null;
    if (chordsDataStr) {
      try {
        const parsed = JSON.parse(chordsDataStr);
        if (parsed?.centers && Array.isArray(parsed.centers) && parsed.centers.length > 0) {
          recognitionResult = parsed;
          console.log(`✅ 使用预存的 centers 数据 (${recognitionResult.centers.length} 个和弦)`);
          if (!recognitionResult.key) {
            console.log('ℹ️ 预存数据中没有 key，用户将手动选择原调');
          }
        } else {
          console.log('⚠️ 预存数据中没有 centers，需要重新识别');
        }
      } catch (error) {
        console.log('⚠️ 解析预存数据失败，需要重新识别');
      }
    } else {
      console.log('ℹ️ 没有预存数据，需要调用 AI 识别');
    }

    if (!recognitionResult) {
      const aiImage = await upscaleImageIfNeeded(originalImageBuffer, imageFile.type);
      imgWidth = aiImage.width;
      imgHeight = aiImage.height;
      wasUpscaled = aiImage.wasUpscaled;

      const imageBase64 = `data:${aiImage.mimeType};base64,${aiImage.buffer.toString('base64')}`;

      console.log(
        `🖼️ AI输入图: inputType=${imageFile.type || 'unknown'} originalBytes=${originalImageBuffer.length} aiBytes=${aiImage.buffer.length} dataUrlChars=${imageBase64.length} upscaled=${aiImage.wasUpscaled}`
      );

      console.log(`⏱️ 图片预处理耗时: ${Date.now() - tProcessStart}ms (load + maybe upscale + base64)`);

      recognitionResult = await recognizeChordsFromImage(imageBase64, imageFile.type, imgWidth, imgHeight, modelMode || 'accurate');
    } else {
      if (wasUpscaled) {
        console.log(`✅ 复用 centers：推导AI尺寸 ${imgWidth}x${imgHeight}（原始: ${originalWidth}x${originalHeight}）`);
      }
      console.log(`⏱️ 图片预处理耗时: ${Date.now() - tProcessStart}ms (load only; reuse centers)`);
    }

    if (!recognitionResult) {
      console.error('❌ 识别结果为空');
      return NextResponse.json({ error: '和弦识别失败：AI未返回有效结果' }, { status: 500 });
    }

    // 验证识别结果的格式
    if (!recognitionResult.centers || !Array.isArray(recognitionResult.centers)) {
      console.error('❌ 识别结果格式错误：缺少centers数组');
      console.error('识别结果结构:', JSON.stringify(recognitionResult, null, 2));
      return NextResponse.json({ error: '和弦识别失败：AI返回格式错误' }, { status: 500 });
    }

    // 检查是否有有效的和弦（快速预检查）
    const hasValidCenters = recognitionResult.centers.some(
      (c: any) => typeof c.cx === 'number' && typeof c.cy === 'number' && !isNaN(c.cx) && !isNaN(c.cy)
    );

    if (!hasValidCenters) {
      console.error('❌ 未识别到有效的和弦');
      console.error('centers数组长度:', recognitionResult.centers.length);
      console.error('centers内容:', JSON.stringify(recognitionResult.centers, null, 2));
      return NextResponse.json({ error: '和弦识别失败：未识别到有效的和弦' }, { status: 500 });
    }

    console.log(`✅ 识别结果预检查通过，centers数组长度: ${recognitionResult.centers.length}`);

    // 计算缩放比例（如果图片被放大了）
    const scaleX = originalWidth / imgWidth;
    const scaleY = originalHeight / imgHeight;
    // 注意：wasUpscaled 仅用于日志/调试，不影响坐标缩放逻辑

    // 确定原调（需要用于OCR修正）
    let originalKey = originalKeyInput;

    if (!originalKey && recognitionResult.key) {
      originalKey = chordTransposer.normalizeKey(recognitionResult.key);
    }
    if (!originalKey) {
      originalKey = 'C'; // 默认 C 调
    }

    // 解析识别出的和弦（使用中心点坐标）
    const chords: Chord[] = [];
    const rawCenters = recognitionResult.centers || [];

    // 收集所有有效的中心点坐标（千分比坐标 0-1000）
    const validCenters = rawCenters.filter(
      (c: any) => typeof c.cx === 'number' && typeof c.cy === 'number' && !isNaN(c.cx) && !isNaN(c.cy) &&
                   c.cx >= 0 && c.cx <= imgWidth && c.cy >= 0 && c.cy <= imgHeight
    );

    // 去重和异常值检测（坐标为千分比 0-1000）
    const dedupedCenters: any[] = [];
    // 千分比距离阈值：1% 的最大边长对应千分比 10
    const minDimension = Math.min(imgWidth, imgHeight);
    const distanceThreshold = 10;  // 千分比的 1%

    // 检测异常Y值：计算所有和弦的Y坐标中位数
    const yCoordinates = validCenters.map((c: any) => c.cy);
    const sortedY = [...yCoordinates].sort((a: number, b: number) => a - b);
    const medianY = sortedY[Math.floor(sortedY.length / 2)];
    const yStdDev = Math.sqrt(yCoordinates.reduce((sum: number, y: number) => sum + Math.pow(y - medianY, 2), 0) / yCoordinates.length);

    for (const center of validCenters) {
      let isDuplicate = false;

      // 异常值检测：排除Y坐标偏离中位数超过3个标准差的和弦
      if (validCenters.length > 5 && Math.abs(center.cy - medianY) > 3 * yStdDev) {
        continue;
      }

      // 去重：只有当和弦文本相同且距离很近时，才认为是重复
      for (const existing of dedupedCenters) {
        // 先检查和弦文本是否相同（规范化比较）
        if (center.text.toLowerCase().trim() !== existing.text.toLowerCase().trim()) {
          continue; // 不同和弦，不进行距离检测
        }

        // 相同和弦，再检查距离（千分比坐标）
        const dx = center.cx - existing.cx;
        const dy = center.cy - existing.cy;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < distanceThreshold) {
          isDuplicate = true;
          console.log(`⚠️ 检测到重复和弦: ${center.text} 与 ${existing.text} 千分比距离 ${distance.toFixed(1)}，跳过`);
          break;
        }
      }

      if (!isDuplicate) {
        dedupedCenters.push(center);
      }
    }

    // 显式排序：按Y坐标优先（从上到下），X坐标次之（从左到右）
    // 行阈值：根据图片宽高比计算（千分比坐标）
    const rowThresholdForSort = Math.round(30 * minDimension / imgHeight);
    dedupedCenters.sort((a: any, b: any) => {
      if (Math.abs(a.cy - b.cy) < rowThresholdForSort) { // 千分比坐标，按图片比例调整阈值
        return a.cx - b.cx; // 同一行按X排序
      }
      return a.cy - b.cy; // 不同行按Y排序
    });

    console.log(`✅ 去重完成: ${validCenters.length} → ${dedupedCenters.length}`);

    if (dedupedCenters.length > 0) {
      // ========== 直接使用千分比坐标 ==========
      // Y轴：根据是否有用户锚点决定
      let userMinY = null;
      let userMaxY = null;

      if (userAnchorFirst && userAnchorLast) {
        userMinY = userAnchorFirst.y;
        userMaxY = userAnchorLast.y;
      }

      // 对每个和弦直接使用千分比坐标
      for (let i = 0; i < dedupedCenters.length; i++) {
        const rawCenter = dedupedCenters[i];

        // X轴：直接使用千分比
        const x = rawCenter.cx / 10;  // 千分比 → 百分比

        // Y轴：根据是否有用户锚点
        let y;

        if (userMinY !== null && userMaxY !== null) {
          // 使用用户锚点进行Y轴校准
          const aiMinY = Math.min(...dedupedCenters.map((c: any) => c.cy));
          const aiMaxY = Math.max(...dedupedCenters.map((c: any) => c.cy));

          const ratioY = (rawCenter.cy - aiMinY) / (aiMaxY - aiMinY || 1);
          y = userMinY + ratioY * (userMaxY - userMinY);
        } else {
          // 直接使用千分比
          y = rawCenter.cy / 10;
        }

        // 检查AI是否返回了chords数组（处理"或"字连接的和弦）
        if (rawCenter.chords && Array.isArray(rawCenter.chords)) {
          // 解析chords数组中的每个和弦字符串
          const parsedChords: Chord[] = [];
          for (const chordText of rawCenter.chords) {
            // 根据原调修正和弦（修正遗漏的升降号）
            const correctedChordText = chordTransposer.correctChordByKey(chordText, originalKey, isFastMode);

            const parsed = chordTransposer.parseChord(correctedChordText);
            if (parsed) {
              parsedChords.push(parsed);
            }
          }

          // 如果成功解析了所有和弦，添加到列表
          if (parsedChords.length > 0) {
            // 生成规范化的"或"字连接的文本
            const normalizedChordTexts = parsedChords.map(c => chordTransposer.chordToString(c, false));
            const combinedText = normalizedChordTexts.join('或');

            chords.push({
              root: parsedChords[0].root,
              quality: parsedChords[0].quality,
              bass: parsedChords[0].bass,
              x: x,
              y: y,
              text: combinedText,
              chords: parsedChords,
            } as Chord & { text: string; chords: Chord[] });
          }
        } else {
          // 普通和弦，按原有逻辑处理
          // 根据原调修正AI识别的和弦（修正遗漏的升降号）
          const correctedChordText = chordTransposer.correctChordByKey(rawCenter.text, originalKey, isFastMode);
          if (correctedChordText !== rawCenter.text) {
            console.log(`  ✅ OCR修正: ${rawCenter.text} → ${correctedChordText}`);
          }

          const parsed = chordTransposer.parseChord(correctedChordText);
          if (parsed) {
            chords.push({
              ...parsed,
              x: x,
              y: y,
            });
          }
        }
      }
    }

    // 展开 chords 数组（处理"或"字连接的和弦）
    const expandedChords: Array<{chord: Chord, originalIndex: number, subIndex?: number}> = [];
    chords.forEach((chordObj, index) => {
      if (Array.isArray((chordObj as any).chords)) {
        // 如果有 chords 数组，分别展开
        (chordObj as any).chords.forEach((subChord: Chord, subIdx: number) => {
          expandedChords.push({
            chord: subChord,
            originalIndex: index,
            subIndex: subIdx
          });
        });
      } else {
        // 普通 chord，直接添加
        expandedChords.push({
          chord: chordObj,
          originalIndex: index
        });
      }
    });

    // 准备转调的和弦列表
    const chordsToTranspose = expandedChords.map(item => item.chord);

    // 执行转调
    let transposeResult: TransposeResult;
    if (semitones !== 0) {
      transposeResult = chordTransposer.transposeChordsBySemitones(chordsToTranspose, originalKey, semitones, true, targetKey);
    } else {
      transposeResult = chordTransposer.transposeChords(chordsToTranspose, originalKey, targetKey, true);
    }

    // 输出关键信息
    console.log(`🎵 转调: ${originalKey} → ${transposeResult.targetKey}, 和弦数: ${chords.length}`);

    // 根据目标调决定是否使用降号形式
    const flatKeys = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const shouldUseFlats = flatKeys.includes(transposeResult.targetKey);

    // 重新组织转调结果，将"或"字连接的和弦合并
    const mergedTransposeResult: TransposeResult = {
      ...transposeResult,
      chords: chords.map((originalChord, index) => {
        // 检查是否有 chords 数组
        if (Array.isArray((originalChord as any).chords)) {
          // 找到对应的转调结果
          let transposedCount = 0;
          const transposedChords: Chord[] = [];
          expandedChords.forEach((item, expandedIndex) => {
            if (item.originalIndex === index) {
              transposedChords.push(transposeResult.chords[expandedIndex].transposed);
              transposedCount++;
            }
          });

          // 创建合并后的转调结果（保留x和y坐标）
          const firstTransposed = transposeResult.chords.find(c => c.original === (originalChord as any).chords[0]);
          
          return {
            original: originalChord as Chord,
            transposed: {
              ...firstTransposed?.transposed,
              x: originalChord.x, // 保留原始x坐标
              y: originalChord.y, // 保留原始y坐标
              chords: transposedChords,
              text: transposedChords.map(c => chordTransposer.chordToString(c, shouldUseFlats)).join('或')
            } as Chord & { chords?: Chord[], text?: string }
          };
        } else {
          // 普通 chord，找到对应的转调结果
          const expandedIndex = expandedChords.findIndex(e => e.originalIndex === index && e.subIndex === undefined);
          const transposedChord = transposeResult.chords[expandedIndex]?.transposed;
          return {
            original: originalChord as Chord,
            transposed: transposedChord || originalChord as Chord
          };
        }
      })
    };

    // 使用 mergedTransposeResult 替代 transposeResult
    transposeResult = mergedTransposeResult;

    // 处理字体大小参数
    let fontSize = null;
    if (fontSizeStr) {
      const parsedFontSize = parseFloat(fontSizeStr);
      if (!isNaN(parsedFontSize) && parsedFontSize > 0) {
        fontSize = parsedFontSize;
      }
    }

    const tAnnotateStart = Date.now();
    await fontsReady;
    // 生成标注后的图片（使用canvas）
    const annotateResult = await annotateImage(
      originalImageBuffer,
      transposeResult,
      chordColor,
      fontSize,
      transposeResult.originalKey,
      transposeResult.targetKey
    );

    console.log(`⏱️ annotateImage 耗时: ${Date.now() - tAnnotateStart}ms`);

    const response = NextResponse.json({
      originalKey: transposeResult.originalKey,
      targetKey: transposeResult.targetKey,
      semitones: transposeResult.semitones,
      chordColor: chordColor,
      fontSize: annotateResult.fontSize, // 使用实际使用的fontSize
      chords: transposeResult.chords.map(item => ({
        original: item.original, // 保留完整的原始 chord 对象
        transposed: item.transposed, // 保留完整的转调后 chord 对象
        x: item.transposed.x,
        y: item.transposed.y,
      })),
      resultImage: annotateResult.resultImage, // 使用返回的resultImage
      recognition: recognitionResult,
    });
    console.log(`⏱️ /api/transpose total: ${Date.now() - totalStart}ms`);
    return response;
  } catch (error) {
    console.error('转调处理错误:', error);

    if (error instanceof ArkApiError) {
      // 429: model paused/limited by Safe Experience Mode or inference caps
      if (error.status === 429) {
        return NextResponse.json(
          {
            error: '模型调用被限制/暂停（429）。请在方舟控制台关闭 Safe Experience Mode 或调整模型推理额度后重试。',
            code: error.code,
            requestId: error.requestId,
          },
          { status: 429 }
        );
      }

      return NextResponse.json(
        {
          error: `模型调用失败（${error.status}）`,
          code: error.code,
          requestId: error.requestId,
        },
        { status: error.status }
      );
    }

    return NextResponse.json({ error: '处理失败' }, { status: 500 });
  }
}

/**
 * 根据中心点扩展边界框
 * @param cx 中心点 x 坐标（像素）
 * @param cy 中心点 y 坐标（像素）
 * @param chordText 和弦文本
 * @param imgWidth 图片宽度
 * @param imgHeight 图片高度
 */
function expandBBox(
  cx: number,
  cy: number,
  chordText: string,
  imgWidth: number,
  imgHeight: number
): { x1: number; y1: number; x2: number; y2: number } {
  // 根据图片大小动态调整字符尺寸
  const charWidth = Math.max(12, Math.floor(imgWidth / 80));   // 单字符平均宽度
  const charHeight = Math.max(16, Math.floor(imgHeight / 50));  // 字符高度
  const padding = Math.max(4, Math.floor(imgWidth / 200));     // 边距

  const textWidth = chordText.length * charWidth;

  return {
    x1: Math.max(0, Math.min(imgWidth, Math.round(cx - textWidth / 2 - padding))),
    y1: Math.max(0, Math.min(imgHeight, Math.round(cy - charHeight / 2 - padding))),
    x2: Math.max(0, Math.min(imgWidth, Math.round(cx + textWidth / 2 + padding))),
    y2: Math.max(0, Math.min(imgHeight, Math.round(cy + charHeight / 2 + padding))),
  };
}

function computeAiTargetDimensions(
  originalWidth: number,
  originalHeight: number
): { width: number; height: number; wasUpscaled: boolean } {
  const MIN_SIZE = 1000;

  const shouldUpscale = originalWidth < MIN_SIZE || originalHeight < MIN_SIZE;

  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (shouldUpscale && originalWidth < MIN_SIZE && originalHeight < MIN_SIZE) {
    if (originalWidth < originalHeight) {
      targetWidth = MIN_SIZE;
      targetHeight = Math.round((MIN_SIZE / originalWidth) * originalHeight);
    } else {
      targetHeight = MIN_SIZE;
      targetWidth = Math.round((MIN_SIZE / originalHeight) * originalWidth);
    }
  } else if (shouldUpscale && originalWidth < MIN_SIZE) {
    targetWidth = MIN_SIZE;
    targetHeight = Math.round((MIN_SIZE / originalWidth) * originalHeight);
  } else if (shouldUpscale) {
    targetHeight = MIN_SIZE;
    targetWidth = Math.round((MIN_SIZE / originalHeight) * originalWidth);
  }

  return { width: targetWidth, height: targetHeight, wasUpscaled: shouldUpscale };
}

/**
 * 智能放大低分辨率图片（使用 Canvas 替代 Sharp，减少冷启动时间）
 * 如果宽度或高度小于1000，等比例放大到至少1000
 * @param imageBuffer 原始图片buffer
 * @returns 处理后的图片buffer和尺寸信息
 */
async function upscaleImageIfNeeded(
  imageBuffer: Buffer,
  inputMimeType?: string
): Promise<{ buffer: Buffer; width: number; height: number; wasUpscaled: boolean; mimeType: 'image/jpeg' }> {
  // 使用 Canvas 加载图片获取尺寸
  const image = await loadImage(imageBuffer);
  const originalWidth = image.width || 800;
  const originalHeight = image.height || 1000;

  const MIN_SIZE = 1000;

  // 检查是否需要放大
  const shouldUpscale = originalWidth < MIN_SIZE || originalHeight < MIN_SIZE;

  // 如果输入本来就是 JPEG 且不需要放大，避免二次重编码导致体积变大/耗时变长
  const normalizedMime = (inputMimeType || '').toLowerCase();
  const isJpegInput = normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg';
  if (!shouldUpscale && isJpegInput) {
    return { buffer: imageBuffer, width: originalWidth, height: originalHeight, wasUpscaled: false, mimeType: 'image/jpeg' };
  }

  // 计算目标尺寸
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (shouldUpscale && originalWidth < MIN_SIZE && originalHeight < MIN_SIZE) {
    // 两个都小于1000，将较小的那个放大到1000
    if (originalWidth < originalHeight) {
      targetWidth = MIN_SIZE;
      targetHeight = Math.round((MIN_SIZE / originalWidth) * originalHeight);
    } else {
      targetHeight = MIN_SIZE;
      targetWidth = Math.round((MIN_SIZE / originalHeight) * originalWidth);
    }
  } else if (shouldUpscale && originalWidth < MIN_SIZE) {
    // 只有宽度小于1000，放大宽度到1000，高度等比例放大
    targetWidth = MIN_SIZE;
    targetHeight = Math.round((MIN_SIZE / originalWidth) * originalHeight);
  } else if (shouldUpscale) {
    // 只有高度小于1000，放大高度到1000，宽度等比例放大
    targetHeight = MIN_SIZE;
    targetWidth = Math.round((MIN_SIZE / originalHeight) * originalWidth);
  }

  if (shouldUpscale) {
    console.log(`🔧 图片放大: ${originalWidth}x${originalHeight} → ${targetWidth}x${targetHeight}`);
  }

  // 使用 Canvas 进行高质量缩放 / 重编码
  const canvas = createCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  
  // 启用图像平滑
  ctx.imageSmoothingEnabled = true;
  
  // 绘制缩放后的图片
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
  
  // 导出为 JPEG 格式（高质量）
  // 注意：非 JPEG 输入时重编码通常会显著减少 base64 体积（尤其是 PNG）
  const jpegBuffer = canvas.toBuffer('image/jpeg', { quality: shouldUpscale ? 0.95 : 0.92 });

  return {
    buffer: jpegBuffer,
    width: targetWidth,
    height: targetHeight,
    wasUpscaled: shouldUpscale,
    mimeType: 'image/jpeg',
  };
}



/**
 * 解析模型返回的 JSON 内容
 */
function parseModelResponse(content: string): { key: string | null; centers: ParsedModelCenter[] } {
  let jsonStr = content.trim();

  // 尝试从代码块中提取JSON
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    jsonStr = jsonMatch[1];
  }

  // 找到第一个 { 和对应的最后一个 }
  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('AI返回的内容中未找到JSON起始符号 {');
  }

  // 使用栈来找到匹配的最后一个 }
  let braceCount = 0;
  let lastBrace = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = firstBrace; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          lastBrace = i;
        }
      }
    }
  }

  if (lastBrace === -1) {
    throw new Error('AI返回的内容中未找到匹配的JSON结束符号 }');
  }

  jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);

  // 预修复：处理模型返回的格式问题
  const cxCyPattern = /"cx"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/g;
  jsonStr = jsonStr.replace(cxCyPattern, '"cx": $1, "cy": $2');
  
  const cyCxPattern = /"cy"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/g;
  jsonStr = jsonStr.replace(cyCxPattern, '"cy": $1, "cx": $2');

  // 尝试解析JSON
  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch (parseError) {
    // 尝试修复常见的JSON错误
    let fixedJson = jsonStr;

    fixedJson = fixedJson.replace(/,\s*}/g, '}');
    fixedJson = fixedJson.replace(/,\s*\]/g, ']');
    fixedJson = fixedJson.replace(/,\s*([}\]])/g, '$1');
    fixedJson = fixedJson.replace(/}\s*,\s*\]/g, '}]');
    fixedJson = fixedJson.replace(/\]\s*,\s*\]/g, ']]');
    
    // 修复模型返回的错误格式：[["D"], "F"], 788, 444] → [["D", "F"], 788, 444]
    // 模型错误地在第一个元素后多加了一个 ]，导致"或"和弦格式错误
    // 正确格式应该是 [["D", "F"], 788, 444] 表示该位置可能是 D 或 F
    fixedJson = fixedJson.replace(/\[\[\"([^\"]+)\"\]\s*,\s*\"([^\"]+)\"\]\s*,\s*(\d+)\s*,\s*(\d+)\s*\],?/g, '[[\"$1\", \"$2\"], $3, $4]');

    const firstBrace2 = fixedJson.indexOf('{');
    const lastBrace2 = fixedJson.lastIndexOf('}');
    const firstBracket = fixedJson.indexOf('[');
    const lastBracket = fixedJson.lastIndexOf(']');

    if (firstBrace2 !== -1 && lastBrace2 !== -1) {
      const jsonEnd = Math.max(lastBrace2, lastBracket);
      fixedJson = fixedJson.substring(firstBrace2, jsonEnd + 1);
    }

    fixedJson = fixedJson.replace(/,\s*\]/g, ']');
    fixedJson = fixedJson.replace(/,\s*}/g, '}');

    const openBrackets = (fixedJson.match(/\[/g) || []).length;
    const closeBrackets = (fixedJson.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      fixedJson += ']';
    }

    try {
      result = JSON.parse(fixedJson);
    } catch (fixError) {
      throw new Error(`JSON解析失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
  }

  const centers: ParsedModelCenter[] = (result?.centers || [])
    .map((center: any): ParsedModelCenter | null => {
      // New/legacy compact format: [textOrArr, cx, cy]
      if (Array.isArray(center) && center.length === 3) {
        const textOrArr = center[0];
        const rawChords = Array.isArray(textOrArr)
          ? textOrArr.map((c: any) => String(c).trim()).filter(Boolean)
          : String(textOrArr)
              .split('或')
              .map((s) => s.trim())
              .filter(Boolean);

        const cx = Number(center[1]);
        const cy = Number(center[2]);
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || rawChords.length === 0) return null;
        return { text: rawChords.join('或'), chords: rawChords, cx, cy };
      }

      // Object format: { text, chords?, cx, cy }
      if (center && typeof center === 'object') {
        const rawText = typeof center.text === 'string' ? center.text.trim() : '';
        const rawChords = Array.isArray(center.chords)
          ? center.chords.map((c: any) => String(c).trim()).filter(Boolean)
          : rawText
              .split('或')
              .map((s: string) => s.trim())
              .filter(Boolean);

        const cx = Number(center.cx);
        const cy = Number(center.cy);
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || rawChords.length === 0) return null;
        return { text: rawChords.join('或'), chords: rawChords, cx, cy };
      }

      return null;
    })
    .filter((c: ParsedModelCenter | null): c is ParsedModelCenter => c !== null);

  return {
    key: typeof result?.key === 'string' && result.key.trim() ? result.key.trim() : null,
    centers,
  };
}

// ========== 新的模型调用函数（替换原有的 callModelForRecognition） ==========
async function callModelForRecognition(
  messages: any[],
  modelName: string,
  enableThinking: boolean = false,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<{ key: string | null; centers: ChordCenter[]; modelUsed: string }> {
  const arkConfig = {
    apiKey: process.env.ARK_API_KEY || '',
    baseURL: process.env.ARK_BASE_URL,
  };

  if (!arkConfig.apiKey) {
    throw new Error('未配置 ARK_API_KEY 环境变量');
  }

  console.log(`🤖 调用方舟模型: ${modelName} (thinking: ${enableThinking ? 'enabled' : 'disabled'})`);
  const tStart = Date.now();
  
  // 调用之前写的 ark-client 函数
  let content: string;
  try {
    const detailed = await callArkChatDetailed(messages, modelName, arkConfig, {
      temperature: 0.1,
      maxTokens: 4096,
      thinking: enableThinking,
      timeoutMs,
      signal,
    });
    content = detailed.content;

    if (detailed.usage) {
      console.log(
        `📊 usage: prompt=${detailed.usage.prompt_tokens}, completion=${detailed.usage.completion_tokens}, total=${detailed.usage.total_tokens}, serviceTier=${detailed.serviceTier ?? 'unknown'}`
      );
    }

    if (detailed.reasoningContent) {
      const r = String(detailed.reasoningContent);
      const rBytes = Buffer.byteLength(r, 'utf8');
      const rDigest = createHash('sha256').update(r).digest('hex').slice(0, 16);
      console.log(`🧠 reasoning_content: len=${r.length} chars, bytes=${rBytes}, sha256=${rDigest}`);
    }

    // 可选：输出模型原始返回文本（用于排查 JSON 解析、token 波动、混入解释性文字等问题）
    // 默认关闭，避免日志过大；可通过 .env.local 开启：
    // - ARK_LOG_MODEL_RESPONSE=true            打印截断内容
    // - ARK_LOG_MODEL_RESPONSE=full            打印完整内容（谨慎）
    // - ARK_LOG_MODEL_RESPONSE_MAX_CHARS=8000  截断长度（默认 4000）
    const logModeRaw = (process.env.ARK_LOG_MODEL_RESPONSE ?? 'false').toLowerCase();
    const shouldLogRaw = logModeRaw === 'true' || logModeRaw === '1' || logModeRaw === 'yes' || logModeRaw === 'full';
    if (shouldLogRaw) {
      const maxChars = Number.parseInt(process.env.ARK_LOG_MODEL_RESPONSE_MAX_CHARS ?? '4000', 10);
      const isFull = logModeRaw === 'full';
      const safeMax = Number.isFinite(maxChars) ? Math.max(200, Math.min(50000, maxChars)) : 4000;
      const text = String(content ?? '');
      const truncated = !isFull && text.length > safeMax;
      const preview = truncated ? `${text.slice(0, safeMax)}\n...[TRUNCATED ${text.length - safeMax} chars]` : text;

      const byteLen = Buffer.byteLength(text, 'utf8');
      const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
      console.log(
        `\n🧾 模型原始返回(${modelName}) len=${text.length} chars, bytes=${byteLen}, sha256=${digest}${truncated ? ` (truncated to ${safeMax} chars)` : ''}:\n${preview}\n`
      );

      // 可选：打印 reasoning_content（通常非常长，默认不打印）
      const logReasoning = (process.env.ARK_LOG_MODEL_REASONING ?? 'false').toLowerCase() === 'true';
      if (logReasoning && detailed.reasoningContent) {
        const rr = String(detailed.reasoningContent);
        const rrBytes = Buffer.byteLength(rr, 'utf8');
        const rrDigest = createHash('sha256').update(rr).digest('hex').slice(0, 16);
        const rrMaxChars = Number.parseInt(process.env.ARK_LOG_MODEL_REASONING_MAX_CHARS ?? '4000', 10);
        const rrSafeMax = Number.isFinite(rrMaxChars) ? Math.max(200, Math.min(50000, rrMaxChars)) : 4000;
        const rrTruncated = rr.length > rrSafeMax;
        const rrPreview = rrTruncated ? `${rr.slice(0, rrSafeMax)}\n...[TRUNCATED ${rr.length - rrSafeMax} chars]` : rr;
        console.log(`\n🧠 reasoning_content(${modelName}) len=${rr.length} chars, bytes=${rrBytes}, sha256=${rrDigest}${rrTruncated ? ` (truncated to ${rrSafeMax} chars)` : ''}:\n${rrPreview}\n`);
      }
    }
  } catch (err: any) {
    // 429 SetLimitExceeded: this model is paused/limited by Safe Experience Mode.
    // Let upper layers decide whether to fallback.
    if (err?.name === 'AbortError') {
      const elapsed = Date.now() - tStart;
      const wasExternallyAborted = signal?.aborted === true;
      const rawReason = wasExternallyAborted ? (signal as any)?.reason : undefined;
      const reasonText =
        rawReason == null
          ? null
          : typeof rawReason === 'string'
            ? rawReason
            : (rawReason as any)?.message
              ? String((rawReason as any).message)
              : (() => {
                  try {
                    return JSON.stringify(rawReason);
                  } catch {
                    return String(rawReason);
                  }
                })();

      if (wasExternallyAborted) {
        if (reasonText && reasonText.startsWith('VISION_ASSIST_POST_LITE_WINDOW_EXCEEDED')) {
          console.log(`⏹️ 模型调用被主动取消(补查窗口到期): ${modelName} (${elapsed}ms, reason=${reasonText})`);
        } else {
          console.log(`⏹️ 模型调用被主动取消: ${modelName} (${elapsed}ms${reasonText ? `, reason=${reasonText}` : ''})`);
        }
      } else {
        console.warn(`⏱️ 模型调用超时: ${modelName} (${elapsed}ms, timeoutMs=${timeoutMs ?? 'none'})`);
      }
    } else if (err instanceof ArkApiError) {
      console.warn(`⚠️ 方舟模型调用失败: ${modelName} (status=${err.status}, code=${err.code ?? 'unknown'})`);
    }
    throw err;
  }
  
  console.log(`✅ 模型调用成功: ${modelName} (${Date.now() - tStart}ms)`);
  
  // 解析返回的 JSON
  const parsed = parseModelResponse(content);
  
  // 转换为原有的 ChordCenter 格式：[[文本数组], cx, cy]
  const centers: ChordCenter[] = parsed.centers.map((c) => [c.chords, c.cx, c.cy]);
  
  return {
    key: parsed.key,
    centers,
    modelUsed: modelName,
  };
}

// ========== 新的 recognizeChordsFromImage 函数 ==========
/**
 * 调用多模态模型识别图片中的和弦和调号（支持智能模型切换）
 */
async function recognizeChordsFromImage(
  imageBase64: string, 
  mimeType: string, 
  imgWidth: number, 
  imgHeight: number,
  modelMode?: string  // 模型模式：'fast' | 'accurate'
): Promise<any> {
  try {
    const isFastMode = modelMode === 'fast';
    const imageDetail: 'high' = 'high';
    
    console.log('='.repeat(60));
    console.log(`🎯 和弦识别任务启动 (${isFastMode ? '快速模式' : '精准模式'})`);
    console.log(`📐 图片尺寸: ${imgWidth} x ${imgHeight}`);
    console.log('='.repeat(60));

    // 构造优化的提示词（与原来完全相同）
    const systemPrompt = `你是一个专业的简谱和弦 OCR 定位系统。你的任务是从一张简谱图片中识别调号，并定位所有和弦标记的精确像素位置。

【图片尺寸】
- 图片宽度：${imgWidth} 像素
- 图片高度：${imgHeight} 像素
- 图片左上角坐标为 (0, 0)
- 图片右下角坐标为 (${imgWidth}, ${imgHeight})

【唯一允许的坐标系统】
- 坐标必须是"绝对像素坐标"
- x 轴范围：0 ≤ x ≤ ${imgWidth}
- y 轴范围：0 ≤ y ≤ ${imgHeight}

【识别任务】

1. 调号识别：
- 查找图片左上角的调号标记，如："1=C"、"1=G"、"1=bB"、"1=#F"等
- 必须识别升降号（#或b），返回完整的调号
- 示例：
  - "1=C" → 返回 "C"
  - "1=G" → 返回 "G"
  - "1=Bb" 或 "1=bB" → 返回 "Bb"（降号必须保留）
  - "1=F#" 或 "1=#F" → 返回 "F#"（升号必须保留）
- 如果图片中没有调号标记，返回 null

2. 和弦坐标识别：
- 识别图片中所有和弦标记（例如：C, Am, G7, F#m, Asus4, D/F# 等）
- 和弦通常位于音符或小节线上方，也常标注在：反复段落（1.2.3房子）的起始框内部或角落，这些位置的和弦必须检查，不能遗漏
- 注意：升降号（#、b）可能以三种形式出现：
  1. 普通形式：F#、Bb、G#m
  2. 上标形式（浮在上半空间）
  3. 前置形式：#F、bE（识别后请转换为标准形式 F#、Eb）
- 无论升降号以何种形式出现，都应识别并返回标准格式（如 F# 而非 #F）
- 终止标记和重复记号：
  - Fine.、D.S.、D.S.al.Fine.、D.C.、D.C.al.Fine.、Segno、Coda、To Coda 等是终止/重复记号
  - 这些记号单独出现时不要识别为和弦
  - 如果看到"CD.S.al.Fine."，只识别"C"和弦，忽略后面的"D.S.al.Fine."
  - 如果看到"D7Fine."，只识别"D7"和弦，忽略后面的"Fine."
- "或"字连接的和弦：
  - 只有当图片中明确出现中文"或"字连接两个和弦时（如"C或C/E"），才将两个和弦放在同一个数组：[["C", "C/E"], cx, cy]
  - 请检查图中两个和弦之间是否有"或"字，若没有"或"字连接，即使两个和弦距离非常近，也必须拆分成两个独立的和弦条目，不能合并为或字和弦数组
- 忽略歌词、简谱数字（1–7）、拍号（4/4 等）、速度标记
- 忽略调号标记（如"1=G"）和转调标记（如"转1=A"），不要识别为和弦

【坐标定位规则】
- 返回每个和弦文字的视觉中心点坐标（cx, cy）
- 对于含"或"字的和弦，返回整个"或"字组合的中心点

【分布校验规则】
- 图片下半部分存在的和弦必须返回
- 图片底部区域出现的和弦必须返回

【返回格式】
{
  "key": "G",
  "centers": [
    [["(G"], 82, 138],
    [["C/G)"], 178, 138],
    [["C", "C/E"], 800, 880]
  ]
}

格式说明：
- key: 调号，如"G"、"C"、"Bb"、"F#"，无调号返回null
- centers: 和弦数组，每个元素格式为 [chords数组, cx, cy]
  - 单和弦：["G"]、["Am"]、["C/G"]
  - 或字和弦（如"C或C/E"）：["C", "C/E"]

不要输出解释性文字，不要使用Markdown，按从左到右、从上到下的顺序返回`;

    const userPrompt = '请分析这张简谱图片，识别调号和所有和弦标记（升降号统一放在大写字母后，如Bb、F#），以及它们的坐标，以JSON格式返回，不要遗漏和弦';

    // 构造消息（多模态）
    const messages = [
      {
        role: 'system' as const,
        content: systemPrompt,
      },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: userPrompt },
          {
            type: 'image_url' as const,
            image_url: {
              url: imageBase64,
              detail: imageDetail,
            },
          },
        ],
      },
    ];

    // 模型常量（从环境变量读取）
    const MODEL_LITE = process.env.VISION_MODEL_LITE || 'doubao-seed-2-0-lite-260215';
    const MODEL_VISION = process.env.VISION_MODEL_VISION || 'doubao-seed-1-6-vision-250815';

    let result: { key: string | null; centers: any[]; _modelUsed?: string };

    if (isFastMode) {
      // 快速模式：Lite 为主体 + Vision 辅助检查遗漏
      console.log('🚀 快速模式：Lite 为主体 + Vision 辅助检查遗漏');
      console.log(`   Lite 模型: ${MODEL_LITE} (thinking: disabled) - 主体`);
      console.log(`   Vision 模型: ${MODEL_VISION} (thinking: disabled) - 辅助`);

      const visionAssistEnabled = (process.env.VISION_ASSIST_ENABLED ?? 'true').toLowerCase() !== 'false';
      const visionAssistTimeoutMs = Number.parseInt(process.env.VISION_ASSIST_TIMEOUT_MS ?? '45000', 10);
      const visionAssistStrategy = (process.env.VISION_ASSIST_STRATEGY ?? 'window').toLowerCase();

      const waitAtMost = async <T,>(promise: Promise<T>, ms: number): Promise<T | null> => {
        if (!Number.isFinite(ms) || ms <= 0) return null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        try {
          return await Promise.race([
            promise,
            new Promise<null>((resolve) => {
              timeoutId = setTimeout(() => resolve(null), ms);
            }),
          ]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      };

      try {
        const tModelStart = Date.now();

        const litePromise = callModelForRecognition(messages, MODEL_LITE, false)
          .catch(async (err) => {
            // Lite 被 Safe Experience Mode/推理额度限制暂停时，自动切换到备用模型（通常是 Vision）
            if (err instanceof ArkApiError && err.status === 429 && (err.code === 'SetLimitExceeded' || err.type === 'TooManyRequests')) {
              const fallback = selectFallbackModel(MODEL_LITE);
              console.warn(`⚠️ Lite 模型不可用(429 ${err.code ?? ''})，切换备用模型: ${fallback}`);
              return await callModelForRecognition(messages, fallback, false);
            }
            throw err;
          });

        let visionAbortController: AbortController | null = null;
        let visionPromise: Promise<{ key: string | null; centers: ChordCenter[]; modelUsed: string } | null> | null = null;
        let visionAbortReason: string | null = null;

        if (visionAssistEnabled) {
          visionAbortController = new AbortController();
          const timeout = Number.isFinite(visionAssistTimeoutMs) ? visionAssistTimeoutMs : undefined;
          // Vision 作为“辅助检查”，失败/超时不应影响 Lite 主路径
          visionPromise = callModelForRecognition(messages, MODEL_VISION, false, timeout, visionAbortController.signal)
            .then((r) => r)
            .catch((err) => {
              if (err?.name === 'AbortError') {
                if (visionAbortReason && visionAbortReason.startsWith('VISION_ASSIST_POST_LITE_WINDOW_EXCEEDED')) {
                  console.log(`ℹ️ Vision 在补查窗口结束后被主动取消，将忽略 Vision 结果 (${visionAbortReason})`);
                } else {
                  console.log('ℹ️ Vision 被取消，将忽略 Vision 结果:', err);
                }
              } else {
                console.warn('⚠️ Vision 辅助失败/超时，将忽略 Vision 结果:', err);
              }
              return null;
            });
        }

        const liteResult = await litePromise;

        let visionResult: { key: string | null; centers: ChordCenter[]; modelUsed: string } | null = null;
        if (visionPromise && visionAbortController) {
          if (visionAssistStrategy === 'full') {
            // 尽可能保留“合并结果”的原逻辑：等待 Vision 直到成功/失败/超时
            console.log('⏳ Vision assist strategy=full：等待 Vision 完成（最多到 VISION_ASSIST_TIMEOUT_MS）');
            visionResult = await visionPromise;
            if (!visionResult) {
              try {
                visionAbortReason = 'VISION_ASSIST_FULL_STRATEGY_CLEANUP';
                visionAbortController.abort(visionAbortReason as any);
              } catch {
                // ignore
              }
            }
          } else {
            // 默认策略：Lite 已完成后，只给 Vision 一个很短的补查窗口，避免 fast 被 Vision 拖住
            const elapsedSinceStart = Date.now() - tModelStart;
            const remainingBudget = Number.isFinite(visionAssistTimeoutMs)
              ? Math.max(0, visionAssistTimeoutMs - elapsedSinceStart)
              : 0;
            const configuredPostLiteWaitMs = Number.parseInt(process.env.VISION_ASSIST_POST_LITE_WAIT_MS ?? '2000', 10);
            const postLiteWaitCap = Number.isFinite(configuredPostLiteWaitMs)
              ? Math.min(8000, Math.max(0, configuredPostLiteWaitMs))
              : 2000;
            const postLiteWaitMs = Math.min(remainingBudget, postLiteWaitCap);

            if (postLiteWaitMs > 0) {
              console.log(`⏳ Lite 已完成，等待 Vision 补查窗口: ${postLiteWaitMs}ms (剩余预算: ${remainingBudget}ms)`);
              visionResult = await waitAtMost(visionPromise, postLiteWaitMs);
            }

            if (!visionResult) {
              try {
                visionAbortReason = `VISION_ASSIST_POST_LITE_WINDOW_EXCEEDED:${postLiteWaitMs}`;
                visionAbortController.abort(visionAbortReason as any);
              } catch {
                // ignore
              }
            }
          }
        }

        console.log(`⏱️ 模型调用耗时(快速模式): ${Date.now() - tModelStart}ms (detail=${imageDetail})`);

        if (visionResult) {
          // 日志：两个模型返回的原始结果
          console.log(`\n${'='.repeat(60)}`);
          console.log(`📊 【并行调用完成】`);
          console.log(`${'='.repeat(60)}`);
          console.log(`\n📋 Lite 模型 (${liteResult.modelUsed}) 返回 (主体，权重4):`);
          console.log(`   调号: ${liteResult.key || '未知'}`);
          console.log(`   和弦数: ${liteResult.centers.length}`);
          if (liteResult.centers.length > 0) {
            console.log(`   和弦详情 (文本, x, y):`);
            liteResult.centers.forEach((c, i) => {
              console.log(`     [${i}] "${c[0].join('或')}" (${c[1]}, ${c[2]})`);
            });
          }

          console.log(`\n📋 Vision 模型 (${visionResult.modelUsed}) 返回 (辅助，权重1):`);
          console.log(`   调号: ${visionResult.key || '未知'}`);
          console.log(`   和弦数: ${visionResult.centers.length}`);
          if (visionResult.centers.length > 0) {
            console.log(`   和弦详情 (文本, x, y):`);
            visionResult.centers.forEach((c, i) => {
              console.log(`     [${i}] "${c[0].join('或')}" (${c[1]}, ${c[2]})`);
            });
          }

          // 确定原调（优先使用识别出的原调，否则使用默认值）
          const detectedKey = liteResult.key || visionResult.key || 'C';
          console.log(`\n🎼 识别原调: ${detectedKey}`);

          // 在合并前对两个模型的结果分别进行修正（保留原有函数）
          console.log(`\n🔧 【合并前修正】`);
          const correctedLiteResult = correctModelResult(liteResult, detectedKey, true);
          const correctedVisionResult = correctModelResult(visionResult, detectedKey, true);

          // 合并结果：以 Lite 为主体，Vision 辅助检查遗漏
          const mergedResult = mergeResults(correctedLiteResult, correctedVisionResult, imgWidth, imgHeight, 4);

          result = {
            key: mergedResult.key,
            centers: mergedResult.centers.map((c, i) => ({
              text: c[0].join('或'),
              chords: c[0],
              cx: c[1],
              cy: c[2]
            })),
            _modelUsed: `${liteResult.modelUsed}+${visionResult.modelUsed}`
          };

          console.log(`\n✅ 最终结果 (快速模式): ${result.centers.length}个和弦, 调号: ${result.key || '未知'}`);
        } else {
          console.log('⚠️ Vision 未在补查窗口内返回，使用 Lite 结果（不再重跑 Lite）');

          const detectedKey = liteResult.key || 'C';
          console.log(`\n🎼 识别原调: ${detectedKey}`);
          console.log(`\n🔧 【修正结果】`);
          const correctedLiteResult = correctModelResult(liteResult, detectedKey, true);

          result = {
            key: correctedLiteResult.key,
            centers: correctedLiteResult.centers.map((c, i) => ({
              text: c[0].join('或'),
              chords: c[0],
              cx: c[1],
              cy: c[2]
            })),
            _modelUsed: correctedLiteResult.modelUsed
          };
        }
      } catch (error) {
        // Lite 主路径失败才算失败
        console.error('❌ 快速模式识别失败(Lite 主路径):', error);
        throw error;
      }
    } else {
      // 精准模式：只用 Lite(thinking)，深度思考精度高
      console.log('🎯 精准模式：Lite(thinking) 深度思考');
      console.log(`   Lite 模型: ${MODEL_LITE} (thinking: enabled)`);
      
      try {
        const tModelStart = Date.now();
        const liteResult = await callModelForRecognition(messages, MODEL_LITE, true);

        console.log(`⏱️ 模型调用耗时(精准模式): ${Date.now() - tModelStart}ms (detail=${imageDetail})`);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 【Lite(thinking) 模型返回】`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   调号: ${liteResult.key || '未知'}`);
        console.log(`   和弦数: ${liteResult.centers.length}`);
        if (liteResult.centers.length > 0) {
          console.log(`   和弦详情 (文本, x, y):`);
          liteResult.centers.forEach((c, i) => {
            console.log(`     [${i}] "${c[0].join('或')}" (${c[1]}, ${c[2]})`);
          });
        }

        const detectedKey = liteResult.key || 'C';
        console.log(`\n🎼 识别原调: ${detectedKey}`);

        // 对结果进行修正（精准模式不应用快速模式专用修正）
        console.log(`\n🔧 【修正结果】`);
        const correctedLiteResult = correctModelResult(liteResult, detectedKey, false);

        result = {
          key: correctedLiteResult.key,
          centers: correctedLiteResult.centers.map((c, i) => ({
            text: c[0].join('或'),
            chords: c[0],
            cx: c[1],
            cy: c[2]
          })),
          _modelUsed: correctedLiteResult.modelUsed
        };
        
        console.log(`\n✅ 最终结果 (精准模式): ${result.centers.length}个和弦, 调号: ${result.key || '未知'}`);
      } catch (error) {
        console.error('❌ Lite(thinking) 调用失败:', error);
        throw error;
      }
    }

    return result;
  } catch (error) {
    console.error('和弦识别失败:', error);
    throw error;
  }
}


/**
 * 将十六进制颜色转换为RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * 将RGB转换为十六进制颜色
 */
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}


/**
 * 调亮颜色
 * @param hexColor 十六进制颜色
 * @param factor 调亮因子（0-1），越大越亮
 */
function lightenColor(hexColor: string, factor: number = 0.4): string {
  const rgb = hexToRgb(hexColor);
  if (!rgb) return hexColor;

  // 混合白色来调亮
  const r = rgb.r + (255 - rgb.r) * factor;
  const g = rgb.g + (255 - rgb.g) * factor;
  const b = rgb.b + (255 - rgb.b) * factor;

  return rgbToHex(r, g, b);
}

/**
 * 检测两个矩形是否重叠
 */
function rectanglesOverlap(
  x1: number, y1: number, w1: number, h1: number,
  x2: number, y2: number, w2: number, h2: number
): boolean {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}

/**
 * 计算和弦信息和重叠统计
 * @param image 图片对象
 * @param transposeResult 转调结果
 * @param ctx Canvas上下文
 * @param fontSize 字体大小
 * @param chordTransposer 和弦转调器
 * @param shouldUseFlats 是否使用降号形式
 * @param flatKeys 降号调列表
 * @returns 返回和弦信息和重叠和弦数
 */
function calculateChordInfos(
  image: any,
  transposeResult: any,
  ctx: any,
  fontSize: number,
  chordTransposer: any,
  shouldUseFlats: boolean,
  flatKeys: string[]
): { chordDrawInfos: any[], overlappingChordCount: number, overlappingGroupCount: number } {
  type ChordDrawInfo = {
    chordText: string;      // 和弦文本
    x: number;              // 和弦中心x坐标
    y: number;              // 和弦中心y坐标
    rectX: number;          // 实际绘制矩形的左上角x
    rectY: number;          // 实际绘制矩形的左上角y
    rectWidth: number;      // 实际绘制矩形宽度
    rectHeight: number;     // 实际绘制矩形高度
    overlapRectX: number;   // 重叠检测矩形的左上角x（较小padding）
    overlapRectY: number;   // 重叠检测矩形的左上角y（较小padding）
    overlapRectWidth: number; // 重叠检测矩形宽度（较小padding）
    overlapRectHeight: number; // 重叠检测矩形高度（较小padding）
    color: string;          // 最终颜色（可能是原色或调淡色）
    needsChineseFont: boolean; // 是否需要使用中文字体（包含"或"字）
  };

  const chordDrawInfos: ChordDrawInfo[] = [];

  for (let i = 0; i < transposeResult.chords.length; i++) {
    const item = transposeResult.chords[i];
    // 兼容两种数据格式：
    // 1. { transposed: {...}, x, y } - 来自其他 API
    // 2. { root, quality, bass, x, y, ... } - 来自 render API
    const chord = item.transposed || item;

    // 检查坐标是否有效
    if (typeof chord.x !== 'number' || typeof chord.y !== 'number' || isNaN(chord.x) || isNaN(chord.y)) {
      continue;
    }

    if (chord.x < 0 || chord.x > 100 || chord.y < 0 || chord.y > 100) {
      continue;
    }

    // 转换百分比坐标为实际像素坐标
    const x = Math.round((chord.x / 100) * image.width);
    const y = Math.round((chord.y / 100) * image.height);

    // 计算和弦文本
    let chordText: string;
    
    if ((chord as any).chords && Array.isArray((chord as any).chords)) {
      // 带"或"字的和弦：处理多个和弦
      const subChords = (chord as any).chords;
      chordText = subChords.map((subChord: Chord) =>
        chordTransposer.chordToStringWithBassMode(subChord, shouldUseFlats, flatKeys.includes(subChord.root))
      ).join('或');
    } else {
      // 单个和弦：直接使用 chord 对象
      chordText = chordTransposer.chordToStringWithBassMode(chord, shouldUseFlats, flatKeys.includes(chord.root));
    }

    // 检测是否需要使用中文字体（包含"或"字）
    const needsChineseFont = chordText.includes('或');

    // 测量文本宽度（分段测量：和弦用 Georgia，"或"字用 OrFont）
    let textWidth: number;
    if (needsChineseFont) {
      // 分段测量
      const parts = chordText.split('或');
      ctx.font = `normal ${fontSize}px ${CHORD_FONT_FAMILY}`;
      let totalWidth = 0;
      for (let i = 0; i < parts.length; i++) {
        totalWidth += ctx.measureText(parts[i]).width;
        if (i < parts.length - 1) {
          // "或"字的宽度
          ctx.font = `normal ${fontSize}px "OrFont", serif`;
          totalWidth += ctx.measureText('或').width;
          ctx.font = `normal ${fontSize}px ${CHORD_FONT_FAMILY}`;
        }
      }
      textWidth = totalWidth;
    } else {
      ctx.font = `normal ${fontSize}px ${CHORD_FONT_FAMILY}`;
      textWidth = ctx.measureText(chordText).width;
    }
    // 文本高度估算（用于背景框/重叠检测）
    const textHeight = fontSize * 1.1;

    // 计算实际绘制矩形（分别设置横向和纵向padding）
    // 左侧padding较小，避免遮挡左侧内容；右侧padding较大，覆盖升降号后缀
    const horizontalPaddingLeft = fontSize * 0.15;  // 左侧padding（减小）
    const horizontalPaddingRight = fontSize * 0.68; // 右侧padding（保持不变）
    const verticalPadding = fontSize * 0.5;   // 纵向padding
    const rectWidth = Math.round(textWidth + horizontalPaddingLeft + horizontalPaddingRight);
    const rectHeight = Math.round(textHeight + verticalPadding * 0.4); // 纵向padding减小，避免遮盖上一行歌词
    // 计算rectX，使文本中心仍在x坐标，背景框左侧padding=horizontalPaddingLeft
    // 文本左边界 = x - textWidth/2，矩形左边界 = 文本左边界 - horizontalPaddingLeft
    const rectX = Math.round(x - textWidth / 2 - horizontalPaddingLeft);
    const rectY = y - rectHeight / 2;

    // 计算重叠检测矩形（小padding，避免过度检测重叠）
    const overlapPadding = fontSize * 0.05; // 小padding，重叠检测用（横向 0.05，纵向 0.035）
    const overlapRectWidth = Math.round(textWidth + overlapPadding * 2);
    const overlapRectHeight = Math.round(textHeight + overlapPadding * 0.7);
    const overlapRectX = x - overlapRectWidth / 2;
    const overlapRectY = y - overlapRectHeight / 2;

    chordDrawInfos.push({
      chordText,
      x,
      y,
      rectX,
      rectY,
      rectWidth,
      rectHeight,
      overlapRectX,
      overlapRectY,
      overlapRectWidth,
      overlapRectHeight,
      color: '', // 将在后续步骤中设置
      needsChineseFont,
    });
  }

  // 统计重叠的组合数和和弦数
  // 使用连通分量算法找出所有重叠组
  const overlappingChordIndices = new Set<number>();
  const adjacency: number[][] = Array.from({ length: chordDrawInfos.length }, () => []);
  
  for (let i = 0; i < chordDrawInfos.length; i++) {
    for (let j = i + 1; j < chordDrawInfos.length; j++) {
      const a = chordDrawInfos[i];
      const b = chordDrawInfos[j];
      if (rectanglesOverlap(
        a.overlapRectX, a.overlapRectY, a.overlapRectWidth, a.overlapRectHeight,
        b.overlapRectX, b.overlapRectY, b.overlapRectWidth, b.overlapRectHeight
      )) {
        overlappingChordIndices.add(i);
        overlappingChordIndices.add(j);
        adjacency[i].push(j);
        adjacency[j].push(i);
      }
    }
  }

  // 找出所有连通分量（重叠组合）
  const visited = new Set<number>();
  let overlappingGroupCount = 0;
  
  for (const idx of overlappingChordIndices) {
    if (visited.has(idx)) continue;
    
    // BFS 找出当前连通分量的所有节点
    const queue: number[] = [idx];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      
      for (const neighbor of adjacency[current]) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }
    overlappingGroupCount++;
  }

  return {
    chordDrawInfos,
    overlappingChordCount: overlappingChordIndices.size,
    overlappingGroupCount
  };
}

/**
 * 在原图上标注转调后的和弦
 * @param imageBuffer 图片缓冲区
 * @param transposeResult 转调结果
 * @param chordColor 和弦颜色
 * @param customFontSize 自定义字体大小（可选，如果不提供则自动计算）
 * @returns 包含图片base64和实际使用的fontSize
 */
async function annotateImage(
  imageBuffer: Buffer,
  transposeResult: any,
  chordColor: string = '#2563EB',
  customFontSize?: number | null,
  originalKey: string = '',
  targetKey: string = ''
): Promise<{ resultImage: string; fontSize: number }> {
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas/node-canvas');

    // 根据目标调决定是否使用降号形式
    // 降号调：C, F, Bb, Eb, Ab, Db, Gb
    // 注意：Cb不是降号调，它是B调的等音调（Cb = B），B是升号调（5#）
    const flatKeys = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const shouldUseFlats = flatKeys.includes(targetKey);

    // 加载原图
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');

    // 绘制原图
    ctx.drawImage(image, 0, 0);

    // 计算字体大小：如果提供了自定义值则使用，否则动态计算
    const fontSize = customFontSize || Math.max(16, Math.round(image.width / 38));

    // 第一步：遍历所有和弦，计算并存储背景框和文本信息
    type ChordDrawInfo = {
      chordText: string;
      x: number;
      y: number;
      rectX: number;
      rectY: number;
      rectWidth: number;
      rectHeight: number;
      overlapRectX: number;
      overlapRectY: number;
      overlapRectWidth: number;
      overlapRectHeight: number;
      color: string;
      needsChineseFont: boolean;
    };

    // 字体自动调整循环逻辑
    let currentFontSize = fontSize;
    let chordDrawInfoResult = calculateChordInfos(image, transposeResult, ctx, currentFontSize, chordTransposer, shouldUseFlats, flatKeys);

    let adjustmentCount = 0;
    const maxAdjustmentCount = 3;

    while ((customFontSize === undefined || customFontSize === null) && adjustmentCount < maxAdjustmentCount) {
      // 字体调整规则：
      // - 如果重叠组合数 > 2：调小字体
      // - 如果重叠组合数 <= 2 且 重叠和弦数 > 7：调小字体
      // - 其他情况（组合数 <= 2 且 和弦数 <= 7）：不用调小字体
      const { overlappingGroupCount, overlappingChordCount } = chordDrawInfoResult;
      
      if (currentFontSize <= 12) break;
      
      // 不需要调小字体的条件：组合数 <= 2 且 和弦数 <= 5
      if (overlappingGroupCount <= 2 && overlappingChordCount <= 5) break;
      
      currentFontSize -= 4;
      adjustmentCount++;
      console.log(`  📐 字体调整 #${adjustmentCount}: ${currentFontSize + 4}px → ${currentFontSize}px (组合数=${overlappingGroupCount}, 和弦数=${overlappingChordCount})`);
      chordDrawInfoResult = calculateChordInfos(image, transposeResult, ctx, currentFontSize, chordTransposer, shouldUseFlats, flatKeys);
    }

    // 二阶段微调：当仍有双重叠或三重叠时，进行位置微调
    // 只处理双重叠和三重叠，四个及以上不处理
    {
      const infos = chordDrawInfoResult.chordDrawInfos;
      
      // 构建邻接表找出重叠组
      const adjacency: number[][] = Array.from({ length: infos.length }, () => []);
      for (let i = 0; i < infos.length; i++) {
        for (let j = i + 1; j < infos.length; j++) {
          const a = infos[i];
          const b = infos[j];
          if (rectanglesOverlap(
            a.overlapRectX, a.overlapRectY, a.overlapRectWidth, a.overlapRectHeight,
            b.overlapRectX, b.overlapRectY, b.overlapRectWidth, b.overlapRectHeight
          )) {
            adjacency[i].push(j);
            adjacency[j].push(i);
          }
        }
      }

      // 找出所有连通分量，筛选出双重叠和三重叠
      const visited = new Set<number>();
      const components: number[][] = [];

      for (let start = 0; start < infos.length; start++) {
        if (visited.has(start)) continue;
        
        const component: number[] = [];
        const queue: number[] = [start];
        visited.add(start);

        while (queue.length > 0) {
          const u = queue.shift()!;
          component.push(u);
          for (const v of adjacency[u]) {
            if (!visited.has(v)) {
              visited.add(v);
              queue.push(v);
            }
          }
        }

        if (component.length >= 2 && component.length <= 3) {
          components.push(component);
        }
      }

      // 只有存在双重叠或三重叠时才执行微调
      if (components.length > 0) {
      
      // 构建邻接表找出重叠组
      const adjacency: number[][] = Array.from({ length: infos.length }, () => []);
      for (let i = 0; i < infos.length; i++) {
        for (let j = i + 1; j < infos.length; j++) {
          const a = infos[i];
          const b = infos[j];
          if (rectanglesOverlap(
            a.overlapRectX, a.overlapRectY, a.overlapRectWidth, a.overlapRectHeight,
            b.overlapRectX, b.overlapRectY, b.overlapRectWidth, b.overlapRectHeight
          )) {
            adjacency[i].push(j);
            adjacency[j].push(i);
          }
        }
      }

      // 找出所有连通分量
      const visited = new Set<number>();
      const components: number[][] = [];

      for (let start = 0; start < infos.length; start++) {
        if (visited.has(start)) continue;
        
        const component: number[] = [];
        const queue: number[] = [start];
        visited.add(start);

        while (queue.length > 0) {
          const u = queue.shift()!;
          component.push(u);
          for (const v of adjacency[u]) {
            if (!visited.has(v)) {
              visited.add(v);
              queue.push(v);
            }
          }
        }

        if (component.length >= 2) {
          components.push(component);
        }
      }

      // 辅助函数：检测两个和弦是否重叠
      const checkOverlap = (idx1: number, idx2: number): boolean => {
        const a = infos[idx1];
        const b = infos[idx2];
        return rectanglesOverlap(
          a.overlapRectX, a.overlapRectY, a.overlapRectWidth, a.overlapRectHeight,
          b.overlapRectX, b.overlapRectY, b.overlapRectWidth, b.overlapRectHeight
        );
      };

      // 辅助函数：更新和弦的 x 坐标及相关矩形坐标
      const updateChordX = (idx: number, deltaX: number) => {
        const info = infos[idx];
        info.x += deltaX;
        info.rectX += deltaX;
        info.overlapRectX += deltaX;
      };

      // 辅助函数：检测是否与指定一侧的和弦产生新重叠
      const checkNewOverlap = (idx: number, direction: 'left' | 'right', allIndices: number[]): boolean => {
        const info = infos[idx];
        for (const otherIdx of allIndices) {
          if (otherIdx === idx) continue;
          const other = infos[otherIdx];
          // 只检测指定方向
          if (direction === 'left' && other.x < info.x) {
            if (checkOverlap(idx, otherIdx)) return true;
          } else if (direction === 'right' && other.x > info.x) {
            if (checkOverlap(idx, otherIdx)) return true;
          }
        }
        return false;
      };

      // 对每个连通分量进行微调（只处理双重叠和三重叠）
      for (const component of components) {
        if (component.length < 2 || component.length > 3) continue;

        // 按 x 坐标排序
        component.sort((a, b) => infos[a].x - infos[b].x);

        if (component.length === 2) {
          // 双重叠处理
          const [leftIdx, rightIdx] = component;
          const allOtherIndices = infos.map((_, i) => i);

          // 阶段1：右侧和弦向右挪
          for (let shift = 0.5; shift >= 0.1; shift -= 0.1) {
            const moveAmount = currentFontSize * shift;
            updateChordX(rightIdx, moveAmount);
            
            if (!checkNewOverlap(rightIdx, 'right', allOtherIndices)) {
              break; // 与右侧没有新重叠，进入阶段2
            } else {
              // 撤销操作
              updateChordX(rightIdx, -moveAmount);
            }
          }

          // 阶段2：如果原来两个还重叠，左侧向左移
          while (checkOverlap(leftIdx, rightIdx)) {
            const moveAmount = currentFontSize * 0.1;
            
            // 先尝试移动
            updateChordX(leftIdx, -moveAmount);
            
            // 检查是否产生了与更左侧的新重叠
            if (checkNewOverlap(leftIdx, 'left', allOtherIndices)) {
              // 撤销操作并停止
              updateChordX(leftIdx, moveAmount);
              break;
            }
          }

        } else if (component.length === 3) {
          // 三重叠处理
          const [leftIdx, middleIdx, rightIdx] = component;
          const allOtherIndices = infos.map((_, i) => i);

          // 阶段1：最右侧向右移
          while (checkOverlap(middleIdx, rightIdx)) {
            updateChordX(rightIdx, currentFontSize * 0.1);
            
            if (checkNewOverlap(rightIdx, 'right', allOtherIndices)) {
              // 撤销操作并停止
              updateChordX(rightIdx, -currentFontSize * 0.1);
              break;
            }
          }

          // 阶段2：最左侧向左移
          while (checkOverlap(leftIdx, middleIdx)) {
            updateChordX(leftIdx, -currentFontSize * 0.1);
            
            if (checkNewOverlap(leftIdx, 'left', allOtherIndices)) {
              // 撤销操作并停止
              updateChordX(leftIdx, currentFontSize * 0.1);
              break;
            }
          }
        }
      }

      console.log(`✅ 二阶段微调完成，处理了 ${components.length} 组重叠`);
      }
    }

    const chordDrawInfos = chordDrawInfoResult.chordDrawInfos.map(info => ({
      ...info,
      color: chordColor
    }));

    // 第二步：检测重叠并调整颜色
    // 策略：构建重叠图，对每个连通分量从左到右交替着色

    // 1. 构建邻接表
    const adjacency: number[][] = Array.from({ length: chordDrawInfos.length }, () => []);
    for (let i = 0; i < chordDrawInfos.length; i++) {
      for (let j = i + 1; j < chordDrawInfos.length; j++) {
        const a = chordDrawInfos[i];
        const b = chordDrawInfos[j];
        if (rectanglesOverlap(
          a.overlapRectX, a.overlapRectY, a.overlapRectWidth, a.overlapRectHeight,
          b.overlapRectX, b.overlapRectY, b.overlapRectWidth, b.overlapRectHeight
        )) {
          adjacency[i].push(j);
          adjacency[j].push(i);
        }
      }
    }

    // 2. 找出每个连通分量并从左到右交替着色
    const visited = new Set<number>();
    const colorAssignments: boolean[] = Array(chordDrawInfos.length).fill(false); // false=原色, true=浅色

    for (let start = 0; start < chordDrawInfos.length; start++) {
      if (visited.has(start)) continue;

      // BFS收集整个连通分量
      const component: number[] = [];
      const queue: number[] = [start];
      visited.add(start);

      while (queue.length > 0) {
        const u = queue.shift()!;
        component.push(u);

        for (const v of adjacency[u]) {
          if (!visited.has(v)) {
            visited.add(v);
            queue.push(v);
          }
        }
      }

      // 按x坐标排序（从左到右）
      component.sort((a, b) => chordDrawInfos[a].x - chordDrawInfos[b].x);

      // 交替着色：第1个原色，第2个浅色，第3个原色...
      for (let k = 0; k < component.length; k++) {
        colorAssignments[component[k]] = (k % 2 === 1);
      }
    }

    // 3. 应用颜色
    for (let i = 0; i < chordDrawInfos.length; i++) {
      if (colorAssignments[i]) {
        chordDrawInfos[i].color = lightenColor(chordColor, 0.25);
      }
    }

    // 第二步：绘制所有白色背景框（圆角矩形）
    for (const info of chordDrawInfos) {
      // 计算圆角半径（字体大小的40%，最大不超过12px）
      const cornerRadius = Math.min(currentFontSize * 0.4, 12);

      // 绘制白色背景圆角矩形（覆盖原和弦，无边框）
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.roundRect(info.rectX, info.rectY, info.rectWidth, info.rectHeight, cornerRadius);
      ctx.fill();
    }

    // 第三步：绘制所有文本（在最顶层）
    ctx.textBaseline = 'middle';
    for (const info of chordDrawInfos) {
      ctx.fillStyle = info.color;

      if (info.needsChineseFont && info.chordText.includes('或')) {
        // 分段绘制：和弦用 Georgia，"或"字用 OrFont
        const parts = info.chordText.split('或');
        
        // 计算起始位置（居中对齐）
        let totalWidth = 0;
        ctx.font = `normal ${currentFontSize}px ${CHORD_FONT_FAMILY}`;
        for (let i = 0; i < parts.length; i++) {
          totalWidth += ctx.measureText(parts[i]).width;
          if (i < parts.length - 1) {
            ctx.font = `normal ${currentFontSize}px "OrFont", serif`;
            totalWidth += ctx.measureText('或').width;
            ctx.font = `normal ${currentFontSize}px ${CHORD_FONT_FAMILY}`;
          }
        }
        
        // 从左边开始绘制
        let currentX = info.x - totalWidth / 2;
        ctx.textAlign = 'left';
        
        for (let i = 0; i < parts.length; i++) {
          // 绘制和弦部分
          ctx.font = `normal ${currentFontSize}px ${CHORD_FONT_FAMILY}`;
          ctx.fillText(parts[i], currentX, info.y);
          currentX += ctx.measureText(parts[i]).width;
          
          // 绘制"或"字（如果不是最后一个部分）
          if (i < parts.length - 1) {
            ctx.font = `normal ${currentFontSize}px "OrFont", serif`;
            ctx.fillText('或', currentX, info.y);
            currentX += ctx.measureText('或').width;
          }
        }
      } else {
        // 普通和弦，直接绘制
        ctx.font = `normal ${currentFontSize}px ${CHORD_FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(info.chordText, info.x, info.y);
      }
    }

    // 在左上角绘制转调标记（分色显示）
    if (originalKey && targetKey) {
      const markFontSize = Math.floor(image.width * 0.04); // 宽度的4%
      const arrow = ' → '; // 箭头
      const markPadding = 15;

      // 计算文本尺寸
      ctx.font = `normal ${markFontSize}px ${CHORD_FONT_FAMILY}`;
      const originalMetrics = ctx.measureText(originalKey);
      ctx.font = `normal ${markFontSize}px ${ARROW_FONT_FAMILY}`;
      const arrowMetrics = ctx.measureText(arrow);
      ctx.font = `normal ${markFontSize}px ${CHORD_FONT_FAMILY}`;
      const targetMetrics = ctx.measureText(targetKey);

      const totalWidth = originalMetrics.width + arrowMetrics.width + targetMetrics.width;
      const markHeight = markFontSize * 1.2;

      // 计算左上角位置（留出边距）
      const markX = markPadding;
      const markY = markPadding + markHeight;

      // 绘制半透明白色背景
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(
        markX - markPadding / 2,
        markY - markHeight - markPadding / 2,
        totalWidth + markPadding * 1.5,
        markHeight + markPadding
      );

      // 设置文本绘制属性
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      // 绘制原调（黑色）
      ctx.font = `normal ${markFontSize}px ${CHORD_FONT_FAMILY}`;
      ctx.fillStyle = '#000000'; // 黑色
      ctx.fillText(originalKey, markX, markY - markHeight);

      // 绘制箭头（黑色）
      ctx.font = `normal ${markFontSize}px ${ARROW_FONT_FAMILY}`;
      ctx.fillStyle = '#000000'; // 黑色
      ctx.fillText(arrow, markX + originalMetrics.width, markY - markHeight);

      // 绘制目标调（蓝色）
      ctx.font = `normal ${markFontSize}px ${CHORD_FONT_FAMILY}`;
      ctx.fillStyle = '#2563EB'; // 蓝色
      ctx.fillText(targetKey, markX + originalMetrics.width + arrowMetrics.width, markY - markHeight);
    }

    // 转换为 Buffer
    const resultBuffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });

    if (!resultBuffer) {
      throw new Error('Failed to convert canvas to buffer');
    }

    // 返回 base64 格式和实际使用的fontSize
    return {
      resultImage: `data:image/jpeg;base64,${resultBuffer.toString('base64')}`,
      fontSize: currentFontSize,
    };
  } catch (error) {
    console.error('图片标注失败:', error);
    return {
      resultImage: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
      fontSize: 20,
    };
  }
}
