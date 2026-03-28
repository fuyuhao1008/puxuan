import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ErrorBoundary } from '@/components/error-boundary';

export const metadata: Metadata = {
  title: {
    default: '琴献馨香',
    template: '%s | 琴献馨香',
  },
  description:
    '上传简谱图片，可进行和弦转调，输出新图。基于AI驱动的智能和弦转调工具，支持12个调性转换，自动在原图上原位替换和弦。',
  keywords: [
    '简谱',
    '和弦转调',
    'AI识别',
    '音乐转调',
    '自动转调',
    '智能和弦',
    '转调工具',
    '音乐助手',
  ],
  authors: [{ name: '琴献馨香', url: '' }],
  generator: '琴献馨香',
  openGraph: {
    title: '琴献馨香 | 简谱和弦智能转调工具',
    description:
      '上传简谱图片，可进行和弦转调，输出新图。基于AI驱动的智能和弦转调工具，支持12个调性转换。',
    url: '',
    siteName: '琴献馨香',
    locale: 'zh_CN',
    type: 'website',
  },
  robots: {
    index: true,
    follow: true,
  },
};

// 单独导出 viewport 配置（Next.js 16 推荐方式）
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 预加载关键字体（Regular 和 Bold） */}
        <link
          rel="preload"
          href="/fonts/NotoSerifSC-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/NotoSerifSC-Bold.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        {/* 预加载首张装饰图，提升等待界面体验 */}
        <link
          rel="prefetch"
          href="/ai-waiting/img-1.png"
          as="image"
        />
        <style dangerouslySetInnerHTML={{
          __html: `
            /* 内联字体声明，确保 iOS Safari 正确加载 */
            @font-face {
              font-family: 'Noto Serif SC';
              src: url('/fonts/NotoSerifSC-Regular.woff2?v=20250321c') format('woff2');
              font-weight: 400;
              font-style: normal;
              font-display: swap;
            }
            @font-face {
              font-family: 'Noto Serif SC';
              src: url('/fonts/NotoSerifSC-Bold.woff2?v=20250321c') format('woff2');
              font-weight: 700;
              font-style: normal;
              font-display: swap;
            }
          `
        }} />
      </head>
      <body className="antialiased select-none">
        <style dangerouslySetInnerHTML={{
          __html: `
            /* 全局禁止 iOS 长按行为 */
            * {
              -webkit-touch-callout: none !important;
              -webkit-user-select: none !important;
              user-select: none !important;
              -webkit-highlight: none !important;
              -webkit-tap-highlight-color: transparent !important;
            }

            /* 允许输入框、文本区域等元素的文本选择 */
            input, textarea, [contenteditable], .select-text {
              -webkit-touch-callout: default !important;
              -webkit-user-select: text !important;
              user-select: text !important;
            }

            .footer-heart {
              color: #fca5a5 !important;
              font-size: 10px !important;
            }
          `
        }} />
        <ErrorBoundary>
          {children}
          <div className="fixed bottom-4 right-6 text-xs text-gray-500 z-50" style={{ fontFamily: '"Noto Serif SC", "Georgia", serif' }}>
            I <span className="footer-heart">❤</span> 普宣
          </div>
        </ErrorBoundary>
      </body>
    </html>
  );
}
