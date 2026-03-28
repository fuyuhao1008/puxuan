'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('🔥 ErrorBoundary捕获到错误:', error);
    console.error('🔥 错误详情:', errorInfo);

    this.setState({
      hasError: true,
      error,
      errorInfo,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-red-50 to-pink-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
          <div className="max-w-lg w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 space-y-4">
            <div className="text-center">
              <div className="text-6xl mb-4">😵</div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                哎呀，出错了
              </h1>
              <p className="text-gray-600 dark:text-gray-400">
                页面加载时遇到了一些问题
              </p>
            </div>

            {this.state.error && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
                <p className="text-sm font-semibold text-red-900 dark:text-red-300 mb-2">
                  错误信息：
                </p>
                <p className="text-xs text-red-700 dark:text-red-400 font-mono">
                  {this.state.error.toString()}
                </p>
              </div>
            )}

            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
              <p className="text-sm text-blue-900 dark:text-blue-300">
                请尝试以下操作：
              </p>
              <ul className="text-sm text-blue-700 dark:text-blue-400 mt-2 space-y-1 list-disc list-inside">
                <li>刷新页面重试</li>
                <li>检查网络连接是否正常</li>
                <li>更换浏览器访问</li>
                <li>如果问题持续，请联系技术支持</li>
              </ul>
            </div>

            <button
              onClick={() => {
                window.location.href = window.location.href;
              }}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
