'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';

// 动态导入主页面组件，禁用 SSR 加快首屏
const TransposePage = dynamic(() => import('./transpose/page'), {
  loading: () => (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
      <div className="text-center space-y-4">
        <Loader2 className="w-16 h-16 text-indigo-600 animate-spin mx-auto" />
        <p className="text-xl text-gray-600 dark:text-gray-400 font-semibold">正在加载...</p>
      </div>
    </div>
  ),
  ssr: false, // 禁用 SSR，加快首屏
});

// 预热后端资源（异步执行，不阻塞页面渲染）
function warmupBackend() {
  if (typeof window !== 'undefined') {
    // 使用 fetch 的 keepalive 选项，确保即使页面关闭也能完成请求
    fetch('/api/warmup', { 
      method: 'GET',
      keepalive: true,
    }).catch(() => {
      // 预热失败不影响用户体验
    });
  }
}

export default function Home() {
  // 页面加载时预热后端资源
  useEffect(() => {
    warmupBackend();
  }, []);

  return <TransposePage />;
}
