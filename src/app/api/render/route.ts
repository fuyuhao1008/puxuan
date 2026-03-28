import { NextRequest, NextResponse } from 'next/server';

// 导入和弦转调工具
import { chordTransposer } from '@/lib/chord-transposer';

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
    } = body;

    // 验证参数
    if (!chords || !Array.isArray(chords)) {
      return NextResponse.json({ error: '缺少和弦数据' }, { status: 400 });
    }
    if (!imageBase64) {
      return NextResponse.json({ error: '缺少图片数据' }, { status: 400 });
    }

    console.log('🎨 渲染：接收到的和弦数量', chords.length);
    console.log('🎨 渲染：目标调', targetKey, '颜色', chordColor, '字号', fontSize);

    // 构造符合 annotateImage 期望的数据格式
    // chords 数组中每个元素是 { original, transposed, x, y }
    // annotateImage 需要的是 { transposed, x, y } 格式
    const transposedResult = {
      chords: chords.map((chord: any) => {
        // 解构获取 transposed 对象，并添加坐标
        const { transposed, x, y } = chord;
        return {
          ...transposed, // 展开 transposed 对象的所有属性（root, quality, bass, chords 等）
          x, // 添加 x 坐标
          y, // 添加 y 坐标
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

    const { resultImage, fontSize: actualFontSize } = await annotateImage(
      imageBuffer,
      transposedResult,
      chordColor || '#2563EB',
      fontSize || null,
      originalKey || '',
      targetKey || ''
    );

    console.log('🎨 渲染：新图生成成功');

    return NextResponse.json({
      chords: chords,
      resultImage: resultImage,
      originalKey: originalKey || '',
      targetKey: targetKey || '',
      fontSize: actualFontSize || null,
      chordColor: chordColor || '#2563EB',
    });
  } catch (error: any) {
    console.error('渲染处理错误:', error);
    return NextResponse.json(
      { error: error.message || '渲染失败' },
      { status: 500 }
    );
  }
}
