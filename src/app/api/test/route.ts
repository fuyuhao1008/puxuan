import { NextRequest, NextResponse } from 'next/server';
import { chordTransposer } from '@/lib/chord-transposer';

/**
 * 测试 API - 用于测试和弦转调和图片标注功能
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { chords, originalKey, targetKey } = body;

    if (!chords || !Array.isArray(chords)) {
      return NextResponse.json({ error: '请提供和弦数组' }, { status: 400 });
    }

    // 解析和弦
    const parsedChords = chords
      .map((c: any) => {
        const parsed = chordTransposer.parseChord(c.text);
        return parsed ? { ...parsed, x: c.x, y: c.y } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // 执行转调
    const transposeResult = chordTransposer.transposeChords(
      parsedChords,
      originalKey || 'C',
      targetKey,
      true
    );

    return NextResponse.json({
      success: true,
      result: transposeResult,
    });
  } catch (error) {
    console.error('测试失败:', error);
    return NextResponse.json({ error: '测试失败' }, { status: 500 });
  }
}
