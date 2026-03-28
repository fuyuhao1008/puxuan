'use client';

import { Loader2 } from 'lucide-react';

export default function Loading() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
      <div className="text-center space-y-4">
        <Loader2 className="w-16 h-16 text-indigo-600 animate-spin mx-auto" />
        <p className="text-xl text-gray-600 dark:text-gray-400 font-semibold">正在加载...</p>
      </div>
    </div>
  );
}
