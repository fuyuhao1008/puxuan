import { NextRequest, NextResponse } from 'next/server';
import { chordTransposer, normalizeNoteToSharp, Chord, TransposeResult, isKeyFlats } from '@/lib/chord-transposer';
import { createHash } from 'crypto';
import { callArkChatDetailed, ArkApiError } from '@/lib/ark-client';
import { registerFont, createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';

const DEFAULT_CHORD_FONT_FAMILY = '"DejaVu Serif", "Times New Roman", Times, serif';

let CHORD_FONT_FAMILY = process.env.CHORD_FONT_FAMILY || DEFAULT_CHORD_FONT_FAMILY;
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

// 重新识别的模型配置（与第一次识别相同，使用快速模式）
const MODEL_LITE = process.env.VISION_MODEL_LITE || 'doubao-seed-2-0-lite-260215';
const MODEL_VISION = process.env.VISION_MODEL_VISION || 'doubao-seed-1-6-vision-250815';

// CHORD_FONT_FAMILY / ARROW_FONT_FAMILY 在 ensureFontsReady() 内会按需更新。

// 和弦中心点类型
type ChordCenter = [string[], number, number];  // [["C"], cx, cy]

type ParsedModelCenter = {
  text: string;
  chords: string[];
  cx: number;
  cy: number;
};

// 与 transpose 对齐：Lite 429 时可降级到备用模型（这里优先切到 Vision）
function selectFallbackModel(excludedModel: string): string {
  const candidates = [MODEL_VISION, MODEL_LITE].filter((m) => m !== excludedModel);
  if (candidates.length === 0) throw new Error('没有可用的备用模型');
  return candidates[0];
}

/**
 * 按 y 坐标分行
 */
function groupByRow(
  centers: ChordCenter[],
  rowThreshold: number = 25
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

  for (const row of rows) {
    row.chords.sort((a, b) => a[1] - b[1]);
  }

  rows.sort((a, b) => a.rowY - b.rowY);

  return rows;
}

/**
 * 将主模型和辅助模型的行一一对应
 */
function matchRows(
  mainRows: { rowY: number; chords: ChordCenter[] }[],
  auxRows: { rowY: number; chords: ChordCenter[] }[],
  rowThreshold: number = 25
): { mainRow: { rowY: number; chords: ChordCenter[] } | null; auxRow: { rowY: number; chords: ChordCenter[] } | null }[] {
  const pairs: { mainRow: typeof mainRows[0] | null; auxRow: typeof auxRows[0] | null }[] = [];

  if (mainRows.length === auxRows.length) {
    for (let i = 0; i < mainRows.length; i++) {
      pairs.push({ mainRow: mainRows[i], auxRow: auxRows[i] });
    }
    return pairs;
  }

  let mi = 0, ai = 0;

  while (mi < mainRows.length || ai < auxRows.length) {
    const mainRow = mainRows[mi] || null;
    const auxRow = auxRows[ai] || null;

    if (!mainRow) {
      pairs.push({ mainRow: null, auxRow });
      ai++;
    } else if (!auxRow) {
      pairs.push({ mainRow, auxRow: null });
      mi++;
    } else {
      const dy = Math.abs(mainRow.rowY - auxRow.rowY);

      if (dy <= rowThreshold) {
        pairs.push({ mainRow, auxRow });
        mi++;
        ai++;
      } else if (mainRow.rowY < auxRow.rowY) {
        pairs.push({ mainRow, auxRow: null });
        mi++;
      } else {
        pairs.push({ mainRow: null, auxRow });
        ai++;
      }
    }
  }

  return pairs;
}

/**
 * 对单行进行补全
 * 
 * 补入逻辑说明：
 * 1. 统计主模型和辅助模型中各和弦名称的出现次数
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
      
      // y 坐标处理：精准模式直接用主模型坐标，快速模式加权平均
      if (skipYWeightedAverage) {
        // 精准模式：直接用主模型的 y 坐标，不参与加权平均
        processedXSet.add(mainX);
        weightedYList.push(mainY);
        console.log(`  📍 精准模式保留主模型坐标: "${mainChordTexts.join('或')}" 主模型.y=${mainY}`);
      } else {
        // 快速模式：y 坐标加权平均
        const weightedY = Math.round((mainY * mainWeight + auxY * 1) / (mainWeight + 1));
        result[nearbyIndex] = [nearbyMainChord[0], nearbyMainChord[1], weightedY];
        processedXSet.add(mainX);
        weightedYList.push(weightedY);
        console.log(`  🔀 y坐标加权平均: "${mainChordTexts.join('或')}" 主模型.y=${mainY}(权重${mainWeight}), 辅助.y=${auxY}(权重1) → 加权.y=${weightedY}`);
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
 */
function mergeResults(
  mainResult: { key: string | null; centers: ChordCenter[]; modelUsed?: string },
  auxResult: { key: string | null; centers: ChordCenter[]; modelUsed?: string },
  imgWidth: number,
  imgHeight: number,
  mainWeight: number = 4
): { key: string | null; centers: ChordCenter[] } {

  const ROW_THRESHOLD = 25;
  const POSITION_TOLERANCE = 40;  // 千分比的 4%

  const mainRows = groupByRow(mainResult.centers, ROW_THRESHOLD);
  const auxRows = groupByRow(auxResult.centers, ROW_THRESHOLD);

  const rowPairs = matchRows(mainRows, auxRows, ROW_THRESHOLD);

  const mergedCenters: ChordCenter[] = [];

  for (const pair of rowPairs) {
    const mainRow = pair.mainRow;
    const auxRow = pair.auxRow;

    if (mainRow && auxRow) {
      const merged = complementRow(mainRow.chords, auxRow.chords, POSITION_TOLERANCE, mainWeight);
      mergedCenters.push(...merged);
    } else if (auxRow) {
      for (const auxChord of auxRow.chords) {
        const auxX = auxChord[1];
        const auxY = auxChord[2];
        
        const exists = mergedCenters.some(c =>
          Math.abs(c[1] - auxX) <= POSITION_TOLERANCE && Math.abs(c[2] - auxY) <= ROW_THRESHOLD
        );
        
        if (!exists) {
          mergedCenters.push(auxChord);
        }
      }
    } else if (mainRow) {
      mergedCenters.push(...mainRow.chords);
    }
  }

  mergedCenters.sort((a, b) => {
    const dy = a[2] - b[2];
    if (Math.abs(dy) > ROW_THRESHOLD) return dy;
    return a[1] - b[1];
  });

  return {
    key: mainResult.key || auxResult.key,
    centers: mergedCenters
  };
}

// ========== API 路由处理 ==========
export async function POST(request: NextRequest) {
  const fontsReady = ensureFontsReady();
  try {
    const formData = await request.formData();
    const imageFile = formData.get('image') as File;
    const targetKey = formData.get('targetKey') as string;
    const originalKeyInput = formData.get('originalKey') as string;
    const anchorFirstStr = formData.get('anchorFirst') as string;
    const anchorLastStr = formData.get('anchorLast') as string;
    const directionStr = formData.get('direction') as string;
    const semitonesStr = formData.get('semitones') as string;
    const chordColor = (formData.get('chordColor') as string) || '#2563EB'; // 默认蓝色
    const fontSizeStr = formData.get('fontSize') as string; // 字体大小参数
    const isRetry = formData.get('isRetry') === 'true'; // 是否为重新识别

    if (!imageFile) {
      return NextResponse.json({ error: '请上传图片' }, { status: 400 });
    }

    // 正常转调流程（重新定位：强制调用大模型）
    if (!targetKey) {
      return NextResponse.json({ error: '请选择目标调' }, { status: 400 });
    }

    // 计算实际半音数
    let semitones = 0;
    if (directionStr && semitonesStr) {
      const dir = directionStr === 'up' ? 1 : -1;
      semitones = dir * parseFloat(semitonesStr);
    }

    console.log('转调设置:', { targetKey, direction: directionStr, semitonesInput: semitonesStr, finalSemitones: semitones });

    // 解析用户指定的锚点（可选）
    let userAnchorFirst = null;
    let userAnchorLast = null;
    if (anchorFirstStr && anchorLastStr) {
      userAnchorFirst = JSON.parse(anchorFirstStr);
      userAnchorLast = JSON.parse(anchorLastStr);
      console.log('用户指定的锚点:', { first: userAnchorFirst, last: userAnchorLast });
    }

    // 将图片转换为 buffer
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());

    // 智能放大低分辨率图片（用于AI识别）
    const upscaledImage = await upscaleImageIfNeeded(imageBuffer);
    const imgWidth = upscaledImage.width;
    const imgHeight = upscaledImage.height;
    
    // 使用放大后的图片生成base64（用于AI识别）
    const imageBase64 = `data:${imageFile.type};base64,${upscaledImage.buffer.toString('base64')}`;

    console.log('图片尺寸:', imgWidth, 'x', imgHeight);
    if (upscaledImage.wasUpscaled) {
      console.log(`✅ AI识别使用放大图片: ${imgWidth}x${imgHeight}`);
    }

    // 重新定位：强制调用大模型识别和弦
    console.log('🔄 重新定位：调用大模型识别和弦...');
    const recognitionResult = await recognizeChordsFromImage(imageBase64, imageFile.type, imgWidth, imgHeight, isRetry);

    if (!recognitionResult) {
      return NextResponse.json({ error: '和弦识别失败' }, { status: 500 });
    }

    // ===== 新增：转换数组格式为对象格式 =====
    if (recognitionResult.centers && recognitionResult.centers.length > 0) {
      const firstCenter = recognitionResult.centers[0];
      // 如果是数组格式 [["F#"], 106, 28]，转换为对象格式
      if (Array.isArray(firstCenter) && firstCenter.length === 3) {
        recognitionResult.centers = recognitionResult.centers.map((item: any) => {
          const [chordsArr, cx, cy] = item;
          const text = Array.isArray(chordsArr) ? chordsArr[0] : String(chordsArr);
          return { text, chords: chordsArr, cx, cy };
        });
        console.log('✅ 已将数组格式 centers 转换为对象格式');
      }
    }
    // ===== 结束新增 =====
    
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

    console.log('========== AI识别原始结果 ==========');
    console.log('识别中心点数量:', rawCenters.length);

    // 收集所有有效的中心点坐标（千分比坐标 0-1000）
    const validCenters = rawCenters.filter(
      (c: any) => typeof c.cx === 'number' && typeof c.cy === 'number' && !isNaN(c.cx) && !isNaN(c.cy) &&
                   c.cx >= 0 && c.cx <= imgWidth && c.cy >= 0 && c.cy <= imgHeight
    );

    // 去重和异常值检测（坐标为千分比 0-1000）
    const dedupedCenters: any[] = [];
    // 千分比距离阈值：1% 对应千分比 10
    const minDimension = Math.min(imgWidth, imgHeight);
    const distanceThreshold = 10;  // 千分比的 1%

    // 检测异常Y值：计算所有和弦的Y坐标中位数
    const yCoordinates = validCenters.map((c: any) => c.cy);
    const sortedY = [...yCoordinates].sort((a: number, b: number) => a - b);
    const medianY = sortedY.length > 0 ? sortedY[Math.floor(sortedY.length / 2)] : 0;
    const yStdDev = yCoordinates.length > 1 
      ? Math.sqrt(yCoordinates.reduce((sum: number, y: number) => sum + Math.pow(y - medianY, 2), 0) / yCoordinates.length)
      : 0;

    for (const center of validCenters) {
      let isDuplicate = false;

      // 异常值检测：排除Y坐标偏离中位数超过3个标准差的和弦
      if (validCenters.length > 5 && Math.abs(center.cy - medianY) > 3 * yStdDev) {
        console.log(`⚠️ 检测到异常Y坐标: ${center.text} 在 y=${center.cy}, 偏离中位数 ${medianY}，可能是误识别`);
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

    console.log('========== 去重统计 ==========');
    console.log('原始数量:', validCenters.length);
    console.log('去重后数量:', dedupedCenters.length);
    console.log('移除重复:', validCenters.length - dedupedCenters.length);
    console.log('Y坐标中位数:', medianY.toFixed(1), '标准差:', yStdDev.toFixed(1));

    if (dedupedCenters.length > 0) {
      // ========== 直接使用千分比坐标 ==========
      // AI 返回的坐标本来就是千分比（0-1000 表示 0-100%）
      // X轴：直接使用 cx / 10
      // Y轴：有用户锚点时校准，否则使用 cy / 10

      console.log('========== 坐标处理（千分比） ==========');

      // Y轴：根据是否有用户锚点决定
      let userMinY = null;
      let userMaxY = null;

      if (userAnchorFirst && userAnchorLast) {
        console.log('========== 使用千分比坐标（带用户Y轴锚点） ==========');
        userMinY = userAnchorFirst.y;
        userMaxY = userAnchorLast.y;
        console.log('用户Y轴锚点:', { min: userMinY, max: userMaxY });
      } else {
        console.log('========== 直接使用千分比坐标 ==========');
      }

      // 对每个和弦直接使用千分比坐标
      for (let i = 0; i < dedupedCenters.length; i++) {
        const rawCenter = dedupedCenters[i];

        // X轴：直接使用千分比
        const x = rawCenter.cx / 10;  // 千分比 → 百分比

        // Y轴：直接使用千分比，取消重映射
        const y = rawCenter.cy / 10;
        
        // 可选：保留锚点日志但不使用
        if (userMinY !== null && userMaxY !== null) {
          console.log(`⚠️ 忽略用户锚点，直接使用AI原始Y坐标: ${y.toFixed(2)}%`);
        }

        // 只输出前5个和弦的日志
        if (i < 5) {
          console.log(`[和弦 ${i}] 千分比坐标: cx=${rawCenter.cx}, cy=${rawCenter.cy} → 百分比: x=${x.toFixed(2)}%, y=${y.toFixed(2)}%`);
        }

        // 根据原调修正AI识别的和弦（修正遗漏的升降号）
        // 重新识别使用快速模式（Lite + Vision），应用快速模式的修正规则（如 C/D 调的 B→D 转换）
        const correctedChordText = chordTransposer.correctChordByKey(rawCenter.text, originalKey, true);

        // 处理"或"字连接的和弦（如 "C或C/E"）
        if (correctedChordText.includes('或')) {
          // 使用 splitByOr 方法正确处理括号
          const subChordTexts = chordTransposer.splitByOr(correctedChordText);
          const subChords: any[] = [];
          let allParsed = true;

          console.log(`  检测到"或"字和弦，包含 ${subChordTexts.length} 个和弦`);
          for (const subText of subChordTexts) {
            const subParsed = chordTransposer.parseChord(subText.trim());
            if (subParsed) {
              subChords.push(subParsed);
              console.log(`    ✓ 解析子和弦成功: ${subText.trim()}`);
            } else {
              allParsed = false;
              break;
            }
          }

          if (allParsed && subChords.length > 0) {
            // 所有子和弦都解析成功，添加为特殊和弦对象
            chords.push({
              ...subChords[0], // 使用第一个和弦作为基础
              x: x,
              y: y,
              chords: subChords, // 保存所有子和弦
              text: subChordTexts.join('或') // 保存原始文本
            });
          }
        } else {
          // 普通和弦，按原有逻辑处理
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

    console.log('识别并解析出和弦总数:', chords.length);

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

    console.log('展开后的和弦数量:', expandedChords.length);

    // 准备转调的和弦列表
    const chordsToTranspose = expandedChords.map(item => item.chord);

    // 执行转调
    let transposeResult: TransposeResult;
    if (semitones !== 0) {
      // 用户指定了升降音数，使用新方法
      // 传入用户选择的目标调，确保显示的targetKey与用户选择一致
      transposeResult = chordTransposer.transposeChordsBySemitones(chordsToTranspose, originalKey, semitones, true, targetKey);
      console.log('使用升降音数转调:', semitones, '用户选择目标调:', targetKey);
    } else {
      // 使用目标调转调
      transposeResult = chordTransposer.transposeChords(chordsToTranspose, originalKey, targetKey, true);
      console.log('使用目标调转调:', targetKey);
    }

    console.log('转调结果：和弦数量', transposeResult.chords.length, '原调', transposeResult.originalKey, '→ 目标调', transposeResult.targetKey);

    // 根据目标调决定是否使用降号形式
    // 降号调：C, F, Bb, Eb, Ab, Db, Gb
    // 注意：Cb不是降号调，它是B调的等音调（Cb = B），B是升号调（5#）
    const flatKeys = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const shouldUseFlats = flatKeys.includes(transposeResult.targetKey);

    // 重新组织转调结果，将"或"字连接的和弦合并
    const mergedTransposeResult: TransposeResult = {
      ...transposeResult,
      chords: chords.map((originalChord, index) => {
        // 检查是否有 chords 数组
        if (Array.isArray((originalChord as any).chords)) {
          // 找到对应的转调结果
          const transposedChords: Chord[] = [];

          // 遍历所有扩展的和弦，找到属于这个原始和弦的转调结果
          for (let i = 0; i < expandedChords.length; i++) {
            if (expandedChords[i].originalIndex === index) {
              // 使用索引直接获取转调结果
              const transposedItem = transposeResult.chords[i];
              if (transposedItem) {
                transposedChords.push(transposedItem.transposed);
              }
            }
          }

          // 创建合并后的转调结果（保留x和y坐标）
          return {
            original: originalChord as Chord,
            transposed: {
              ...transposedChords[0], // 展开第一个转调结果的所有属性
              x: originalChord.x, // 保留原始x坐标
              y: originalChord.y, // 保留原始y坐标
              chords: transposedChords,
              text: transposedChords.map(c => chordTransposer.chordToStringWithBassMode(c, shouldUseFlats, isKeyFlats(c.root))).join('或')
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

    console.log('合并后总和弦数:', transposeResult.chords.length);

    // 处理字体大小参数
    let fontSize = null;
    if (fontSizeStr) {
      const parsedFontSize = parseFloat(fontSizeStr);
      if (!isNaN(parsedFontSize) && parsedFontSize > 0) {
        fontSize = parsedFontSize;
      }
    }

    // 生成标注后的图片（使用canvas）
    await fontsReady;
    const { resultImage } = await annotateImage(
      imageBuffer,
      transposeResult,
      chordColor,
      fontSize,
      transposeResult.originalKey,
      transposeResult.targetKey
    );

    return NextResponse.json({
      originalKey: transposeResult.originalKey,
      targetKey: transposeResult.targetKey,
      semitones: transposeResult.semitones,
      chordColor: chordColor,
      fontSize: fontSize,
      chords: transposeResult.chords.map(item => {
        const transposed = item.transposed as any;

        return {
          original: item.original, // 保留完整的原始 chord 对象
          transposed: item.transposed, // 保留完整的转调后 chord 对象
          x: item.transposed.x,
          y: item.transposed.y,
        };
      }),
      resultImage: resultImage,
      recognitionResult: recognitionResult,
    });
  } catch (error: any) {
    console.error('重新定位处理错误:', error);
    
    // 提供更详细的错误信息
    let errorMessage = '处理失败';
    if (error.message) {
      if (error.message.includes('fetch') || error.message.includes('network')) {
        errorMessage = '网络错误，请检查网络连接后重试';
      } else if (error.message.includes('timeout')) {
        errorMessage = '请求超时，请稍后重试';
      } else if (error.message.includes('JSON')) {
        errorMessage = 'AI识别失败，返回数据格式错误';
      } else {
        errorMessage = `处理失败：${error.message}`;
      }
    }
    
    return NextResponse.json({ error: errorMessage }, { status: 500 });
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

/**
 * 智能放大低分辨率图片（使用 Canvas 替代 Sharp，减少冷启动时间）
 * 如果宽度或高度小于1000，等比例放大到至少1000
 * @param imageBuffer 原始图片buffer
 * @returns 处理后的图片buffer和尺寸信息
 */
async function upscaleImageIfNeeded(imageBuffer: Buffer): Promise<{ buffer: Buffer; width: number; height: number; wasUpscaled: boolean }> {
  // 使用 Canvas 加载图片获取尺寸
  const image = await loadImage(imageBuffer);
  const originalWidth = image.width || 800;
  const originalHeight = image.height || 1000;

  const MIN_SIZE = 1000;

  // 检查是否需要放大
  if (originalWidth >= MIN_SIZE && originalHeight >= MIN_SIZE) {
    // 两个维度都满足，不需要放大
    return { buffer: imageBuffer, width: originalWidth, height: originalHeight, wasUpscaled: false };
  }

  // 计算目标尺寸
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth < MIN_SIZE && originalHeight < MIN_SIZE) {
    // 两个都小于1000，将较小的那个放大到1000
    if (originalWidth < originalHeight) {
      targetWidth = MIN_SIZE;
      targetHeight = Math.round((MIN_SIZE / originalWidth) * originalHeight);
    } else {
      targetHeight = MIN_SIZE;
      targetWidth = Math.round((MIN_SIZE / originalHeight) * originalWidth);
    }
  } else if (originalWidth < MIN_SIZE) {
    // 只有宽度小于1000，放大宽度到1000，高度等比例放大
    targetWidth = MIN_SIZE;
    targetHeight = Math.round((MIN_SIZE / originalWidth) * originalHeight);
  } else {
    // 只有高度小于1000，放大高度到1000，宽度等比例放大
    targetHeight = MIN_SIZE;
    targetWidth = Math.round((MIN_SIZE / originalHeight) * originalWidth);
  }

  console.log(`🔧 图片放大: ${originalWidth}x${originalHeight} → ${targetWidth}x${targetHeight}`);

  // 使用 Canvas 进行高质量缩放
  const canvas = createCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  
  // 启用图像平滑
  ctx.imageSmoothingEnabled = true;
  
  // 绘制缩放后的图片
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
  
  // 导出为 JPEG 格式（高质量）
  const upscaledBuffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });

  return {
    buffer: upscaledBuffer,
    width: targetWidth,
    height: targetHeight,
    wasUpscaled: true,
  };
}

// ========== Ark 识别实现（与 transpose 对齐） ==========
function parseModelResponse(content: string): { key: string | null; centers: ParsedModelCenter[] } {
  let jsonStr = String(content ?? '').trim();

  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    jsonStr = jsonMatch[1];
  }

  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('未找到JSON起始符号 {');
  }

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
      if (char === '{') braceCount++;
      else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          lastBrace = i;
          break;
        }
      }
    }
  }

  if (lastBrace === -1) {
    throw new Error('未找到匹配的JSON结束符号 }');
  }

  jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);

  let result: any;
  try {
    result = JSON.parse(jsonStr);
  } catch (parseError) {
    let fixedJson = jsonStr;
    fixedJson = fixedJson.replace(/,\s*}/g, '}');
    fixedJson = fixedJson.replace(/,\s*\]/g, ']');
    fixedJson = fixedJson.replace(/,\s*([}\]])/g, '$1');
    fixedJson = fixedJson.replace(/}\s*,\s*\]/g, '}]');
    fixedJson = fixedJson.replace(/\]\s*,\s*\]/g, ']]');

    // 修复模型返回的错误格式：[ ["D"], "F" ], 788, 444 ] → [["D", "F"], 788, 444]
    fixedJson = fixedJson.replace(/\[\[\"([^\"]+)\"\]\s*,\s*\"([^\"]+)\"\]\s*,\s*(\d+)\s*,\s*(\d+)\s*\],?/g, '[["$1", "$2"], $3, $4]');

    const firstBrace2 = fixedJson.indexOf('{');
    const lastBrace2 = fixedJson.lastIndexOf('}');
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
    } catch {
      throw new Error(`JSON解析失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
  }

  const centers: ParsedModelCenter[] = (result?.centers || [])
    .map((center: any): ParsedModelCenter | null => {
      // Compact format: [textOrArr, cx, cy]
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
  } catch (err: any) {
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

  const parsed = parseModelResponse(content);
  const centers: ChordCenter[] = parsed.centers.map((c) => [c.chords, c.cx, c.cy]);

  return {
    key: parsed.key,
    centers,
    modelUsed: modelName,
  };
}

async function recognizeChordsFromImage(
  imageBase64: string,
  mimeType: string,
  imgWidth: number,
  imgHeight: number,
  isRetry: boolean = false,
  modelMode?: string
): Promise<any> {
  const isFastMode = (modelMode ?? 'fast') === 'fast';
  const imageDetail: 'high' = 'high';

  console.log('='.repeat(60));
  console.log(`🎯 和弦识别任务启动 (${isFastMode ? '快速模式' : '精准模式'})`);
  console.log(`📐 图片尺寸: ${imgWidth} x ${imgHeight}`);
  console.log('='.repeat(60));

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

  const userPromptBase = '请分析这张简谱图片，识别调号和所有和弦标记（升降号统一放在大写字母后，如Bb、F#），以及它们的坐标，以JSON格式返回，不要遗漏和弦';
  const userPrompt = isRetry
    ? `${userPromptBase}\n\n【补充要求】上一次可能漏识别/误识别，请这次务必检查反复段落/房子框/底部区域，不要遗漏。`
    : userPromptBase;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: userPrompt },
        { type: 'image_url' as const, image_url: { url: imageBase64, detail: imageDetail } },
      ],
    },
  ];

  let result: { key: string | null; centers: any[]; _modelUsed?: string };

  if (isFastMode) {
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

    const tModelStart = Date.now();

    const litePromise = callModelForRecognition(messages, MODEL_LITE, false)
      .catch(async (err) => {
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
      const detectedKey = liteResult.key || visionResult.key || 'C';
      console.log(`\n🎼 识别原调: ${detectedKey}`);
      console.log(`\n🔧 【合并前修正】`);
      const correctedLiteResult = correctModelResult(liteResult, detectedKey, true);
      const correctedVisionResult = correctModelResult(visionResult, detectedKey, true);
      const mergedResult = mergeResults(correctedLiteResult, correctedVisionResult, imgWidth, imgHeight, 4);

      result = {
        key: mergedResult.key,
        centers: mergedResult.centers.map((c) => ({ text: c[0].join('或'), chords: c[0], cx: c[1], cy: c[2] })),
        _modelUsed: `${liteResult.modelUsed}+${visionResult.modelUsed}`,
      };
      console.log(`✅ 最终结果: ${result.centers.length}个和弦, 调号: ${result.key || '未知'}`);
    } else {
      console.log('⚠️ Vision 未在补查窗口内返回，使用 Lite 结果（不再重跑 Lite）');
      const detectedKey = liteResult.key || 'C';
      console.log(`\n🎼 识别原调: ${detectedKey}`);
      console.log(`\n🔧 【修正结果】`);
      const correctedLiteResult = correctModelResult(liteResult, detectedKey, true);
      result = {
        key: correctedLiteResult.key,
        centers: correctedLiteResult.centers.map((c) => ({ text: c[0].join('或'), chords: c[0], cx: c[1], cy: c[2] })),
        _modelUsed: correctedLiteResult.modelUsed,
      };
    }
  } else {
    console.log('🎯 精准模式：Lite(thinking) 深度思考');
    console.log(`   Lite 模型: ${MODEL_LITE} (thinking: enabled)`);
    const tModelStart = Date.now();
    const liteResult = await callModelForRecognition(messages, MODEL_LITE, true);
    console.log(`⏱️ 模型调用耗时(精准模式): ${Date.now() - tModelStart}ms (detail=${imageDetail})`);

    const detectedKey = liteResult.key || 'C';
    console.log(`\n🎼 识别原调: ${detectedKey}`);
    console.log(`\n🔧 【修正结果】`);
    const correctedLiteResult = correctModelResult(liteResult, detectedKey, false);
    result = {
      key: correctedLiteResult.key,
      centers: correctedLiteResult.centers.map((c) => ({ text: c[0].join('或'), chords: c[0], cx: c[1], cy: c[2] })),
      _modelUsed: correctedLiteResult.modelUsed,
    };
  }

  console.log('识别结果：识别到', result.centers?.length || 0, '个和弦，原调', result.key);
  return result;
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

    // 测量文本宽度（分段测量：和弦用 CHORD_FONT_FAMILY，"或"字用 OrFont）
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
    // 估算文本高度（更精确）
    const textHeight = fontSize * 1.1;

    // 计算实际绘制矩形（分别设置横向和纵向padding）
    // 左侧padding较小，避免遮挡左侧内容；右侧padding较大，覆盖升降号后缀
    const horizontalPaddingLeft = fontSize * 0.15;  // 左侧padding（减小）
    const horizontalPaddingRight = fontSize * 0.68; // 右侧padding（保持不变）
    const verticalPadding = fontSize * 0.5;   // 纵向padding
    const rectWidth = Math.round(textWidth + horizontalPaddingLeft + horizontalPaddingRight);
    const rectHeight = Math.round(textHeight + verticalPadding * 0.4); // 纵向padding减小，避免遮盖上一行歌词
    const rectX = x - textWidth / 2 - horizontalPaddingLeft;
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
 */
export async function annotateImage(
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
    console.log('========== annotateImage 开始 ==========');
    console.log('目标调:', targetKey, '是否使用降号形式:', shouldUseFlats);
    console.log('和弦总数:', transposeResult.chords.length);

    // 加载原图
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');

    // 绘制原图
    ctx.drawImage(image, 0, 0);

    // 计算字体大小：如果提供了自定义值则使用，否则动态计算
    const fontSize = customFontSize || Math.max(16, Math.round(image.width / 42));

    // 第一步：遍历所有和弦，计算并存储背景框和文本信息
    type ChordDrawInfo = {
      chordText: string;
      x: number;
      y: number;
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

    // 第一步：遍历所有和弦，计算并存储背景框和文本信息，并统计重叠
    // 同时实现字体自动调整循环逻辑：如果重叠和弦数 ≥ 4 且是自动计算的字体，则减小字体 4px
    let currentFontSize = fontSize;
    let chordDrawInfoResult = calculateChordInfos(image, transposeResult, ctx, currentFontSize, chordTransposer, shouldUseFlats, flatKeys);

    // 只在自动计算字体时进行调整（customFontSize 为 null/undefined）
    // 限制最多三轮（最多减小 12px）
    let adjustmentCount = 0;
    const maxAdjustmentCount = 3; // 最多调整 3 次

    while (customFontSize === undefined || customFontSize === null) {
      const { overlappingGroupCount, overlappingChordCount } = chordDrawInfoResult;
      
      if (currentFontSize <= 12) break;
      
      // 不需要调小字体的条件：组合数 <= 2 且 和弦数 <= 7
      // 不需要调小字体的条件：组合数 <= 2 且 和弦数 <= 5
      if (overlappingGroupCount <= 2 && overlappingChordCount <= 5) break;

      if (adjustmentCount >= maxAdjustmentCount) {
        // 已达到最大调整次数，退出循环
        console.log(`已达到最大调整次数 ${maxAdjustmentCount} 次，当前组合数：${overlappingGroupCount}，和弦数：${overlappingChordCount}`);
        break;
      }

      // 需要调小字体
      currentFontSize -= 4;
      adjustmentCount++;
      console.log(`字体调整（第${adjustmentCount}次）：${currentFontSize + 4}px → ${currentFontSize}px，组合数：${overlappingGroupCount}，和弦数：${overlappingChordCount}`);

      // 重新计算和弦信息
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

    // 使用最终计算的和弦信息
    const chordDrawInfos = chordDrawInfoResult.chordDrawInfos.map(info => ({
      ...info,
      color: chordColor // 初始使用原色
    }));

    console.log(`最终字体大小：${currentFontSize}px，组合数：${chordDrawInfoResult.overlappingGroupCount}，和弦数：${chordDrawInfoResult.overlappingChordCount}`);

    // 第二步：检测重叠并调整颜色（按位置交替变化）
    // 1. 检测所有重叠的和弦（使用小padding的矩形进行检测）
    const overlappingChords: number[] = []; // 存储重叠和弦的索引

    for (let i = 0; i < chordDrawInfos.length; i++) {
      let hasOverlap = false;
      for (let j = 0; j < chordDrawInfos.length; j++) {
        if (i === j) continue;

        const current = chordDrawInfos[i];
        const other = chordDrawInfos[j];

        // 使用小padding的重叠检测矩形来判断是否重叠
        if (rectanglesOverlap(
          current.overlapRectX, current.overlapRectY, current.overlapRectWidth, current.overlapRectHeight,
          other.overlapRectX, other.overlapRectY, other.overlapRectWidth, other.overlapRectHeight
        )) {
          hasOverlap = true;
          break;
        }
      }

      if (hasOverlap) {
        overlappingChords.push(i);
      }
    }

    // 2. 将重叠的和弦按照x坐标（从左到右）排序
    overlappingChords.sort((a, b) => chordDrawInfos[a].x - chordDrawInfos[b].x);

    // 3. 按排序顺序交替分配颜色（第1个原色，第2个浅色，第3个原色...）
    for (let k = 0; k < overlappingChords.length; k++) {
      const i = overlappingChords[k]; // 原始索引
      if (k % 2 === 1) {
        // 偶数索引（第2、4、6...个）使用浅色
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
        // 分段绘制：和弦用 CHORD_FONT_FAMILY，"或"字用 OrFont
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

    // 返回 base64 格式和实际使用的fontSize
    return {
      resultImage: `data:image/jpeg;base64,${resultBuffer.toString('base64')}`,
      fontSize: currentFontSize,
    };
  } catch (error) {
    console.error('图片标注失败:', error);
    // 失败时返回原图和默认fontSize
    return {
      resultImage: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
      fontSize: 20, // 失败时返回默认值
    };
  }
}
