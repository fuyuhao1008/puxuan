import { NextRequest, NextResponse } from 'next/server';

// 导入和弦转调工具
import { chordTransposer, normalizeNoteToSharp } from '@/lib/chord-transposer';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      chords,
      originalKey,
      targetKey,
      chordColor,
      fontSize,
      imageBase64,
      linePositions,
    } = body;

    // 验证参数
    if (!chords || !Array.isArray(chords)) {
      return NextResponse.json({ error: '缺少和弦数据' }, { status: 400 });
    }
    if (!imageBase64) {
      return NextResponse.json({ error: '缺少图片数据' }, { status: 400 });
    }
    if (!linePositions) {
      return NextResponse.json({ error: '缺少行位置数据' }, { status: 400 });
    }

    // 解析行位置数据
    const newLinePositions: number[] = JSON.parse(linePositions);

    console.log('📍 手动定位：接收到的行位置', newLinePositions);
    console.log('📍 手动定位：和弦数量', chords.length);

    // 根据新的纵坐标调整所有和弦的Y坐标
    // 算法：
    // 1. 将和弦按原来的Y坐标分组到行
    // 2. 为每一行的和弦分配新的Y坐标
    // 3. 同一行内的和弦保持相对位置不变

    // chords 格式: { original: "C", transposed: "D", x: 19, y: 18.72 }
    // 需要转换为: { original: Chord, transposed: Chord(with x,y) }

    // 提取所有和弦的Y坐标
    const chordYs = chords.map((chord: any) => chord.y);

    // 按Y坐标排序（保留原始索引）
    const sortedChords = chords.map((chord: any, index: number) => ({
      ...chord,
      originalIndex: index,
    })).sort((a: any, b: any) => a.y - b.y);

    // 分组：将纵坐标相近的和弦分为同一行
    const lines: Array<{ y: number; chords: any[] }> = [];
    let currentLine = { y: sortedChords[0].y, chords: [sortedChords[0]] };
    const lineHeightThreshold = 1; // 行高阈值（百分比），超过此值认为是新的一行

    for (let i = 1; i < sortedChords.length; i++) {
      const chord = sortedChords[i];
      const diff = Math.abs(chord.y - currentLine.y);

      if (diff < lineHeightThreshold) {
        // 同一行
        currentLine.chords.push(chord);
        // 更新行的平均纵坐标
        currentLine.y = (currentLine.y * currentLine.chords.length + chord.y) / (currentLine.chords.length + 1);
      } else {
        // 新的一行
        lines.push(currentLine);
        currentLine = { y: chord.y, chords: [chord] };
      }
    }
    lines.push(currentLine);

    console.log('📍 手动定位：识别到', lines.length, '行和弦');
    console.log('📍 手动定位：新的行位置数量', newLinePositions.length);

    // 检查行数是否匹配
    if (lines.length !== newLinePositions.length) {
      console.warn('⚠️ 手动定位：行数不匹配（识别到', lines.length, '行，用户提供', newLinePositions.length, '行）');
      // 如果行数不匹配，使用前几行或后几行
      if (lines.length < newLinePositions.length) {
        newLinePositions.splice(lines.length);
      } else {
        // 如果识别的行数多于用户提供的行数，将多余的行映射到最后一行
        while (lines.length > newLinePositions.length) {
          newLinePositions.push(newLinePositions[newLinePositions.length - 1]);
        }
      }
    }

    // 为每一行的和弦分配新的Y坐标
    const updatedChords: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const newY = newLinePositions[i] || line.y;

      // 更新该行所有和弦的Y坐标
      line.chords.forEach((chord: any) => {
        updatedChords.push({
          ...chord,
          y: newY,
        });
      });
    }

    // 按原始索引排序，保持和弦顺序
    updatedChords.sort((a: any, b: any) => a.originalIndex - b.originalIndex);

    // 构造符合 annotateImage 期望的数据格式
    // 兼容两种格式：
    // 1. { original: "C", transposed: "D", x, y } - 字符串格式（需要解析）
    // 2. { original: {...}, transposed: {...}, x, y } - 对象格式（直接使用）
    const transposedResult = {
      chords: updatedChords.map((chord: any) => {
        // 检查 original 和 transposed 是否为字符串
        const isOriginalString = typeof chord.original === 'string';
        const isTransposedString = typeof chord.transposed === 'string';
        
        let originalChord, transposedChord;
        
        if (isOriginalString) {
          originalChord = chordTransposer.parseChord(chord.original);
        } else {
          originalChord = chord.original;
        }
        
        if (isTransposedString) {
          transposedChord = chordTransposer.parseChord(chord.transposed);
          if (transposedChord) {
            transposedChord.x = chord.x;
            transposedChord.y = chord.y;
          }
        } else {
          transposedChord = chord.transposed;
          transposedChord.x = chord.x;
          transposedChord.y = chord.y;
        }

        return {
          original: originalChord || (isOriginalString ? { root: normalizeNoteToSharp(chord.original), quality: '', bass: undefined, hasParentheses: false } : chord.original),
          transposed: transposedChord || (isTransposedString ? { root: normalizeNoteToSharp(chord.transposed), quality: '', bass: undefined, hasParentheses: false, x: chord.x, y: chord.y } : chord.transposed),
        };
      }),
      originalKey: originalKey || '',
      targetKey: targetKey || '',
    };

    // 将Base64图片转换为Buffer
    const base64Data = imageBase64.split(',')[1];
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // 调用 annotateImage 生成新图片
    const { annotateImage } = await import('../relocate/route');

    const { resultImage } = await annotateImage(
      imageBuffer,
      transposedResult,
      chordColor || '#2563EB',
      fontSize || null,
      originalKey || '',
      targetKey || ''
    );

    console.log('📍 手动定位：新图生成成功');

    // 返回与 /api/transpose 和 /api/relocate 一致的数据格式
    // 使用 transposedResult 中的数据（已经包含完整的 chord 对象）
    return NextResponse.json({
      chords: transposedResult.chords.map((item: any) => ({
        original: item.original,
        transposed: item.transposed,
        x: item.transposed.x,
        y: item.transposed.y,
      })),
      resultImage: resultImage,
      originalKey: originalKey || '',
      targetKey: targetKey || '',
    });
  } catch (error: any) {
    console.error('手动定位处理错误:', error);
    return NextResponse.json(
      { error: error.message || '手动定位失败' },
      { status: 500 }
    );
  }
}
