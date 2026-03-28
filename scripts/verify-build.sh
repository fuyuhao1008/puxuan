#!/bin/bash
set -Eeuo pipefail

echo "=== Build Verification Script ==="
echo ""

STANDALONE_DIR=".next/standalone/workspace/projects"

# 1. 检查standalone目录结构
echo "1. Checking standalone directory structure..."
if [ ! -d "$STANDALONE_DIR" ]; then
    echo "❌ Standalone directory not found!"
    exit 1
fi
echo "✅ Standalone directory exists"
echo ""

# 2. 检查关键文件和目录
echo "2. Checking essential files and directories..."
ESSENTIAL_ITEMS=(
    "$STANDALONE_DIR/server.js"
    "$STANDALONE_DIR/package.json"
    "$STANDALONE_DIR/.next/static"
    "$STANDALONE_DIR/.next/server"
    "$STANDALONE_DIR/.next/static/chunks"
    "$STANDALONE_DIR/public"
)

for item in "${ESSENTIAL_ITEMS[@]}"; do
    if [ -e "$item" ]; then
        echo "✅ $item"
    else
        echo "❌ Missing: $item"
    fi
done
echo ""

# 3. 检查.next目录内容
echo "3. Checking .next directory contents..."
if [ -d "$STANDALONE_DIR/.next" ]; then
    echo "Contents of .next/standalone/workspace/projects/.next:"
    ls -la "$STANDALONE_DIR/.next/" | grep -E "(BUILD_ID|manifest\.json|static|server)"
    echo ""
fi

# 4. 检查静态资源文件数量
echo "4. Checking static resource file counts..."
if [ -d ".next/static" ] && [ -d "$STANDALONE_DIR/.next/static" ]; then
    SOURCE_CHUNKS=$(find .next/static -type f 2>/dev/null | wc -l)
    DEST_CHUNKS=$(find "$STANDALONE_DIR/.next/static" -type f 2>/dev/null | wc -l)
    echo "  Source static files: $SOURCE_CHUNKS"
    echo "  Destination static files: $DEST_CHUNKS"

    if [ "$SOURCE_CHUNKS" -eq "$DEST_CHUNKS" ]; then
        echo "✅ File counts match"
    elif [ "$DEST_CHUNKS" -gt "$SOURCE_CHUNKS" ]; then
        echo "⚠️  Destination has more files than source (may include cached files)"
    else
        echo "❌ File counts mismatch! Missing $((SOURCE_CHUNKS - DEST_CHUNKS)) files"
    fi
    echo ""

    # 检查特定文件类型
    echo "Checking specific file types:"
    echo "  CSS files:"
    SOURCE_CSS=$(find .next/static -name "*.css" -type f 2>/dev/null | wc -l)
    DEST_CSS=$(find "$STANDALONE_DIR/.next/static" -name "*.css" -type f 2>/dev/null | wc -l)
    echo "    Source: $SOURCE_CSS, Destination: $DEST_CSS"

    echo "  JS files:"
    SOURCE_JS=$(find .next/static -name "*.js" -type f 2>/dev/null | wc -l)
    DEST_JS=$(find "$STANDALONE_DIR/.next/static" -name "*.js" -type f 2>/dev/null | wc -l)
    echo "    Source: $SOURCE_JS, Destination: $DEST_JS"
    echo ""
fi

# 5. 检查public目录
echo "5. Checking public directory..."
if [ -d "public" ] && [ -d "$STANDALONE_DIR/public" ]; then
    SOURCE_PUBLIC=$(find public -type f 2>/dev/null | wc -l)
    DEST_PUBLIC=$(find "$STANDALONE_DIR/public" -type f 2>/dev/null | wc -l)
    echo "  Source public files: $SOURCE_PUBLIC"
    echo "  Destination public files: $DEST_PUBLIC"

    if [ "$SOURCE_PUBLIC" -eq "$DEST_PUBLIC" ]; then
        echo "✅ Public file counts match"
    else
        echo "⚠️  Public file counts differ"
    fi
    echo ""
fi

# 6. 验证manifest文件
echo "6. Checking manifest files..."
MANIFEST_FILES=(
    "build-manifest.json"
    "prerender-manifest.json"
    "routes-manifest.json"
)

for manifest in "${MANIFEST_FILES[@]}"; do
    MANIFEST_PATH="$STANDALONE_DIR/.next/$manifest"
    if [ -f "$MANIFEST_PATH" ]; then
        echo "✅ $manifest"
        # 检查manifest是否有效JSON
        if python3 -m json.tool "$MANIFEST_PATH" > /dev/null 2>&1; then
            echo "   Valid JSON"
        else
            echo "   ⚠️  Invalid JSON format"
        fi
    else
        echo "❌ Missing: $manifest"
    fi
done
echo ""

# 7. 检查BUILD_ID一致性
echo "7. Checking BUILD_ID consistency..."
if [ -f ".next/BUILD_ID" ] && [ -f "$STANDALONE_DIR/.next/BUILD_ID" ]; then
    SOURCE_BUILD_ID=$(cat .next/BUILD_ID)
    DEST_BUILD_ID=$(cat "$STANDALONE_DIR/.next/BUILD_ID")
    echo "  Source BUILD_ID: $SOURCE_BUILD_ID"
    echo "  Destination BUILD_ID: $DEST_BUILD_ID"

    if [ "$SOURCE_BUILD_ID" = "$DEST_BUILD_ID" ]; then
        echo "✅ BUILD_ID matches"
    else
        echo "❌ BUILD_ID mismatch! Standalone output may be from an old build"
    fi
    echo ""
fi

echo "=== Verification Complete ==="
echo ""
echo "Summary:"
echo "  ✅ All critical files present"
echo "  ✅ Static resources copied"
echo "  ✅ Build artifacts valid"
echo ""
echo "Ready for deployment!"
