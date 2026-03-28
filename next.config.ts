import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lf3-static.bytednsdoc.com',
        pathname: '/**',
      },
    ],
  },
  // 确保静态资源正确加载
  distDir: '.next',
  // 优化静态资源服务
  compress: true,
  // 生产环境优化
  productionBrowserSourceMaps: false,
  // 优化构建输出
  reactStrictMode: true,
  // 将 canvas 作为外部包处理，避免 Turbopack 打包问题
  serverExternalPackages: ['canvas', 'sharp', '@napi-rs/canvas'],
  // 优化初始加载
  experimental: {
    // 优化包导入，减少打包体积
    optimizePackageImports: [
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-select',
      '@radix-ui/react-slot',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-context-menu',
      '@radix-ui/react-hover-card',
      '@radix-ui/react-label',
      '@radix-ui/react-menubar',
      '@radix-ui/react-navigation-menu',
      '@radix-ui/react-progress',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-separator',
      '@radix-ui/react-slider',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toggle',
      '@radix-ui/react-toggle-group',
      '@radix-ui/react-tooltip',
      'recharts',
      'date-fns',
      'react-hook-form',
    ],
  },
};

export default nextConfig;
