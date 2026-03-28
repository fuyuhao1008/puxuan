import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ===== 新增：和弦预处理函数 =====

/**
 * 预处理单个和弦符号
 */
function preprocessChord(chord: string, originalKey: string): string {
  let processed = chord;
  
  // 规则1：将 #E 或 E# 替换为 F#（不依赖原调，始终执行）
  processed = processed.replace(/#E|E#/g, 'F#');

  // 只有在有原调的情况下才执行依赖原调的规则
  if (originalKey) {
    const key = originalKey.toUpperCase();

    if (key === 'C' || key === 'D') {
      if (/^B$/.test(processed)) {
        processed = 'D';
      }
    } else if (key === 'F') {
      processed = processed.replace(/^E(?![#b])(?=\/|$)/, 'F');
    }
  }

  return processed;
}

/**
 * 预处理和弦序列
 */
export function preprocessChordSequence(chord: string, originalKey: string): string {
  if (!chord || typeof chord !== 'string') return chord;
  // 直接调用 preprocessChord，内部会处理原调判断
  return preprocessChord(chord, originalKey);
}