#!/bin/bash
set -Eeuo pipefail

echo "=== Starting Next.js Server ==="
echo "Current directory: $(pwd)"
echo "PORT environment variable: ${PORT:-not set (will use 5000)}"
echo ""

# 设置环境变量
export PORT="${PORT:-5000}"
export HOSTNAME="0.0.0.0"
export NODE_ENV="production"
export NEXT_TELEMETRY_DISABLED=1

echo "Environment configuration:"
echo "  PORT=$PORT"
echo "  HOSTNAME=$HOSTNAME"
echo "  NODE_ENV=$NODE_ENV"
echo "  NEXT_TELEMETRY_DISABLED=$NEXT_TELEMETRY_DISABLED"
echo ""

# 检查.next目录是否存在
if [ ! -d ".next" ]; then
    echo "✗ Error: .next directory not found"
    echo "Please ensure the project has been built with 'pnpm build'"
    exit 1
fi

echo "✓ Found .next directory"
echo ""

# 检查关键文件
if [ ! -f ".next/required-server-files.js" ]; then
    echo "✗ Error: required-server-files.js not found"
    echo "The build appears to be incomplete"
    exit 1
fi

echo "✓ Build files verified"
echo ""

echo "========================================"
echo "Starting Next.js server on port $PORT..."
echo "Listening on 0.0.0.0:$PORT"
echo "========================================"
echo ""

# 使用标准 Next.js 启动命令
exec node ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p $PORT
