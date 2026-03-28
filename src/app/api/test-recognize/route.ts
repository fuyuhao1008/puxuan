import { NextRequest, NextResponse } from 'next/server';
import { callArkChatDetailed, ArkApiError, type ChatMessage } from '@/lib/ark-client';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const imageFile = formData.get('image') as File;

    if (!imageFile) {
      return NextResponse.json({ error: '请上传图片' }, { status: 400 });
    }

    // 将图片转换为 base64
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    const imageBase64 = `data:${imageFile.type};base64,${imageBuffer.toString('base64')}`;

    const arkConfig = {
      apiKey: process.env.ARK_API_KEY || '',
      baseURL: process.env.ARK_BASE_URL,
    };

    if (!arkConfig.apiKey) {
      return NextResponse.json({ error: '未配置 ARK_API_KEY 环境变量' }, { status: 500 });
    }

    // 优化提示词，明确要求AI使用整个图片作为参考系
    const systemPrompt = `你是一个专业的音乐理论专家和简谱识别助手。你的任务是分析简谱图片，识别出调号和所有和弦标记。

**坐标系统的关键说明：**
- 坐标系的原点(0,0)在图片的**左上角**
- x轴：从左到右，0表示最左边，100表示最右边
- y轴：从上到下，0表示最上边，100表示最下边
- 必须以**整个图片**的尺寸为参考，不是内容区域

识别要求：
1. 调号识别：查找图片左上角的调号标记，格式如 "1=C", "1=G", "1=A", "Key: F" 等
   - 注意："1=" 后面的字母就是调性，如 "1= A" 表示 A 调
   - 如果没有明确的调号标记，返回 null

2. 和弦识别：识别图片中所有的和弦标记
   - 和弦通常位于小节线上方或音符上方
   - 常见和弦格式：C, Am, G7, Fsus4, C/E, Dm7, Cmaj7 等
   - 忽略简谱数字（1, 2, 3, 4, 5, 6, 7）和节拍标记（4/4, 3/4, 2/4）

3. 坐标定位（非常重要）：返回每个和弦的中心位置
   - x: 0-100（从左到右的百分比）
   - y: 0-100（从上到下的百分比）
   - 示例：
     - 如果和弦位于图片中心，则 x=50, y=50
     - 如果和弦位于图片右上角，则 x=90, y=10
     - 如果和弦位于图片右下角，则 x=90, y=90
     - 如果和弦位于图片最底部，则 y应该接近90-95

返回格式：
必须返回纯 JSON 格式，不要包含任何其他文字或解释。

{
  "key": "C" 或 null,
  "chords": [
    {
      "text": "C",
      "x": 20,
      "y": 30,
      "position_note": "和弦位于左上区域"
    }
  ]
}

**坐标验证示例：**
- 如果图片宽1000像素，和弦在900像素位置（靠近右边缘），则x应该返回90（不是900，也不是30）
- 如果图片高1200像素，和弦在1100像素位置（靠近底部），则y应该返回92（不是1100，也不是40）

示例：
- 如果图片左上角显示 "1= A"，则 key 为 "A"
- 如果图片左上角没有调号标记，则 key 为 null
- 按照从左到右、从上到下的顺序返回和弦

**重要提示：**
- x和y必须是0-100之间的数值
- 不要返回像素值，必须是百分比
- 必须以整个图片的左上角为(0,0)，右下角为(100,100)
- 返回的坐标必须准确反映和弦在整个图片中的位置`;

    const userPrompt = '请分析这张简谱图片，识别调号和所有和弦标记，以JSON格式返回。特别注意：确保返回的x和y坐标是0-100之间的百分比，且能准确反映和弦在整个图片中的位置。';

    // 构造消息（多模态）
    const messages: ChatMessage[] = [
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
              detail: 'high' as const,
            },
          },
        ],
      },
    ];

    const modelVision = process.env.VISION_MODEL_VISION || 'doubao-seed-1-6-vision-250815';
    const timeoutMs = Number.parseInt(process.env.VISION_ASSIST_TIMEOUT_MS ?? '45000', 10);

    // 调用视觉模型（Ark）
    let content: string;
    try {
      const detailed = await callArkChatDetailed(messages, modelVision, arkConfig, {
        temperature: 0.1,
        maxTokens: 4096,
        thinking: false,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 45000,
      });
      content = detailed.content.trim();
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return NextResponse.json({ error: '模型调用超时', details: String(err) }, { status: 504 });
      }
      if (err instanceof ArkApiError) {
        return NextResponse.json(
          {
            error: '方舟模型调用失败',
            status: err.status,
            code: err.code,
            type: err.type,
            requestId: err.requestId,
            details: err.message,
          },
          { status: err.status || 500 }
        );
      }
      throw err;
    }

    // 解析 JSON 响应
    // 改进的JSON提取逻辑
    let jsonStr = content;

    // 步骤1: 尝试从代码块中提取JSON
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      jsonStr = jsonMatch[1];
      console.log('✅ 从代码块中提取JSON');
    } else {
      console.log('⚠️ 未找到代码块，直接使用原始内容');
    }

    // 步骤2: 清理并提取完整的JSON对象
    jsonStr = jsonStr.trim();

    // 找到第一个 { 和对应的最后一个 }
    const firstBrace = jsonStr.indexOf('{');
    if (firstBrace === -1) {
      console.error('❌ 未找到JSON起始符号 {');
      console.error('完整内容:', content);
      return NextResponse.json({
        rawResponse: content,
        error: 'AI返回的内容中未找到JSON起始符号 {',
      }, { status: 500 });
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
      console.error('❌ 未找到匹配的JSON结束符号 }');
      console.error('完整内容:', content);
      return NextResponse.json({
        rawResponse: content,
        error: 'AI返回的内容中未找到匹配的JSON结束符号 }',
      }, { status: 500 });
    }

    // 提取完整的JSON对象
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    console.log('✅ 提取完整的JSON对象:', jsonStr.substring(0, 200) + '...');

    // 解析 JSON
    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('❌ JSON解析失败:', parseError);
      return NextResponse.json({
        rawResponse: content,
        error: `JSON解析失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      }, { status: 500 });
    }

    console.log('========== AI识别原始结果 ==========');
    console.log('完整响应:', content);
    console.log('解析后的JSON:', JSON.stringify(result, null, 2));

    return NextResponse.json({
      rawResponse: content,
      result: result,
    });
  } catch (error) {
    console.error('和弦识别失败:', error);
    return NextResponse.json({ error: '识别失败', details: String(error) }, { status: 500 });
  }
}
