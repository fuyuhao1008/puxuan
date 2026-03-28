#!/bin/bash
set -Eeuo pipefail

# 切换到项目目录
cd "${COZE_WORKSPACE_PATH:-$(pwd)}"

echo "=== Starting build process ==="
echo "Current directory: $(pwd)"
echo "Workspace path: ${COZE_WORKSPACE_PATH:-$(pwd)}"
echo ""

echo "Step 0: Cleaning old build artifacts..."
# 清理旧的.next/standalone目录，确保干净的构建
if [ -d ".next/standalone" ]; then
    echo "Removing old .next/standalone directory..."
    rm -rf .next/standalone
    echo "✓ Old standalone output removed"
fi

echo "Step 1: Installing dependencies..."
# 配置环境变量使用淘宝镜像（用于下载 Node.js headers 和 canvas 预编译二进制）
export npm_config_disturl=https://npmmirror.com/mirrors/node/
export npm_config_canvas_binary_host_mirror=https://npmmirror.com/mirrors/node-canvas-prebuilt/

# 安装所有依赖
pnpm install || {
    echo "ERROR: Failed to install dependencies"
    exit 1
}

echo "✓ Dependencies installed"
echo ""

echo "Step 2: Building project..."
# 使用环境变量禁用遥测收集
NEXT_TELEMETRY_DISABLED=1 pnpm build || {
    echo "ERROR: Build failed"
    exit 1
}

echo "✓ Build completed successfully!"
echo ""

echo "Step 3: Verifying build output..."
if [ -d ".next/static" ]; then
    echo "✓ .next/static directory exists"
    SOURCE_COUNT=$(find .next/static -type f | wc -l)
    echo "  Total static files: $SOURCE_COUNT"
    echo "  Sample chunks:"
    ls .next/static/chunks/ 2>/dev/null | head -5 || echo "  (no chunks)"
else
    echo "ERROR: .next/static directory does not exist after build"
    exit 1
fi

if [ -d ".next/server" ]; then
    echo "✓ .next/server directory exists"
else
    echo "ERROR: .next/server directory does not exist after build"
    exit 1
fi
echo ""

echo "=== Build process completed successfully ==="
echo ""
echo "Next steps:"
echo "  1. Deploy to production"
