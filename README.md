# 简谱和弦转调器

基于 AI 驱动的简谱和弦自动转调工具，支持上传简谱图片，自动识别和弦并转调到任意调性。

## 📝 最新更新

### 2025-01-23

**Bug 修复**：原调显示逻辑优化
- 修复了用户手动选择原调时仍显示"已自动识别"标记的问题
- 添加 `isAutoRecognized` 状态，明确区分AI识别和手动选择
- 用户现在可以随时修改原调，不会再出现误判

**商业化准备**：API Key 配置支持
- 项目已支持自定义 API Key 配置
- 环境变量优先级高于 SDK 默认配置
- 提供完整的商业化应对方案（支持多模型切换）
- 详细文档请参阅 [商业化应对方案](./COMMERCIALIZATION_PLAN.md)

## 功能特性

### ✅ 已实现功能

1. **和弦转调核心算法**
   - 支持完整的12个调性（C, C#/Db, D, D#/Eb, E, F, F#/Gb, G, G#/Ab, A, A#/Bb, B）
   - 支持所有和弦类型（三和弦、七和弦、挂留和弦、转位和弦等）
   - **等音转换**：D# → Eb, A# → Bb（按简谱常用记法）
   - 保留和弦性质（Cmaj7 → Dmaj7, Fsus4 → Gsus4）
   - 处理转位和弦（C/E → D/E）

2. **用户界面**
   - 图片上传界面（支持拖拽上传）
   - 调性选择（原调自动识别或手动选择，目标调手动选择）
   - 实时转调结果显示
   - 和弦序列对比展示
   - 转调结果图片预览

3. **图片标注功能**
   - 在原图上原位替换和弦
   - 动态调整字体大小以适应图片尺寸
   - 白色背景覆盖原和弦，蓝色文本显示新和弦
   - 支持 SVG 叠加和图片合成

4. **测试工具**
   - `/test` 页面：测试和弦转调算法
   - 支持手动输入和弦和坐标进行测试

### 🔨 待完善功能

1. **增强功能**
   - 批量处理多张图片
   - 支持更多图片格式
   - 优化和弦识别准确率
   - 支持手动编辑识别结果

## 技术栈

- **前端**: Next.js 16 + TypeScript + Tailwind CSS 4
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **后端**: Next.js API Routes
- **图片处理**: Sharp
- **包管理**: pnpm

## 项目结构

```
src/
├── app/
│   ├── page.tsx                    # 首页
│   ├── transpose/
│   │   └── page.tsx                # 转调功能主页面
│   ├── test/
│   │   └── page.tsx                # 测试页面
│   └── api/
│       ├── transpose/
│       │   └── route.ts           # 转调 API
│       └── test/
│           └── route.ts           # 测试 API
├── lib/
│   └── chord-transposer.ts        # 和弦转调核心算法
└── components/
    └── ui/                         # shadcn/ui 组件
```

## 使用方法

### 启动开发环境

```bash
# 依赖已安装，直接启动开发服务器
pnpm dev
```

服务默认在 `http://localhost:3000` 启动

### 使用转调功能

1. 访问首页 `http://localhost:5000`
2. 点击"开始使用"进入转调页面
3. 上传简谱图片（支持 JPG、PNG 格式）
4. 选择目标调性（原调会自动识别，也可手动指定）
5. 点击"开始转调"按钮
6. 查看转调结果，可下载标注后的图片

### 使用测试页面

访问 `http://localhost:5000/test` 可以测试和弦转调算法：

1. 输入和弦文本（如 C, Am7, Gsus4）
2. 输入和弦在图片中的位置（X、Y 百分比坐标）
3. 选择原调和目标调
4. 点击"执行转调"查看结果

## 和弦转调算法

### 支持的和弦格式

- **基础和弦**: C, D, E, F, G, A, B
- **变化音**: C#, Db, D#, Eb, F#, Gb, G#, Ab, A#, Bb
- **小调**: Cm, Dm, Em, Fm, Gm, Am, Bm
- **七和弦**: C7, Dm7, Em7, Fmaj7, G7, Am7, Bdim7
- **挂留和弦**: Csus2, Csus4
- **转位和弦**: C/E, Am/G, F/A
- **复合和弦**: Cmaj7, Dm9, G11, B7#9

### 等音转换规则

根据简谱常用记法，自动进行以下转换：
- D# → Eb
- A# → Bb
- 其他变化音保持原样

### 转调示例

| 原调 | 目标调 | 原和弦 | 新和弦 |
|-----|-------|-------|--------|
| C   | G     | C     | G      |
| C   | G     | Am    | Em     |
| C   | G     | Fmaj7 | Cmaj7  |
| C   | G     | G/B   | D/F#   |
| C   | E     | D#m7  | Gm7    |

## API 接口

### POST /api/transpose

上传图片并执行转调

**请求参数**:
- `image`: 图片文件（FormData）
- `targetKey`: 目标调（如 "C", "G", "Eb"）
- `originalKey`: 原调（可选，系统会自动识别）

**返回数据**:
```json
{
  "originalKey": "C",
  "targetKey": "G",
  "semitones": 7,
  "chords": [
    {
      "original": { "root": "C", "quality": "", "original": "C" },
      "transposed": { "root": "G", "quality": "", "original": "C" }
    }
  ],
  "resultImage": "data:image/jpeg;base64,..."
}
```

### POST /api/test

测试和弦转调算法

**请求参数**:
```json
{
  "chords": [
    { "text": "C", "x": 20, "y": 30 }
  ],
  "originalKey": "C",
  "targetKey": "G"
}
```

**返回数据**:
```json
{
  "success": true,
  "result": { /* 转调结果 */ }
}
```

## 开发说明

### 多模态模型集成（已实现）

项目已通过**火山方舟（Ark）Chat Completions API** 调用豆包多模态模型进行图片识别。

#### 功能说明

`src/app/api/transpose/route.ts` 中的 `recognizeChordsFromImage` 函数通过 Ark 调用多模态模型，实现：

1. **识别调号**：从图片左上角识别调号标记（如 "1=C"、"1=G"）
2. **识别和弦**：识别图片中所有和弦标记（如 C、Am、G7、F#m 等）
3. **定位坐标**：返回每个和弦的精确像素中心点坐标
4. **去重处理**：移除重复识别的和弦（距离阈值 1%）

#### 技术细节

- **模型**：豆包视觉模型（doubao-seed-1-6-vision-250815）
- **温度**：0.2（低温度确保识别准确）
- **坐标系统**：绝对像素坐标（非百分比）
- **返回格式**：
```json
{
  "key": "C",
  "centers": [
    { "text": "D", "cx": 150, "cy": 200 },
    { "text": "G", "cx": 350, "cy": 200 }
  ]
}
```

#### API Key 配置

**环境变量配置**（`.env.local` 或部署平台环境变量）：
```bash
ARK_API_KEY=your-api-key-here
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3  # 可选

# 识别模型
VISION_MODEL_LITE=doubao-seed-2-0-lite-260215
VISION_MODEL_VISION=doubao-seed-1-6-vision-250815

# fast 模式 Vision assist（可选）
VISION_ASSIST_ENABLED=true
VISION_ASSIST_STRATEGY=window  # window | full
VISION_ASSIST_TIMEOUT_MS=30000
VISION_ASSIST_POST_LITE_WAIT_MS=8000

# 服务端绘制字体（解决 Linux/Vercel 缺系统字体导致文字不显示）
# 推荐：把字体文件放到 public/fonts/，并用 CHORD_FONT_FILE 指定它
CHORD_FONT_FILE=fonts/YourFont.ttf
# 可选：额外的回退字体族（当 CHORD_FONT_FILE 未配置或注册失败时使用）
CHORD_FONT_FAMILY="Times New Roman", Times, serif
```

#### 提示词优化

系统使用精心设计的提示词，包括：
- 明确的坐标系统定义（绝对像素坐标）
- 分布校验规则（强制识别下半区域和弦）
- 详细的识别任务说明
- 严格的返回格式要求
   ```
   请分析这张简谱图片，识别出以下信息：

   1. 调号（Key）：如 "1=C", "1=G", "Key: F" 等
   2. 所有和弦标记：如 C, Am, G7, Fsus4, C/E 等
   3. 每个和弦的位置（像素中心点坐标）

   请以JSON格式返回：
   {
     "key": "C",
     "centers": [
       {
         "text": "C",
         "cx": 150,
         "cy": 200
       },
       ...
     ]
   }
   ```

### 添加新的和弦类型

在 `src/lib/chord-transposer.ts` 中的 `parseChord` 方法中添加新的和弦正则匹配规则。

## 测试

运行以下命令进行类型检查：

```bash
npx tsc --noEmit
```

运行构建：

```bash
pnpm build
```

## 许可证

MIT

## 致谢

- [Next.js](https://nextjs.org/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Sharp](https://sharp.pixelplumbing.com/)
- [火山方舟](https://www.volcengine.com/product/ark)

## 更新日志

### 2025-01-23

**Bug 修复**
- [修复] 原调显示逻辑优化 - 用户手动选择原调时不再显示"已自动识别"标记
- [新增] `isAutoRecognized` 状态变量
- [优化] 用户界面逻辑，明确区分AI识别和手动选择

**文档更新**
- [新增] 商业化应对方案文档 (`COMMERCIALIZATION_PLAN.md`)
- [新增] Bug修复说明文档 (`BUGFIX_MANUAL_KEY_SELECTION.md`)
- [更新] README.md，添加商业化准备说明
- [更新] `.env.example`，添加API Key配置说明

**技术改进**
- [改进] API Key配置支持（环境变量优先级）
- [改进] 代码注释和文档完善
- [改进] 状态管理逻辑优化

---

**文档版本**: v1.1
**最后更新**: 2025-01-23
