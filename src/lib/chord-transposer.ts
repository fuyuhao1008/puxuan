/**
 * 和弦转调工具类
 * 支持完整的12个调性和等音转换
 */

export type ChordQuality = '' | 'm' | 'maj' | 'min' | 'aug' | 'dim' | 'sus2' | 'sus4' | 'add9' | '6' | '7' | 'maj7' | '9' | '11' | '13' | string; // 支持"7sus4"等复合和弦性质

// 视觉识别错误修正库：修正连音线干扰导致的误识别
// 规则1：#Em、E#m 等 → F#m（F容易被识别为E）
// 规则2：C/D调里的纯B和弦 → D（D容易被识别为B）- 仅快速模式
// 规则3：F调里的E和弦 → F（F容易被识别为E）
const VISION_ERROR_CORRECTIONS: {
  // 无条件修正（不依赖原调）
  unconditional: Record<string, string>;
  // 依赖原调的修正（始终应用）
  byKey: Record<string, Record<string, string>>;
  // 仅快速模式下应用的修正（深度思考模式不应用）
  fastModeOnly: Record<string, Record<string, string>>;
} = {
  // 无条件修正：#Em → F#m 等
  unconditional: {
    // F#m 被误识别为 #Em 或 E#m
    '#Em': 'F#m',
    '#Em7': 'F#m7',
    'E#m': 'F#m',
    'E#m7': 'F#m7',
  },
  // 依赖原调的修正（始终应用）
  byKey: {
    // F调：E和弦 → F（F容易被识别为E）
    'F': {
      'E': 'F',
    },
  },
  // 仅快速模式下应用的修正（深度思考模式更准确，不需要修正）
  fastModeOnly: {
    // C调：纯B和弦 → D（D容易被识别为B，而C调中B是减和弦，不常用）
    'C': {
      'B': 'D',
    },
    // D调：纯B和弦 → D（同理）
    'D': {
      'B': 'D',
    },
  },
};

// OCR修正库：根据原调修正AI识别遗漏的升降号
const OCR_CORRECTION_LIBRARY: Record<string, Record<string, string>> = {
  /* ======================
   * 升号调（Sharp Keys）
   * ====================== */

  // C 调（无升降号）
  'C': {},

  // G 调（1#：F#）
  'G': {
    // Slash 低音（相差3个半音，需要修正）
    'Em/F': 'Em/F#',
    'D/F': 'D/F#',
  },

  // D 调（2#：F#, C#）
  'D': {
    // Slash 低音（相差3个半音，需要修正）
    'A/C': 'A/C#',
    'D/F': 'D/F#',
    'Bm/F': 'Bm/F#',
    'E7/G': 'E7/G#',

    // 和弦根音（相差3个半音，需要修正）
    'C/E': 'C#/E',
  },

  // A 调（3#：F#, C#, G#）
  'A': {
    // Slash 低音（相差3个半音，需要修正）
    'A/C': 'A/C#',
    'D/F': 'D/F#',
    'E/G': 'E/G#',
    'C#m/G': 'C#m/G#',

    // 和弦根音（相差3个半音，需要修正）
    'C/E': 'C#/E',
    'G/B': 'G#/B',
  },

  // E 调（4#：F#, C#, G#, D#）
  'E': {
    // Slash 低音（相差3个半音，需要修正）
    'E/G': 'E/G#',
    'B/D': 'B/D#',
    'A/C': 'A/C#',
    'F#7/A': 'F#7/A#',

    // 和弦根音（相差3个半音，需要修正）
    'C/E': 'C#/E',
    'G/B': 'G#/B',
  },

  // B 调（5#：F#, C#, G#, D#, A#）
  'B': {
    // Slash 低音（相差3个半音，需要修正）
    'B/D': 'B/D#',
    'E/G': 'E/G#',
    'F#/A': 'F#/A#',
    'C#m/G': 'C#m/G#',

    // 和弦根音（相差3个半音，需要修正）
    'C/E': 'C#/E',
  },

  // F# 调（6#：F#, C#, G#, D#, A#, E#）
  'F#': {
    // Slash 低音（相差3个半音，需要修正）
    'F#/A': 'F#/A#',
    'C#/E': 'C#/E#',
    'B/D': 'B/D#',

    // 和弦根音（相差3个半音，需要修正）
    'G/B': 'G#/B',
  },

  // C# 调（7#：F#, C#, G#, D#, A#, E#, B#）
  'C#': {
    'F#/A': 'F#/A#',
    'C#/E': 'C#/E#',
    'G#/B': 'G#/B#',
  },

  /* ======================
   * 降号调（Flat Keys）
   * ====================== */

  // F 调（1♭：Bb）
  'F': {},

  // Bb 调（2♭：Bb, Eb）
  'Bb': {
    // Slash 低音
    'E/G': 'Eb/G',

    // 和弦根音
    'E/Bb': 'Eb/Bb',
    'E/F': 'Eb/F',
  },

  // Eb 调（3♭：Bb, Eb, Ab）
  'Eb': {
    // Slash 低音
    'E/G': 'Eb/G',
    'A/C': 'Ab/C',

    // 和弦根音
    'E/Bb': 'Eb/Bb',
    'A/Eb': 'Ab/Eb',
  },

  // Ab 调（4♭：Bb, Eb, Ab, Db）
  'Ab': {
    // Slash 低音
    'A/C': 'Ab/C',
    'D/F': 'Db/F',

    // 和弦根音
    'A/Eb': 'Ab/Eb',
    'D/Ab': 'Db/Ab',
  },

  // Db 调（5♭：Bb, Eb, Ab, Db, Gb）
  'Db': {
    // Slash 低音
    'G/B': 'Gb/Bb',
    'D/F': 'Db/F',

    // 和弦根音
    'G/Db': 'Gb/Db',
    'C/F': 'Cb/F',
  },

  // Gb 调（6♭：Bb, Eb, Ab, Db, Gb, Cb）
  'Gb': {
    // Slash 低音
    'G/B': 'Gb/Bb',
    'C/E': 'Cb/Eb',

    // 和弦根音
    'G/Db': 'Gb/Db',
    'C/Gb': 'Cb/Gb',
  },

  // Cb 调（7♭，实际很少用，通常用B调代替）
  'Cb': {
    'G/B': 'Gb/Bb',
    'C/E': 'Cb/Eb',
  },
};

// 斜杠和弦颠倒修复映射表
// 用于修复AI识别时将根音和低音颠倒的情况
// 注意：只包含最常见的颠倒错误，避免误修正
const SLASH_CHORD_REVERSAL_CORRECTIONS: Record<string, string> = {
  // 常见斜杠和弦的颠倒修正
  // 格式：'错误识别' -> '正确和弦'
  // 原则：保留更常见的和弦形式
  
  // 大三和弦斜杠（低音在转位中更常见）
  'E/C': 'C/E',
  'F/C#': 'C#/F',
  'F/Db': 'Db/F',
  'F#/D': 'D/F#',
  'G/Eb': 'Eb/G',
  'G#/E': 'E/G#',
  'A/F': 'F/A',
  'A#/F#': 'F#/A#',
  'B/G': 'G/B',
  'C/Ab': 'Ab/C',
  'C#/A': 'A/C#',
  'D/Bb': 'Bb/D',
  'D#/B': 'B/D#'
};

export interface Chord {
  root: string;        // 根音，如 'C', 'G#'
  quality: ChordQuality; // 和弦性质，如 '', 'm', 'maj7'
  bass?: string;       // 转位低音，如 'E' (表示 C/E)
  x?: number;          // 图片中的 x 坐标（百分比，0-100）
  y?: number;          // 图片中的 y 坐标（百分比，0-100）
  hasParentheses?: boolean; // 是否用括号包围（如 (D), (D/F#)）
  hasLeftParentheses?: boolean; // 是否有左括号
  hasRightParentheses?: boolean; // 是否有右括号
}

export interface TransposeResult {
  originalKey: string;
  targetKey: string;
  semitones: number;
  chords: {
    original: Chord;
    transposed: Chord;
  }[];
}

// 12个调的音阶
export const CHROMATIC_SCALE = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
];

// 调性音阶映射表（基于自然音根音）
const KEY_SCALE_MAP: Record<string, { major: string[]; minor: string[]; harmonicMinor: string[] }> = {
  'C': {
    major: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],                    // C大调
    minor: ['C', 'D', 'Eb', 'F', 'G', 'Ab', 'Bb'],                // C自然小调
    harmonicMinor: ['C', 'D', 'Eb', 'F', 'G', 'Ab', 'B'],         // C和声小调（第七级音B）
  },
  'D': {
    major: ['D', 'E', 'F#', 'G', 'A', 'B', 'C#'],                 // D大调
    minor: ['D', 'E', 'F', 'G', 'A', 'Bb', 'C'],                  // D自然小调
    harmonicMinor: ['D', 'E', 'F', 'G', 'A', 'Bb', 'C#'],         // D和声小调（第七级音C#）
  },
  'E': {
    major: ['E', 'F#', 'G#', 'A', 'B', 'C#', 'D#'],              // E大调
    minor: ['E', 'F#', 'G', 'A', 'B', 'C', 'D'],                   // E自然小调
    harmonicMinor: ['E', 'F#', 'G', 'A', 'B', 'C', 'D#'],          // E和声小调（第七级音D#）
  },
  'F': {
    major: ['F', 'G', 'A', 'Bb', 'C', 'D', 'E'],                  // F大调
    minor: ['F', 'G', 'Ab', 'Bb', 'C', 'Db', 'Eb'],               // F自然小调
    harmonicMinor: ['F', 'G', 'Ab', 'Bb', 'C', 'Db', 'E'],        // F和声小调（第七级音E）
  },
  'G': {
    major: ['G', 'A', 'B', 'C', 'D', 'E', 'F#'],                  // G大调
    minor: ['G', 'A', 'Bb', 'C', 'D', 'Eb', 'F'],                 // G自然小调
    harmonicMinor: ['G', 'A', 'Bb', 'C', 'D', 'Eb', 'F#'],        // G和声小调（第七级音F#）
  },
  'A': {
    major: ['A', 'B', 'C#', 'D', 'E', 'F#', 'G#'],                // A大调
    minor: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],                   // A自然小调
    harmonicMinor: ['A', 'B', 'C', 'D', 'E', 'F', 'G#'],          // A和声小调（第七级音G#）
  },
  'B': {
    major: ['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#'],              // B大调
    minor: ['B', 'C#', 'D', 'E', 'F#', 'G', 'A'],                  // B自然小调
    harmonicMinor: ['B', 'C#', 'D', 'E', 'F#', 'G', 'A#'],         // B和声小调（第七级音A#）
  },
};

// 等音转换映射（根据用户要求）
// D# → bE, A# → bB
// 注意：键值都是规范化的形式（大写字母，# 在字母后）
export const ENHARMONIC_MAP: Record<string, string> = {
  'C#': 'Db',
  'D#': 'Eb',
  'F#': 'Gb',
  'G#': 'Ab',
  'A#': 'Bb',
  // 反向映射
  'Db': 'C#',
  'Eb': 'D#',
  'Gb': 'F#',
  'Ab': 'G#',
  'Bb': 'A#',
};

// 和弦识别正则表达式（支持升降号在前/后）
// 匹配：C, C#, #C, D, D/F#, G7sus4, Am7, A7sus4, Asus4 等
// 修正：低音部分使用三个独立的匹配组，避免丢失升降号
const CHORD_REGEX = /^([#b]?)([A-G])([#b]?)([a-z0-9]*)?(?:\/([#b]?)([A-G])([#b]?))?$/i;

class ChordTransposer {
  /**
   * 判断和弦是大和弦还是小和弦
   * @param quality 和弦性质
   * @returns 'major' 或 'minor'
   */
  private getChordType(quality: ChordQuality): 'major' | 'minor' {
    const q = quality.toLowerCase();
    
    // 小三和弦和包含小字样的和弦都是小和弦
    if (q === 'm' || q === 'min' || q.startsWith('m') || q.startsWith('min')) {
      return 'minor';
    }
    
    // 大三和弦、大七和弦等都是大和弦
    if (q === '' || q === 'maj' || q === 'major' || q.startsWith('maj7') || q.startsWith('7') || q.startsWith('9') || q.startsWith('11') || q.startsWith('13') || q.startsWith('6') || q.startsWith('sus') || q.startsWith('add') || q === 'aug' || q === 'dim') {
      return 'major';
    }
    
    // 默认为大和弦
    return 'major';
  }

  /**
   * 计算低音与根音的半音距离
   * @param root 根音（任意形式，会在内部规范化）
   * @param bass 低音（任意形式，会在内部规范化）
   * @returns 半音数（0-11）
   */
  private getIntervalFromRoot(root: string, bass: string): number {
    // 先将音符规范化为升号形式
    const normalizedRoot = this.normalizeToSharp(root);
    const normalizedBass = this.normalizeToSharp(bass);
    
    const rootIndex = CHROMATIC_SCALE.indexOf(normalizedRoot);
    const bassIndex = CHROMATIC_SCALE.indexOf(normalizedBass);
    
    if (rootIndex === -1 || bassIndex === -1) {
      console.warn(`无法计算音程：root=${root} (${normalizedRoot}), bass=${bass} (${normalizedBass})`);
      return 0;
    }
    
    const interval = ((bassIndex - rootIndex) % 12 + 12) % 12;
    return interval;
  }

  /**
   * 判断根音是自然音还是升降号音
   * @param note 音符
   * @returns 'natural'（自然音）、'sharp'（升号音）、'flat'（降号音）
   */
  private getNoteType(note: string): 'natural' | 'sharp' | 'flat' {
    if (note.includes('#')) {
      return 'sharp';
    } else if (note.includes('b')) {
      return 'flat';
    } else {
      return 'natural';
    }
  }

  /**
   * 规范化音符为升号形式（用于内部处理）
   * 如 bB -> A#, bE -> D#, Bb -> A#, #F -> F#
   * 同时将小写字母转换为大写
   * 注意：只处理有效的音符（单个字母 + 可选升降号），其他字符会被忽略
   */
  private normalizeToSharp(note: string): string {
    // 处理极端音记：E# → F, Fb → E, B# → C, Cb → B
    const extremeNoteMap: Record<string, string> = {
      'E#': 'F', 'Fb': 'E',
      'B#': 'C', 'Cb': 'B',
      // 同时支持小写形式
      'e#': 'F', 'fb': 'E',
      'b#': 'C', 'cb': 'B',
    };
    if (extremeNoteMap[note]) {
      return extremeNoteMap[note];
    }

    // 严格匹配：只能是单个音符字母 + 可选的单个升降号
    // 不匹配包含其他字符的情况（如 "Bd" 中的 "d" 不是升降号）
    const strictMatch = note.match(/^([b#]?)([A-Ga-g])([b#]?)$/);
    if (strictMatch) {
      const [, accFront, root, accBack] = strictMatch;
      // 合并升降号（优先使用前面的），并转换为大写
      let normalized: string;
      if (accFront) {
        normalized = root.toUpperCase() + accFront; // #F -> F#, bE -> Eb, #f -> F#
      } else {
        normalized = root.toUpperCase() + (accBack || ''); // F# -> F#, C -> C, f# -> F#
      }
      
      // 检查是否已经是升号或基本音
      if (CHROMATIC_SCALE.includes(normalized)) {
        return normalized;
      }

      // 将降号转换为升号
      return ENHARMONIC_MAP[normalized] || normalized;
    }

    // 如果不是有效的音符格式，直接返回原值（大写化）
    // 这样可以让后续处理发现错误
    console.warn(`normalizeToSharp: 无效的音符格式 "${note}"，期望格式为 [b#]?[A-G][b#]?`);
    return note.toUpperCase();
  }

  /**
   * 修正视觉识别错误（连音线干扰导致的误识别）
   * @param chordString 和弦字符串
   * @param originalKey 原调
   * @param isFastMode 是否快速模式（快速模式下应用额外的修正规则）
   * @returns 修正后的和弦字符串
   */
  correctChordByVisionError(chordString: string, originalKey: string, isFastMode: boolean = true): string {
    if (!chordString) return chordString;

    let corrected = chordString.trim();

    // 步骤1：无条件修正（不依赖原调）
    // #Em、E#m → F#m 等（F容易被识别为E）
    const unconditionalCorrections = VISION_ERROR_CORRECTIONS.unconditional;
    if (unconditionalCorrections[corrected]) {
      console.log(`  🔧 视觉修正(无条件): ${corrected} → ${unconditionalCorrections[corrected]}`);
      return unconditionalCorrections[corrected];
    }

    // 步骤2：根据原调进行修正（始终应用）
    const normalizedKey = this.normalizeKey(originalKey);
    const keyCorrections = VISION_ERROR_CORRECTIONS.byKey[normalizedKey];

    if (keyCorrections && keyCorrections[corrected]) {
      console.log(`  🔧 视觉修正(${normalizedKey}调): ${corrected} → ${keyCorrections[corrected]}`);
      return keyCorrections[corrected];
    }

    // 步骤3：快速模式专用的修正规则（深度思考模式不应用）
    if (isFastMode) {
      const fastModeCorrections = VISION_ERROR_CORRECTIONS.fastModeOnly[normalizedKey];
      if (fastModeCorrections && fastModeCorrections[corrected]) {
        console.log(`  🔧 视觉修正(快速模式,${normalizedKey}调): ${corrected} → ${fastModeCorrections[corrected]}`);
        return fastModeCorrections[corrected];
      }
    }

    return corrected;
  }

  /**
   * F调特殊处理：将 B 相关和弦修正为 Bb
   * F调有一个降号（Bb），AI容易漏识别 B 前面的降号
   * 
   * 修正规则（仅处理以下三种情况）：
   * - B → Bb（纯 B 大三和弦）
   * - Bm → Bbm（纯 B 小三和弦，不包括 Bm7、Bm9 等）
   * - Bmaj... → Bbmaj...（B 大和弦系列，如 Bmaj7, Bmaj9, Bmaj 等）
   * 
   * 不修正的情况：
   * - Bdim, Bm7(b5), Bm7, B7 等（这些在 F 调中可能是合理的和弦）
   * - 斜杠和弦的低音部分（如 G/B 是正确的）
   * 
   * @param chordString 和弦字符串
   * @returns 修正后的和弦字符串
   */
  private correctBToBbInFKey(chordString: string): string {
    if (!chordString) return chordString;

    // 只处理根音部分（斜杠前的部分）
    const slashIndex = chordString.indexOf('/');
    const rootPart = slashIndex === -1 ? chordString : chordString.substring(0, slashIndex);
    const bassPart = slashIndex === -1 ? '' : chordString.substring(slashIndex);

    let correctedRoot = rootPart;

    // 情况1：纯 B → Bb
    if (rootPart === 'B') {
      correctedRoot = 'Bb';
    }
    // 情况2：纯 Bm → Bbm
    else if (rootPart === 'Bm') {
      correctedRoot = 'Bbm';
    }
    // 情况3：Bmaj... → Bbmaj...（大和弦系列，后面可以有数字如 Bmaj7, Bmaj9）
    else if (/^Bmaj/.test(rootPart)) {
      correctedRoot = 'Bb' + rootPart.substring(1);
    }
    // 情况4：Bsus... → Bbsus...（挂留和弦系列，如 Bsus2, Bsus4）
    else if (/^Bsus/.test(rootPart)) {
      correctedRoot = 'Bb' + rootPart.substring(1);
    }

    const corrected = correctedRoot + bassPart;

    if (corrected !== chordString) {
      console.log(`  🔧 F调B→Bb修正: ${chordString} → ${corrected}`);
    }

    return corrected;
  }

  /**
   * 根据原调修正和弦字符串（OCR修正）
   * 用于修正AI识别时遗漏的升降号
   * @param chordString 原始和弦字符串
   * @param originalKey 原调
   * @param isFastMode 是否快速模式
   * @returns 修正后的和弦字符串
   */
  correctChordByKey(chordString: string | undefined | null, originalKey: string, isFastMode: boolean = true): string {
    // 防御性检查
    if (!chordString) return '';

    // 规范化和弦字符串
    let corrected = chordString.trim();

    // 步骤1：先进行视觉错误修正（连音线干扰等）
    corrected = this.correctChordByVisionError(corrected, originalKey, isFastMode);

    // 转换上标数字为普通数字（AI可能识别出上标字符）
    const superscriptMap: Record<string, string> = {
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
      '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    };
    for (const [sup, normal] of Object.entries(superscriptMap)) {
      corrected = corrected.replace(new RegExp(sup, 'g'), normal);
    }

    // 保存括号状态（支持单侧括号）
    let hasLeftParentheses = corrected.startsWith('(') || corrected.startsWith('（');
    let hasRightParentheses = corrected.endsWith(')') || corrected.endsWith('）');

    // 去除括号以便处理
    if (hasLeftParentheses) {
      corrected = corrected.slice(1);
    }
    if (hasRightParentheses) {
      corrected = corrected.slice(0, -1);
    }

    // 规范化原调（去掉"调"字等后缀）
    const normalizedKey = this.normalizeKey(originalKey);

    // 检查OCR修正库中是否有针对这个原调的修正规则
    const corrections = OCR_CORRECTION_LIBRARY[normalizedKey];
    if (corrections) {
      // 检查和弦是否在修正库中
      const replacement = corrections[corrected];
      if (replacement) {
        corrected = replacement;
      }
    }

    // F调特殊处理：B → Bb（AI容易漏识别降号）
    // F调有一个降号（Bb），所以 B 相关的和弦应该变成 Bb
    if (normalizedKey === 'F') {
      corrected = this.correctBToBbInFKey(corrected);
    }

    // 检查斜杠和弦颠倒修复库
    if (SLASH_CHORD_REVERSAL_CORRECTIONS[corrected]) {
      console.log(`  🔧 斜杠和弦颠倒修正: ${corrected} → ${SLASH_CHORD_REVERSAL_CORRECTIONS[corrected]}`);
      corrected = SLASH_CHORD_REVERSAL_CORRECTIONS[corrected];
    }

    // 恢复括号
    if (hasLeftParentheses) {
      corrected = '(' + corrected;
    }
    if (hasRightParentheses) {
      corrected = corrected + ')';
    }

    return corrected;
  }

  /**
   * 按"或"字分割和弦文本，正确处理括号
   * 用于处理AI识别结果中包含"或"字的和弦（如 "Em或E"、"(Em或E)"）
   * 
   * 括号分配规则：
   * - 如果整体文本有左括号，分配给第一个子和弦
   * - 如果整体文本有右括号，分配给最后一个子和弦
   * 
   * 示例：
   * - "(Em或E)" → ["(Em", "E)"]
   * - "(Em或E" → ["(Em", "E"]
   * - "Em或E)" → ["Em", "E)"]
   * - "Em或E" → ["Em", "E"]
   * 
   * @param text 包含"或"字的和弦文本
   * @returns 分割后的和弦数组
   */
  splitByOr(text: string): string[] {
    if (!text || !text.includes('或')) {
      return text ? [text.trim()] : [];
    }

    // 检查整体的括号状态
    const hasLeftParentheses = text.startsWith('(') || text.startsWith('（');
    const hasRightParentheses = text.endsWith(')') || text.endsWith('）');

    // 去除整体括号
    let processedText = text;
    if (hasLeftParentheses) {
      processedText = processedText.slice(1);
    }
    if (hasRightParentheses) {
      processedText = processedText.slice(0, -1);
    }

    // 按"或"字分割
    const parts = processedText.split('或').map((s: string) => s.trim()).filter((s: string) => s.length > 0);

    // 如果只有一个部分，且原来有括号，恢复括号
    if (parts.length === 1) {
      if (hasLeftParentheses) {
        parts[0] = '(' + parts[0];
      }
      if (hasRightParentheses) {
        parts[0] = parts[0] + ')';
      }
      return parts;
    }

    // 如果有多个部分，分配括号
    if (parts.length > 1) {
      // 第一个部分：如果有左括号，添加左括号
      if (hasLeftParentheses) {
        parts[0] = '(' + parts[0];
      }

      // 最后一个部分：如果有右括号，添加右括号
      if (hasRightParentheses) {
        parts[parts.length - 1] = parts[parts.length - 1] + ')';
      }
    }

    return parts;
  }

  /**
   * 解析和弦字符串（宽松模式）
   * @param chordString 和弦字符串，如 "C", "Am7", "Gsus4", "C/E", "Em7(b5)", "Cmaj7(#11)"
   * 策略：提取第一个大写字母（根音），保留后面所有内容作为修饰符
   */
  parseChord(chordString: string): Chord | null {
    let trimmed = chordString.trim();

    // 转换上标数字为普通数字（AI可能识别出上标字符）
    const superscriptMap: Record<string, string> = {
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
      '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    };
    for (const [sup, normal] of Object.entries(superscriptMap)) {
      trimmed = trimmed.replace(new RegExp(sup, 'g'), normal);
    }

    // 检测并去除全角和半角括号（支持单侧括号），并记录原始括号状态
    let hasParentheses = false;
    let hasLeftParentheses = false;
    let hasRightParentheses = false;

    // 检查左括号
    if (trimmed.startsWith('(') || trimmed.startsWith('（')) {
      hasLeftParentheses = true;
      trimmed = trimmed.slice(1).trim();
    }

    // 检查右括号
    if (trimmed.endsWith(')') || trimmed.endsWith('）')) {
      hasRightParentheses = true;
      trimmed = trimmed.slice(0, -1).trim();
    }

    // 如果有任一侧括号，则认为有括号
    hasParentheses = hasLeftParentheses || hasRightParentheses;

    // 尝试去除重复记号后缀（D.S.al.Fine., Fine. 等）
    const suffixes = ['D.S.al.Fine.', 'Fine.'];
    for (const suffix of suffixes) {
      if (trimmed.endsWith(suffix)) {
        trimmed = trimmed.slice(0, -suffix.length).trim();
        if (!trimmed) {
          return null;
        }
      }
    }

    // 去除可能存在的点号（例如 "C." → "C"）
    if (trimmed.endsWith('.') && trimmed.length > 1) {
      trimmed = trimmed.slice(0, -1);
    }

    // 特殊处理：以斜杠开头的情况（如 "/C#"）
    if (trimmed.startsWith('/')) {
      // 不使用 i 标志，手动处理大写转换
      const bassMatch = trimmed.match(/^\/([#b]?)([A-G])([#b]?)$/);
      if (bassMatch) {
        const [, bassAccFront, bassLetter, bassAccBack] = bassMatch;
        // 合并升降号，确保大写
        let rawBass: string;
        if (bassAccFront) {
          rawBass = bassLetter.toUpperCase() + bassAccFront;
        } else {
          rawBass = bassLetter.toUpperCase() + (bassAccBack || '');
        }
        const bass = this.normalizeToSharp(rawBass);
        return {
          root: bass,
          quality: '' as ChordQuality,
          bass: undefined,
          hasParentheses,
          hasLeftParentheses,
          hasRightParentheses,
          slashOnly: true,
        } as Chord & { slashOnly: boolean };
      }
    }

    // 宽松解析：提取根音（大写字母 A-G，升降号可以在前或后）
    // 支持格式：#C, bE, C#, Eb, Cm7, F#m7, Gm7(b5) 等
    // 注意：不使用 i 标志，因为 [A-G] 在 i 模式下会匹配小写 d（在 a-g 范围内）
    // 这会导致 Bdim 被错误解析为 rootPart="Bd", rest="im"
    const looseMatch = trimmed.match(/^([#b]?)([A-G])([#b]?)(.*)$/);
    if (!looseMatch) {
      return null;
    }

    const [, accFront, rootLetter, accBack, rest] = looseMatch;

    // 合并升降号（优先使用前面的），并确保根音大写
    let rawRoot: string;
    if (accFront) {
      rawRoot = rootLetter.toUpperCase() + accFront; // #f -> F#, bE -> Eb
    } else {
      rawRoot = rootLetter.toUpperCase() + (accBack || ''); // F# -> F#, C -> C
    }

    const normalizedRoot = this.normalizeToSharp(rawRoot);

    // 保留所有后续内容作为修饰符
    let quality = rest.trim() as ChordQuality;

    // 检查是否有斜杠（转位低音）
    // 注意：斜杠后面必须是音符（A-G）才当作低音处理，否则保留在 quality 中
    // 例如：G6/9 → quality="G6/9"（/9不是低音），G/B → quality="G", bass="B"
    // 不使用 i 标志，避免小写字母被误匹配
    const slashMatch = rest.match(/^(.*?)(\/[#b]?[A-G][#b]?)$/);
    let bass: string | undefined;
    if (slashMatch) {
      quality = slashMatch[1].trim() as ChordQuality;
      const bassPart = slashMatch[2].trim();
      // 提取低音的根音（同样支持升降号在前或后）
      // 不使用 i 标志，手动处理大写转换
      const bassMatch = bassPart.match(/^\/([#b]?)([A-G])([#b]?)$/);
      if (bassMatch) {
        const [, bassAccFront, bassLetter, bassAccBack] = bassMatch;
        // 合并升降号，确保大写
        let rawBass: string;
        if (bassAccFront) {
          rawBass = bassLetter.toUpperCase() + bassAccFront;
        } else {
          rawBass = bassLetter.toUpperCase() + (bassAccBack || '');
        }
        bass = this.normalizeToSharp(rawBass);
      }
    }

    const chord: Chord = {
      root: normalizedRoot,
      quality,
      bass,
      hasParentheses,
      hasLeftParentheses,
      hasRightParentheses,
    };

    return chord;
  }

  /**
   * 强制将升号转换为降号（D#→Eb, A#→Bb, G#→Ab, C#→Db, F#→Gb）
   * @param note 音符
   */
  private forceToFlat(note: string): string {
    const forcedMap: Record<string, string> = {
      'C#': 'Db',
      'D#': 'Eb',
      'F#': 'Gb',
      'G#': 'Ab',
      'A#': 'Bb',
    };
    return forcedMap[note] || note;
  }

  /**
   * 将和弦转换为字符串
   * @param chord 和弦对象
   * @param useFlats 是否使用降号形式（如 Eb 代替 D#），默认为 false
   */
  chordToString(chord: Chord, useFlats: boolean = false): string {
    // 特殊处理：只有斜杠和低音的情况（如 "/C#"）
    if ((chord as any).slashOnly) {
      let root = this.normalizeToSharp(chord.root);
      if (useFlats) {
        root = this.forceToFlat(root);
      }
      let result = '/' + root;
      // 根据原始括号状态添加括号
      if (chord.hasLeftParentheses) {
        result = '(' + result;
      }
      if (chord.hasRightParentheses) {
        result = result + ')';
      }
      return result;
    }

    // 规范化根音和低音（防止不规范写法如 bB）
    let root = this.normalizeToSharp(chord.root);
    let bass = chord.bass ? this.normalizeToSharp(chord.bass) : undefined;

    // 如果使用降号形式，将 D# → Eb, A# → Bb
    if (useFlats) {
      root = this.forceToFlat(root);
      if (bass) {
        bass = this.forceToFlat(bass);
      }
    }

    let result = root + chord.quality;
    if (bass) {
      result += '/' + bass;
    }
    // 根据原始括号状态添加括号
    if (chord.hasLeftParentheses) {
      result = '(' + result;
    }
    if (chord.hasRightParentheses) {
      result = result + ')';
    }
    return result;
  }

  /**
   * 转换和弦为字符串，支持分别指定根音和低音的升降号形式
   * 用于正确处理斜杠复合和弦（如 Ab/Eb）
   * @param chord 和弦对象
   * @param rootUseFlats 根音（斜杠前和弦）是否使用降号形式（根据目标调决定）
   * @param bassUseFlats 低音（斜杠后和弦）是否使用降号形式（根据主和弦所在的调决定）
   */
  chordToStringWithBassMode(chord: Chord, rootUseFlats: boolean, bassUseFlats: boolean): string {
    // 简化逻辑：直接使用 chord 对象的值，不做复杂的转换
    // 因为 chord.root 和 chord.bass 已经在转调阶段正确转换
    let root = chord.root;
    let bass = chord.bass;
    
    // 简单规范化：将小写升降号转换为大写（如 bB → Bb）
    // 正则表达式：匹配前面的 b 后面跟一个大写字母
    root = root.replace(/^b([A-Z])/, 'B$1');
    if (bass) {
      bass = bass.replace(/^b([A-Z])/, 'B$1');
    }
    
    let result = root + chord.quality;
    if (bass) {
      result += '/' + bass;
    }
    // 根据原始括号状态添加括号
    if (chord.hasLeftParentheses) {
      result = '(' + result;
    }
    if (chord.hasRightParentheses) {
      result = result + ')';
    }
    return result;
  }

  /**
   * 在音阶中移动半音数
   * @param note 音符，如 'C', 'G#', 'Bb'
   * @param semitones 半音数，正数表示升高，负数表示降低
   */
  shiftNote(note: string, semitones: number): string {
    // 将输入音符规范化为升号形式以查找索引
    const normalizedNote = this.normalizeToSharp(note);
    const index = CHROMATIC_SCALE.findIndex(n => n === normalizedNote);

    if (index === -1) {
      console.warn(`无法找到音符索引: ${note} (规范化后: ${normalizedNote})`);
      return note;
    }

    // 计算新索引（简单的 index + semitones 即可，因为有负数处理）
    const newIndex = ((index + semitones) % 12 + 12) % 12;
    let newNote = CHROMATIC_SCALE[newIndex];

    return newNote;
  }

  /**
   * 转调单个和弦
   * @param chord 和弦对象
   * @param semitones 半音数
   * @param useFlats 是否使用降号形式（如 Eb 代替 D#）
   */
  transposeChord(chord: Chord, semitones: number, useFlats: boolean = false): Chord {
    // 先规范化原始根音和低音（确保升降号在字母后面，如 bB → Bb）
    const normalizedOriginalRoot = this.normalizeToSharp(chord.root);
    const normalizedOriginalBass = chord.bass ? this.normalizeToSharp(chord.bass) : undefined;
    
    let newRoot = this.shiftNote(normalizedOriginalRoot, semitones);
    let newBass = normalizedOriginalBass ? this.shiftNote(normalizedOriginalBass, semitones) : undefined;

    //console.log(`🔄 转调和弦: ${this.chordToString(chord, useFlats)} → 半音数: ${semitones}`);
    //console.log(`  原根音: ${normalizedOriginalRoot} → 新根音: ${newRoot}`);
    //if (chord.bass) {
      //console.log(`  原低音: ${normalizedOriginalBass} → 新低音: ${newBass}`);
    //}

    // 根音的记法由目标调决定（useFlats参数）
    if (useFlats && newRoot) {
      // 只转换升号到降号，不转换已经降号的音符
      const sharpToFlatMap: Record<string, string> = {
        'C#': 'Db',
        'D#': 'Eb',
        'F#': 'Gb',
        'G#': 'Ab',
        'A#': 'Bb',
      };
      const mappedRoot = sharpToFlatMap[newRoot];
      if (mappedRoot) {
        newRoot = mappedRoot;
      }
    }

    // 低音的记法由斜杠前和弦的根音特性和和弦类型决定，不受目标调影响
    if (newBass) {
      // 1. 判断转调后的根音类型（自然音/升号音/降号音）
      const rootType = this.getNoteType(newRoot);
      
      // 2. 判断和弦类型（大/小）
      const chordType = this.getChordType(chord.quality);
      
      // 3. 应用升降号规则
      if (rootType === 'sharp') {
        // 根音是升号音 → 低音与根音保持一致（全部使用升号）
        const flatToSharpMap: Record<string, string> = {
          'Db': 'C#',
          'Eb': 'D#',
          'Gb': 'F#',
          'Ab': 'G#',
          'Bb': 'A#',
        };
        const mappedBass = flatToSharpMap[newBass];
        if (mappedBass) {
          newBass = mappedBass;
        }
      } else if (rootType === 'flat') {
        // 根音是降号音 → 低音与根音保持一致（全部使用降号）
        const sharpToFlatMap: Record<string, string> = {
          'C#': 'Db',
          'D#': 'Eb',
          'F#': 'Gb',
          'G#': 'Ab',
          'A#': 'Bb',
        };
        const mappedBass = sharpToFlatMap[newBass];
        if (mappedBass) {
          newBass = mappedBass;
        }
      } else {
        // 根音是自然音（C、D、E、F、G、A、B）
        // 根据和弦类型获取目标调性音阶
        const targetScale = KEY_SCALE_MAP[newRoot];
        if (targetScale) {
          let scale: string[];
          
          if (chordType === 'major') {
            // 大和弦 → 使用大调音阶
            scale = targetScale.major;
          } else {
            // 小和弦 → 检查低音是否在自然小调或和声小调中
            // 因为相邻的两个音必定最多有一个带升降号，所以能唯一确定升降号的使用方式
            if (targetScale.minor.includes(newBass)) {
              // 低音在自然小调音阶中
              scale = targetScale.minor;
            } else if (targetScale.harmonicMinor.includes(newBass)) {
              // 低音在和声小调音阶中
              scale = targetScale.harmonicMinor;
            } else {
              // 低音不在两个音阶中，使用自然小调作为默认
              scale = targetScale.minor;
            }
          }
          
          // 检查低音是否在目标调性音阶中
          if (scale.includes(newBass)) {
            // 低音在调性音阶中 → 保持原样
            // 不做任何转换
          } else {
            // 低音不在调性音阶中 → 需要转换
            // 判断调性音阶使用升号还是降号
            const hasSharps = scale.some(note => note.includes('#'));
            const hasFlats = scale.some(note => note.includes('b'));
            
            if (hasFlats && !hasSharps) {
              // 调性使用降号 → 转换升号到降号
              const sharpToFlatMap: Record<string, string> = {
                'C#': 'Db',
                'D#': 'Eb',
                'F#': 'Gb',
                'G#': 'Ab',
                'A#': 'Bb',
              };
              const mappedBass = sharpToFlatMap[newBass];
              if (mappedBass) {
                newBass = mappedBass;
              }
            } else if (hasSharps && !hasFlats) {
              // 调性使用升号 → 转换降号到升号
              const flatToSharpMap: Record<string, string> = {
                'Db': 'C#',
                'Eb': 'D#',
                'Gb': 'F#',
                'Ab': 'G#',
                'Bb': 'A#',
              };
              const mappedBass = flatToSharpMap[newBass];
              if (mappedBass) {
                newBass = mappedBass;
              }
            }
            // 如果调性既有升号又有降号（极少情况），保持原样
          }
        }
      }
    }

    return {
      root: newRoot,
      quality: chord.quality,
      bass: newBass,
      x: chord.x,
      y: chord.y,
      hasParentheses: chord.hasParentheses, // 保留括号标记
      hasLeftParentheses: chord.hasLeftParentheses, // 保留左括号标记
      hasRightParentheses: chord.hasRightParentheses, // 保留右括号标记
      slashOnly: (chord as any).slashOnly, // 保留 slashOnly 标记
    } as Chord & { slashOnly?: boolean };
  }

  /**
   * 计算两个调之间的半音数
   * @param fromKey 原调
   * @param toKey 目标调
   */
  calculateSemitones(fromKey: string, toKey: string): number {
    // 规范化调号为升号形式
    const normalizedFrom = this.normalizeToSharp(fromKey);
    const normalizedTo = this.normalizeToSharp(toKey);

    const fromIndex = CHROMATIC_SCALE.findIndex(k => k === normalizedFrom);
    const toIndex = CHROMATIC_SCALE.findIndex(k => k === normalizedTo);

    if (fromIndex === -1 || toIndex === -1) {
      throw new Error(`Invalid key: ${fromKey} (${normalizedFrom}) or ${toKey} (${normalizedTo})`);
    }

    return ((toIndex - fromIndex) % 12 + 12) % 12;
  }

  /**
   * 批量转调和弦
   * @param chords 和弦列表
   * @param originalKey 原调
   * @param targetKey 目标调
   * @param useEnharmonic 是否使用等音
   */
  transposeChords(
    chords: Chord[],
    originalKey: string,
    targetKey: string,
    useEnharmonic: boolean = true
  ): TransposeResult {
    const semitones = this.calculateSemitones(originalKey, targetKey);

    // 根据目标调性决定是否使用降号形式
    // 直接使用用户传入的 targetKey，不要规范化，否则 'Ab' 会被转为 'G#' 导致判断错误
    // 降号调：C, F, Bb, Eb, Ab, Db, Gb
    // 注意：Cb不是降号调，它是B调的等音调（Cb = B），B是升号调（5#）
    const flatKeys = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const shouldUseFlats = flatKeys.includes(targetKey);

    return {
      originalKey,
      targetKey,
      semitones,
      chords: chords.map(chord => {
        const transposed = this.transposeChord(chord, semitones, shouldUseFlats);
        // 不再修正不可能的和弦，因为小二度也可能出现
        return {
          original: chord,
          transposed: transposed,
        };
      }),
    };
  }

  /**
   * 批量转调和弦（根据半音数）
   * @param chords 和弦列表
   * @param originalKey 原调
   * @param semitones 半音数（正数表示升，负数表示降）
   * @param useEnharmonic 是否使用等音（废弃，参数保留以兼容）
   * @param userTargetKey 用户指定的目标调（可选，用于覆盖计算的目标调）
   */
  transposeChordsBySemitones(
    chords: Chord[],
    originalKey: string,
    semitones: number,
    useEnharmonic: boolean = true,
    userTargetKey?: string
  ): TransposeResult {
    // 规范化原调为升号形式
    const normalizedOriginal = this.normalizeToSharp(originalKey);

    // 计算目标调
    const originalIndex = CHROMATIC_SCALE.findIndex(k => k === normalizedOriginal);
    const targetIndex = ((originalIndex + semitones) % 12 + 12) % 12;
    let targetKeyCalculated = CHROMATIC_SCALE[targetIndex];

    // 如果用户指定了目标调，使用用户选择的（优先于计算值）
    const targetKeyToUse = userTargetKey || targetKeyCalculated;

    // 根据目标调决定是否使用降号形式
    // 降号调：C, F, Bb, Eb, Ab, Db, Gb
    // 注意：Cb不是降号调，它是B调的等音调（Cb = B），B是升号调（5#）
    const flatKeys = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const shouldUseFlats = flatKeys.includes(targetKeyToUse);

    return {
      originalKey,
      targetKey: targetKeyToUse,
      semitones,
      chords: chords.map(chord => {
        const transposed = this.transposeChord(chord, semitones, shouldUseFlats);
        // 不再修正不可能的和弦，因为小二度也可能出现
        return {
          original: chord,
          transposed: transposed,
        };
      }),
    };
  }

  /**
   * 规范化调号（转换为标准格式）
   */
  normalizeKey(key: string): string {
    const trimmed = key.trim(); // 去除强制大写转换，保留AI识别的原始大小写信息

    // 处理 1=C 格式（不区分大小写替换前缀）
    if (trimmed.toUpperCase().startsWith('1=')) {
      let result = trimmed.replace(/1=/i, ''); // 使用正则不区分大小写
      return this.normalizeKeyCommonErrors(result);
    }

    // 处理 Key: C 格式
    if (trimmed.toUpperCase().startsWith('KEY:')) {
      let result = trimmed.replace(/KEY:/i, '');
      return this.normalizeKeyCommonErrors(result);
    }

    return this.normalizeKeyCommonErrors(trimmed);
  }

  /**
   * 处理AI识别的常见调号错误
   */
  private normalizeKeyCommonErrors(key: string): string {
    let result = key;

    // 移除所有空格（处理 "B B" → "BB" 或 "B b" → "Bb"）
    result = result.replace(/\s+/g, '');

    // 处理纯音名（C, D, E...）
    if (/^[A-Ga-g]$/.test(result)) {
      // 只有小写c转换为大写C，其他音名保持原样
      // 因为A-G中只有C的大小写长得很像，AI容易误识别
      result = result === 'c' ? 'C' : result;
      return result;
    }

    // 处理降号调的错误识别
    // 这些情况是AI可能把降号识别成的错误格式
    const flatMappings: Record<string, string> = {
      // 标准降号（保持不变，列出来方便调试）
      'Bb': 'Bb', 'Eb': 'Eb', 'Ab': 'Ab', 'Db': 'Db', 'Gb': 'Gb', 'Cb': 'Cb',

      // 小写降号 + 大写音名（AI常见识别错误）
      'bB': 'Bb', 'bE': 'Eb', 'bA': 'Ab', 'bD': 'Db', 'bG': 'Gb', 'bC': 'Cb',
    };

    if (flatMappings[result]) {
      result = flatMappings[result];
    }

    // 处理升号调的错误识别（CC# → C#, FF# → F# 等）
    // 这些情况是AI可能把单个字母识别成了两个相同字母
    const sharpMappings: Record<string, string> = {
      'CC#': 'C#',
      'FF#': 'F#',
      'GG#': 'G#',
      'AA#': 'A#',
      'DD#': 'D#',
    };

    if (sharpMappings[result]) {
      result = sharpMappings[result];
    }

    return result;
  }
}

export const chordTransposer = new ChordTransposer();

// 导出所有可用的调号
export const ALL_KEYS = [
  { value: 'C', label: 'C调' },
  { value: 'D', label: 'D调' },
  { value: 'E', label: 'E调' },
  { value: 'F', label: 'F调' },
  { value: 'G', label: 'G调' },
  { value: 'A', label: 'A调' },
  { value: 'B', label: 'B调' },
  { value: 'Db', label: 'Db调' },
  { value: 'Eb', label: 'Eb调' },
  { value: 'Gb', label: 'Gb调' },
  { value: 'Ab', label: 'Ab调' },
  { value: 'Bb', label: 'Bb调' },
];

/**
 * 规范化音符为升号形式（独立函数，不依赖类实例）
 * @param note 音符（如 'C', 'Db', 'F#', 'Bb'）
 * @returns 升号形式（如 'C', 'C#', 'F#', 'A#'）
 */
export function normalizeNoteToSharp(note: string): string {
  // 处理极端音记
  const extremeNoteMap: Record<string, string> = {
    'E#': 'F', 'Fb': 'E',
    'B#': 'C', 'Cb': 'B',
  };
  if (extremeNoteMap[note]) {
    return extremeNoteMap[note];
  }

  // 规范化升降号位置：升降号在字母前移到字母后
  // 支持 bB、Bb、#F、F# 等格式
  // 手动解析以避免正则表达式 i 标志导致的问题
  let normalized = note;

  // 尝试匹配升降号在前的格式 (#F, bE, bB)
  // 第一个字符必须是 # 或小写 b
  const frontMatch = note.match(/^([#b])([A-Za-z])$/);
  if (frontMatch) {
    normalized = frontMatch[2].toUpperCase() + frontMatch[1]; // #F -> F#, bE -> Eb, bB -> Bb
  } else {
    // 尝试匹配升降号在后的格式 (F#, Eb, Bb)
    // 第二个字符必须是 # 或小写 b
    const backMatch = note.match(/^([A-Za-z])([#b])$/);
    if (backMatch) {
      normalized = backMatch[1].toUpperCase() + backMatch[2]; // F# -> F#, Eb -> Eb, Bb -> Bb
    } else {
      // 尝试匹配纯音名 (C, D, E)
      const simpleMatch = note.match(/^([A-Za-z])$/);
      if (simpleMatch) {
        normalized = simpleMatch[1].toUpperCase(); // C -> C, c -> C
      }
    }
  }

  // 检查是否已经是升号或基本音
  if (CHROMATIC_SCALE.includes(normalized)) {
    return normalized;
  }

  // 将降号转换为升号（使用 ENHARMONIC_MAP）
  const mapped = ENHARMONIC_MAP[normalized];
  if (mapped) {
    return mapped;
  }

  return normalized;
}

/**
 * 获取调号在音阶中的索引
 * @param key 调号（如 'C', 'Db', 'F#'）
 * @returns 索引（0-11），找不到则返回 -1
 */
export function getKeyIndex(key: string): number {
  const normalizedKey = normalizeNoteToSharp(key);
  const index = CHROMATIC_SCALE.findIndex(n => n === normalizedKey);
  return index;
}

/**
 * 判断某个根音所在的大调是升号调还是降号调
 * 用于确定斜杠复合和弦中低音应该使用的升降号形式
 * @param root 根音（如 'Ab', 'G', 'B'）
 * @returns true 表示降号调，false 表示升号调
 */
export function isKeyFlats(root: string): boolean {
  // 将根音规范化为大写形式（保留升降号）
  const normalizedRoot = root.charAt(0).toUpperCase() + root.slice(1);
  
  // 每个根音所在的大调的升降号数量
  // 注意：这里考虑的是该音符作为调号时的升降号数量
  // 对于非常用的升号调（如 D#、G#、A#），它们会转换为对应的降号调（Eb、Ab、Bb）
  const keySignatureMap: Record<string, number> = {
    'C': 0,   // C 大调：0 个升降号（升号调）
    'G': 1,   // G 大调：1 个升号
    'D': 2,   // D 大调：2 个升号
    'A': 3,   // A 大调：3 个升号
    'E': 4,   // E 大调：4 个升号
    'B': 5,   // B 大调：5 个升号
    'F#': 6,  // F# 大调：6 个升号（等音于 Gb）
    'C#': 7,  // C# 大调：7 个升号（等音于 Db）
    'F': -1,  // F 大调：1 个降号
    'Bb': -2, // Bb 大调：2 个降号
    'Eb': -3, // Eb 大调：3 个降号
    'Ab': -4, // Ab 大调：4 个降号
    'Db': -5, // Db 大调：5 个降号
    'Gb': -6, // Gb 大调：6 个降号（等音于 F#）
    'Cb': -7, // Cb 大调：7 个降号（等音于 B）
    // 等音形式（非常用，映射到对应的降号调）
    'D#': -3, // D# 大调 → Eb 大调（3 个降号）
    'G#': -4, // G# 大调 → Ab 大调（4 个降号）
    'A#': -2, // A# 大调 → Bb 大调（2 个降号）
  };
  
  const accidentals = keySignatureMap[normalizedRoot];
  if (accidentals === undefined) {
    console.warn(`未知根音: ${root} (规范化后: ${normalizedRoot})`);
    return false; // 默认返回升号调
  }
  
  // 特殊处理：C 大调视为降号调
  if (normalizedRoot === 'C') {
    return true;
  }
  
  // 降号数量 < 0 为降号调，否则为升号调
  return accidentals < 0;
}

/**
 * 规范化和弦文本中的升降号
 * 将全角符号转换为半角符号：♯ → #, ♭ → b
 * @param chordText 和弦文本
 * @returns 规范化后的和弦文本
 */
export function normalizeAccidentals(chordText: string | undefined | null): string {
  if (!chordText) return '';
  return chordText
    .replace(/♯/g, '#')  // 全角升号 → 半角升号
    .replace(/♭/g, 'b'); // 全角降号 → 半角降号
}
