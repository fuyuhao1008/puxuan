'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ALL_KEYS, getKeyIndex } from '@/lib/chord-transposer';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, Music, Loader2, CheckCircle, ChevronLeft, ChevronRight } from 'lucide-react';

import { preprocessChordSequence } from '@/lib/utils';

interface Point {
  x: number;
  y: number;
}

type PageState = 'upload' | 'select_method' | 'auto_recognizing' | 'locating_first' | 'locating_last' | 'settings' | 'processing' | 'result' | 'manual_relocating';

// 缓存AI识别结果（避免重复调用）
interface RecognitionCache {
  key: string | null;
  centers: Array<{ text: string; cx: number; cy: number }>;
  timestamp: number;
}

// 图标组件：精确的圆圈和文字框设计
function CalibrationMarker({
  index,
  isFirst,
  isLongPressed,
  isMobile,
  imageWidth,
  imageHeight,
}: {
  index: number;
  isFirst: boolean;
  isLongPressed: boolean;
  isMobile: boolean;
  imageWidth: number;
  imageHeight: number;
}) {
  const borderColor = isFirst ? '#1890ff' : '#FF8C00';
  const backgroundColor = '#FFFFFF';
  const lineColor = isLongPressed ? '#FF8C00' : '#FF0000'; // 长按时变橙色

  // 文字字体大小（增大）
  const fontSize = isMobile ? 16 : 18;

  // 文字行高
  const lineHeight = fontSize * 1.4;

  // 关键词样式
  const highlightStyle = {
    color: borderColor,
    fontWeight: 700,
  };

  // 文字框与矩形框的间距（移动端 5px，桌面端 15px）
  const textSpacing = isMobile ? 5 : 15;

  // 文字框的总高度（lineHeight + 上下 padding）
  // 移动端使用更小的 padding
  const paddingVertical = isMobile ? 3 : 6;
  const paddingHorizontalLeft = isMobile ? 8 : 12;
  const paddingHorizontalRight = paddingHorizontalLeft * 2; // 右侧 padding 翻倍
  const textHeight = lineHeight + paddingVertical * 2;

  // 移动端减小字体，防止换行
  const actualFontSize = isMobile ? Math.min(fontSize, 13) : fontSize;
  const actualLineHeight = actualFontSize * 1.4;

  // 计算白色背景框的高度和位置
  // 白色框覆盖：红线上方 + 红线 + 红线下方 + 文本框 + 上下扩展区域
  // 高度增加15%
  let whiteBoxHeight, whiteBoxTop;
  const baseHeight = `calc(100% + ${textHeight}px + ${textSpacing * 2}px)`;
  const increasedHeight = `calc(${baseHeight} * 1.15)`;
  
  if (isFirst) {
    // 第一个图标：从红线上方开始，向下扩展到文本框下方
    // 红线中心在 1% 位置，红线上方从 0% 开始
    // 上端向上移动 baseHeight * 0.15，高度增加15%，下端相对位置更低
    whiteBoxHeight = increasedHeight;
    whiteBoxTop = `calc(-15% - ${textHeight}px * 0.15 - ${textSpacing * 2}px * 0.15)`;
  } else {
    // 第二个图标：从文本框顶部开始，向下扩展到红线下方
    // 红线中心在 1% 位置，红线下方扩展到 2%
    // 下端向下移动 baseHeight * 0.15，高度增加15%，上端相对位置更高
    whiteBoxHeight = increasedHeight;
    whiteBoxTop = `calc(-${textHeight}px - ${textSpacing * 2}px - 2% - 15%)`;
  }

  return (
    <div
      className="calibration-marker"
      style={{
        position: 'relative',
        width: '100%', // 使用 100% 宽度，自适应父容器
        height: '2%', // 使用 2% 高度，自适应父容器
        touchAction: 'pan-y pinch-zoom', // 允许垂直滚动和缩放
      }}
    >
      {/* 白色背景框 - 用于扩展触摸范围 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: '100%',
          height: whiteBoxHeight,
          top: whiteBoxTop,
          backgroundColor: 'rgba(255, 255, 255, 0)', // 完全透明
          borderRadius: '8px',
          pointerEvents: 'auto',
          touchAction: 'pan-y pinch-zoom', // 允许垂直滚动和缩放
          zIndex: 5,
        }}
      />

      {/* 文字提示框 */}
      <div
        style={{
          position: 'absolute',
          ...(
            isMobile
              ? { left: 0, width: '100%' }
              : { left: '50%', width: 'fit-content', maxWidth: '90%', transform: 'translateX(-50%)' }
          ),
          textAlign: 'center',
          fontSize: `${actualFontSize}px`,
          color: '#000000',
          fontWeight: 500,
          lineHeight: `${actualLineHeight}px`,
          padding: `${paddingVertical}px ${paddingHorizontalRight}px ${paddingVertical}px ${paddingHorizontalLeft}px`,
          backgroundColor: backgroundColor,
          border: `1px solid ${borderColor}`,
          borderRadius: '6px',
          boxShadow: isLongPressed
            ? `0 6px 16px ${borderColor}80, 0 2px 6px ${borderColor}4D`
            : '0 2px 8px rgba(0, 0, 0, 0.15)',
          transition: 'box-shadow 0.15s ease-out',
          // 使用 top 定位，避免 bottom/top 混合导致的问题
          // 第一个图标：文字在矩形框下方（2% + 间距）
          // 第二个图标：文字在矩形框上方（-(文字框高度 + 间距)）
          top: isFirst
            ? `calc(2% + ${textSpacing}px)`
            : `calc(-${textHeight}px - ${textSpacing}px)`,
          pointerEvents: 'auto',
          cursor: 'grab',
          // 强制禁止所有文本选择
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
          userSelect: 'none',
          WebkitTouchCallout: 'none',
          touchAction: 'pan-y pinch-zoom', // 允许垂直滚动和缩放
          zIndex: 10,
        }}
      >
        {isFirst ? (
          <>
            <span style={{ color: '#1890ff', fontWeight: 700 }}>向上拖动此框 使红线对齐</span><span style={{ color: isLongPressed ? '#FF8C00' : '#FF0000', fontWeight: 700 }}>第一行和弦</span>
          </>
        ) : (
          <>
            <span style={{ color: '#FF8C00', fontWeight: 700 }}>向下拖动此框 使红线对齐</span><span style={{ color: isLongPressed ? '#FF8C00' : '#FF0000', fontWeight: 700 }}>最后一行和弦</span>
          </>
        )}
      </div>

      {/* 矩形框 */}
      <div
        className="calibration-box"
        style={{
          position: 'absolute',
          left: 0,
          width: '100%',
          height: '100%',
          top: 0,
          border: 'none',
          borderRadius: '2px',
          pointerEvents: 'auto',
          cursor: 'grab',
          boxShadow: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
          userSelect: 'none',
          WebkitTouchCallout: 'none',
          touchAction: 'none',
          zIndex: 8,
        }}
        onTouchStart={(e) => {
          // 阻止浏览器的默认长按行为（如放大镜、上下文菜单等）
          e.preventDefault();
        }}
        onTouchMove={(e) => {
          // 阻止浏览器的默认触摸移动行为
          e.preventDefault();
        }}
      >
        {/* 中心实线 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            width: '100%',
            height: 0,
            borderBottom: `1.5px solid ${lineColor}`, // 红色，粗细1.5px
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            opacity: 0.8,
          }}
        />
      </div>
    </div>
  );
}

// AI 识别等待界面的图片轮换组件
const WAITING_IMAGES = [
  '/ai-waiting/img-1.png',
  '/ai-waiting/img-2.png',
  '/ai-waiting/img-3.png',
  '/ai-waiting/img-4.png',
  '/ai-waiting/img-5.png',
  '/ai-waiting/img-6.png',
];

function WaitingImageSlideshow() {
  // 每次进入等待界面，只随机展示一张图（不轮播）
  const [currentImage] = useState(() => {
    return WAITING_IMAGES[Math.floor(Math.random() * WAITING_IMAGES.length)];
  });

  // 图片加载状态（用于“图片上传成功”过渡提示）
  const [imageLoaded, setImageLoaded] = useState(false);
  const [showUploadSuccess, setShowUploadSuccess] = useState(true);

  // 图片加载完成后，延迟隐藏上传成功提示
  useEffect(() => {
    if (imageLoaded && showUploadSuccess) {
      const timer = setTimeout(() => {
        setShowUploadSuccess(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [imageLoaded, showUploadSuccess]);

  return (
    <div 
      className="relative rounded-lg shadow-lg overflow-hidden bg-white
                 w-[75vw] max-w-[280px]
                 md:w-[50vw] md:max-w-[450px]
                 lg:w-[35vw] lg:max-w-[360px]"
      style={{ aspectRatio: '3/4' }} // 固定宽高比（图片实际尺寸 1080x1440），避免图片加载前后进度条位置跳动
    >
      {/* 图片上传成功过渡提示 */}
      <div 
        className="absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100 dark:from-green-900/30 dark:to-emerald-800/30 transition-opacity duration-500"
        style={{
          opacity: showUploadSuccess ? 1 : 0,
          pointerEvents: showUploadSuccess ? 'auto' : 'none',
        }}
      >
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-lg font-medium">图片上传成功</span>
        </div>
      </div>
    
      {/* 当前图片 */}
      <img
        src={currentImage}
        alt="等待中"
        className="w-full h-full object-cover"
        onLoad={() => setImageLoaded(true)}
      />
    </div>
  );
}


const COLOR_OPTIONS = [
  { value: '#000000', label: '黑色' },
  { value: '#FF4444', label: '红色' },
  { value: '#2563EB', label: '蓝色' },
  { value: '#E65100', label: '橘色' },
  { value: '#9333EA', label: '紫色' },
];

export default function TransposePage() {
  const [pageState, setPageState] = useState<PageState>('upload');
  const [imageSrc, setImageSrc] = useState<string>('');
  const [imageKey, setImageKey] = useState<number>(0);
  const [anchorPoints, setAnchorPoints] = useState<Point[]>([]);
  const [originalKey, setOriginalKey] = useState<string>('');
  const [targetKey, setTargetKey] = useState<string>('');
  const [direction, setDirection] = useState<'up' | 'down' | ''>('');
  const [semitones, setSemitones] = useState<number | ''>('');
  const [result, setResult] = useState<any>(null);
  const [isRecognizing, setIsRecognizing] = useState<boolean>(false);
  const [isAutoRecognized, setIsAutoRecognized] = useState<boolean>(false);
  const [chordsData, setChordsData] = useState<any>(null);
  const [chordColor, setChordColor] = useState<string>('#2563EB');
  const [fontSize, setFontSize] = useState<number | null>(null);
  const [isAdjusting, setIsAdjusting] = useState<boolean>(false);
  const [isRelocating, setIsRelocating] = useState<boolean>(false);
  const [showDeepThinkingDialog, setShowDeepThinkingDialog] = useState<boolean>(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [mounted, setMounted] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [longPressedIndex, setLongPressedIndex] = useState<number | null>(null);

  // 模型选择：'fast' 速度优先 | 'accurate' 精度优先
  const [modelMode, setModelMode] = useState<'fast' | 'accurate'>('fast');

  // 重新识别进度
  const [relocateProgress, setRelocateProgress] = useState<number>(0);

  // 追踪每个瞄准框是否被拖动过（用于控制确认按钮的启用状态）
  const [hasDraggedAnchors, setHasDraggedAnchors] = useState<boolean[]>([]);

  // 标记是否使用直接坐标模式（方法2：AI自动识别，不使用锚点校准）
  const [useDirectCoordinates, setUseDirectCoordinates] = useState<boolean>(false);

  // 示例弹窗状态
  const [showExampleModal, setShowExampleModal] = useState<boolean>(false);
  const [exampleImageLoading, setExampleImageLoading] = useState<boolean>(true);
  const exampleImageLoadedRef = useRef<boolean>(false); // 跟踪示例图片是否已加载

  // 文本框尺寸常量（与 CalibrationMarker 组件保持一致）
  const getTextBoxDimensions = () => {
    const fontSize = isMobile ? 16 : 18;
    const actualFontSize = isMobile ? Math.min(fontSize, 13) : fontSize;
    const lineHeight = actualFontSize * 1.4;
    const paddingVertical = isMobile ? 3 : 6;
    const textSpacing = isMobile ? 5 : 15;
    const textHeight = lineHeight + paddingVertical * 2;
    const boxHeight = 0.02; // 2% 高度

    return {
      textHeight,
      textSpacing,
      boxHeight,
    };
  };

  // 缓存AI识别结果（避免重复调用）
  const [recognitionCache, setRecognitionCache] = useState<RecognitionCache | null>(null);
  const [isBackgroundRecognizing, setIsBackgroundRecognizing] = useState<boolean>(false);

  // 当前会话的多次识别结果（左右箭头导航）
  const [sessionResults, setSessionResults] = useState<any[]>([]);
  const [currentSessionIndex, setCurrentSessionIndex] = useState<number>(0);

  // 图片宽高比（用于等待界面）
  const [imageAspectRatio, setImageAspectRatio] = useState<number>(4/3);

  // 调试模式：仅在 URL 包含 ?debug=1 时展示关键 debug 信息（方便手机截图）
  const [debugMode, setDebugMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('debug') === '1';
  });
  const [lastTransposeDebug, setLastTransposeDebug] = useState<any>(null);
  const [lastWarmupDebug, setLastWarmupDebug] = useState<any>(null);

  const hasWarmedTransposeRef = useRef<boolean>(false);

  // 自动识别进度（方法2）
  const [autoRecognizeProgress, setAutoRecognizeProgress] = useState<number>(0);

  // 手动定位和弦的纵坐标位置（用于手动重新定位纵向和弦位置）
  const [manualLinePositions, setManualLinePositions] = useState<number[]>([]); // 存储每行和弦的纵坐标（百分比）
  const [draggingLineIndex, setDraggingLineIndex] = useState<number | null>(null);
  // 自动识别重试次数（用于显示不同的提示文字）

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setDebugMode(params.get('debug') === '1');
  }, []);

  // 在进入设置页时预热 /api/transpose（同一路由同一个函数），降低后续 POST 的冷启动/首次连接开销
  useEffect(() => {
    if (pageState !== 'settings') return;
    if (hasWarmedTransposeRef.current) return;
    hasWarmedTransposeRef.current = true;

    (async () => {
      const t0 = performance.now();
      setLastWarmupDebug({ note: 'warming...' });
      try {
        const res = await fetch('/api/transpose', { method: 'GET', cache: 'no-store' });
        const t1 = performance.now();
        const resHeaders = {
          date: res.headers.get('date'),
          server: res.headers.get('server'),
          contentLength: res.headers.get('content-length'),
          xVercelId: res.headers.get('x-vercel-id'),
          xTraceId: res.headers.get('x-trace-id'),
          serverTiming: res.headers.get('server-timing'),
        };
        let json: any = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        const t2 = performance.now();

        setLastWarmupDebug({
          ok: res.ok,
          status: res.status,
          headers: resHeaders,
          timings: {
            headersMs: Math.round(t1 - t0),
            bodyJsonMs: Math.round(t2 - t1),
            totalMs: Math.round(t2 - t0),
          },
          body: json,
        });
      } catch (error) {
        const t1 = performance.now();
        setLastWarmupDebug({
          ok: false,
          status: null,
          timings: {
            totalMs: Math.round(t1 - t0),
          },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [pageState]);
  const [autoRecognizeRetryCount, setAutoRecognizeRetryCount] = useState<number>(0);
  const [manualLongPressedIndex, setManualLongPressedIndex] = useState<number | null>(null); // 手动定位的长按状态
  const [isConfirmingManualRelocate, setIsConfirmingManualRelocate] = useState<boolean>(false); // 手动定位确认状态

  // 使用ref存储最新状态，避免闭包捕获旧值
  const recognitionCacheRef = useRef<RecognitionCache | null>(null);
  const isBackgroundRecognizingRef = useRef<boolean>(false);
  const isRequestAbortedRef = useRef<boolean>(false); // 追踪请求是否被取消

  const imageContainerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const anchorPointsRef = useRef<Point[]>([]);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressedRef = useRef<boolean>(false);
  const isDraggingRef = useRef<boolean>(false);
  const hasDraggedRef = useRef<boolean>(false);
  const hasLongPressedRef = useRef<boolean>(false);
  const shouldPreventClickRef = useRef<boolean>(false);
  const draggingIndexRef = useRef<number | null>(null);
  const initialTouchPosRef = useRef<{ x: number; y: number } | null>(null);
  const touchMovedTooMuchRef = useRef<boolean>(false);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const manualLineDragOffsetRef = useRef<number>(0); // 手动横线拖动时的 Y 偏移量
  const activePointersRef = useRef<Set<number>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    console.log('📱 开始检测移动端设备...');
    try {
      const checkMobile = () => {
        console.log('📱 检查移动端状态...');
        if (typeof navigator === 'undefined' || typeof window === 'undefined') {
          console.log('⚠️ navigator或window未定义，跳过移动端检测');
          return;
        }

        try {
          const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera || '';
          console.log('📱 UserAgent:', userAgent.substring(0, 100));
          // 检测常见的移动端User-Agent
          const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
          const isMobileDevice = mobileRegex.test(userAgent);
          // 同时也检查屏幕宽度作为备用
          const isSmallScreen = window.innerWidth < 768;
          console.log('📱 检测结果:', { isMobileDevice, isSmallScreen, width: window.innerWidth });

          const isMobileResult = isMobileDevice || isSmallScreen;
          setIsMobile(isMobileResult);
          console.log('✅ 移动端检测完成:', isMobileResult);
        } catch (error) {
          console.error('❌ 检测移动端失败:', error);
          // 出错时默认为非移动端
          setIsMobile(false);
        }
      };

      checkMobile();
      window.addEventListener('resize', checkMobile);
      return () => window.removeEventListener('resize', checkMobile);
    } catch (error) {
      console.error('❌ 初始化移动端检测失败:', error);
    }
  }, []);

  // 同步anchorPoints到ref
  useEffect(() => {
    anchorPointsRef.current = anchorPoints;
  }, [anchorPoints]);

  // 确保只在客户端渲染完成后才显示图片 - 使用 useEffect 避免阻塞渲染
  useEffect(() => {
    try {
      // 确保在客户端环境中才设置mounted
      if (typeof window !== 'undefined') {
        setMounted(true);
        console.log('📱 mounted已设置，页面应正常显示');
      }
    } catch (error) {
      console.error('设置mounted状态失败:', error);
      // 即使出错也设置mounted，避免页面一直卡在加载状态
      setMounted(true);
    }
  }, []);

  // 预加载示例图片 - 在页面加载时预先下载，提升打开示例弹窗的体验
  useEffect(() => {
    const preloadImage = () => {
      const img = new Image();
      img.src = '/assets/example.jpg';
      img.onload = () => {
        console.log('✅ 示例图片预加载完成');
        exampleImageLoadedRef.current = true;
        setExampleImageLoading(false);
      };
      img.onerror = () => {
        console.warn('⚠️ 示例图片预加载失败');
      };
    };

    // 延迟 1 秒预加载，避免影响页面初始化性能
    const timer = setTimeout(preloadImage, 1000);
    return () => clearTimeout(timer);
  }, []);

  // 预热API资源 - 在转调设置界面出现时预热，减少首次转调的等待时间
  // 利用用户设置调性时的空闲时间预热，不影响用户体验
  const hasWarmedUpRef = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (pageState !== 'settings') return;
    if (hasWarmedUpRef.current) return; // 只预热一次

    const warmUp = async () => {
      try {
        console.log('🔥 开始预热API资源（转调设置界面）...');
        const start = Date.now();
        const response = await fetch('/api/warmup');
        if (response.ok) {
          const data = await response.json();
          console.log('✅ API资源预热完成:', {
            totalDuration: data.totalDuration,
            results: data.results,
          });
          hasWarmedUpRef.current = true;
        } else {
          console.warn('⚠️ 预热请求失败:', response.status);
        }
      } catch (error) {
        console.warn('⚠️ 预热失败（不影响正常使用）:', error);
      }
    };

    // 立即执行，不延迟（因为用户正在设置调性，有足够时间）
    warmUp();
  }, [pageState]);

  // 监听图片加载，根据文本框尺寸调整第二个瞄准框的位置（保持固定像素间隔）
  useEffect(() => {
    if (!imageSrc || anchorPoints.length !== 2 || !imageContainerRef.current) {
      return;
    }

    const container = imageContainerRef.current;
    const image = imageRef.current;

    // 等待图片加载完成
    const adjustSecondAnchor = () => {
      if (!image || !image.complete || image.naturalWidth === 0) {
        // 图片未加载完成，稍后重试
        setTimeout(adjustSecondAnchor, 100);
        return;
      }

      const rect = container.getBoundingClientRect();
      const imageHeight = rect.height;

      if (imageHeight === 0) {
        return;
      }

      const firstAnchor = anchorPoints[0];
      const firstYPx = (firstAnchor.y / 100) * imageHeight;

      // 计算固定像素间隔：文本框高度 + 上下间距 + 矩形框高度 + 额外间隔
      const { textHeight, textSpacing } = getTextBoxDimensions();
      const boxHeight = 0.02; // 2%
      const boxHeightPx = boxHeight * imageHeight;
      const extraInterval = isMobile ? 40 : 70; // 额外间隔（移动端40px，桌面端70px）
      const fixedIntervalPx = textHeight + 2 * textSpacing + boxHeightPx + extraInterval;

      // 计算第二个瞄准框的纵坐标（百分比）
      const secondYPx = firstYPx + fixedIntervalPx;
      const secondY = (secondYPx / imageHeight) * 100;

      // 更新第二个瞄准框的位置
      setAnchorPoints(prev => {
        if (prev.length !== 2) return prev;
        return [
          prev[0],
          { x: prev[1].x, y: secondY }
        ];
      });

      console.log('🎯 第二个瞄准框位置已调整:', {
        firstYPx,
        fixedIntervalPx,
        secondYPx,
        secondY,
      });
    };

    adjustSecondAnchor();
  }, [imageSrc, anchorPoints.length, isMobile]);

  // Pointer Events 事件处理函数（跨平台统一方案）

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 只在定位状态下允许拖动，且不在识别中
    if (pageState !== 'locating_first' && pageState !== 'locating_last') {
      return;
    }

    // 如果正在识别，禁止拖动
    if (isRecognizing) {
      return;
    }

    // 检测是否是多指操作（缩放手势）
    activePointersRef.current.add(e.pointerId);
    if (activePointersRef.current.size > 1) {
      // 多指操作，不允许触发长按和拖动，允许缩放手势
      return;
    }

    const container = imageContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const pointerX = e.clientX - containerRect.left;
    const pointerY = e.clientY - containerRect.top;

    const markerIndex = isTouchOnMarker(pointerX, pointerY);

    if (markerIndex !== null) {
      // 指针在图标上，但不立即阻止默认行为（允许滚动）
      // 启动长按计时器，长按后才进入拖动模式

      // 重置拖动标志
      hasDraggedRef.current = false;
      isLongPressedRef.current = false;

      // 记录初始位置，用于判断是否移动太多
      initialTouchPosRef.current = { x: pointerX, y: pointerY };
      draggingIndexRef.current = markerIndex;
      touchMovedTooMuchRef.current = false;

      // 计算鼠标相对于图标中心的偏移量（用于拖动时保持相对位置）
      const point = anchorPointsRef.current[markerIndex];
      const markerCenterX = (point.x / 100) * containerRect.width;
      const markerCenterY = (point.y / 100) * containerRect.height;
      dragOffsetRef.current = {
        x: pointerX - markerCenterX,
        y: pointerY - markerCenterY,
      };

      // 启动长按计时器（400ms）
      longPressTimerRef.current = setTimeout(() => {
        // 长按成功，进入拖动模式
        isLongPressedRef.current = true;
        hasLongPressedRef.current = true;
        isDraggingRef.current = true;
        setDraggingIndex(markerIndex);
        
        // 视觉反馈：红线变橙色
        setLongPressedIndex(markerIndex);

        // 触觉反馈（仅移动端支持）
        if ('vibrate' in navigator && e.pointerType === 'touch') {
          navigator.vibrate(50);
        }
        
        console.log('🟠 长按成功，进入拖动模式');
      }, 400);

      console.log('👆 触摸到图标，等待长按...');
    } else {
      // 如果不在图标上，不启动拖动，也不阻止默认行为（允许滚动）
      isLongPressedRef.current = false;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 只在定位状态下允许拖动
    if (pageState !== 'locating_first' && pageState !== 'locating_last') {
      return;
    }

    // 如果正在识别，禁止拖动
    if (isRecognizing) {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;

    // 如果在等待长按期间（有计时器但还没进入拖动模式）
    if (longPressTimerRef.current && !isDraggingRef.current) {
      // 检查是否移动太多（超过10px则取消长按）
      if (initialTouchPosRef.current) {
        const dx = pointerX - initialTouchPosRef.current.x;
        const dy = pointerY - initialTouchPosRef.current.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 10) {
          // 移动太多，取消长按，允许滚动
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
          draggingIndexRef.current = null;
          initialTouchPosRef.current = null;
          console.log('🟡 移动太多，取消长按');
          return;
        }
      }
      return; // 在等待长按期间，不处理移动
    }

    // 只有在拖动模式下才处理移动
    if (!isDraggingRef.current || draggingIndexRef.current === null) {
      return;
    }

    // 阻止默认滚动，处理拖动
    e.preventDefault();
    e.stopPropagation();

    const container = imageContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();

    // 计算鼠标在容器中的位置
    const mouseX = e.clientX - containerRect.left;
    const mouseY = e.clientY - containerRect.top;

    // 减去偏移量，得到新的图标中心位置
    const newCenterX = dragOffsetRef.current ? mouseX - dragOffsetRef.current.x : mouseX;
    const newCenterY = dragOffsetRef.current ? mouseY - dragOffsetRef.current.y : mouseY;

    // 转换为百分比坐标
    const x = Math.max(0, Math.min(100, (newCenterX / containerRect.width) * 100));
    const y = Math.max(0, Math.min(100, (newCenterY / containerRect.height) * 100));

    // 标记发生了拖动
    hasDraggedRef.current = true;

    // 更新图标位置
    setAnchorPoints(prev => {
      const newPoints = [...prev];
      if (draggingIndexRef.current !== null && newPoints[draggingIndexRef.current]) {
        newPoints[draggingIndexRef.current] = { x, y };
      }
      return newPoints;
    });

    // 标记发生了拖动
    hasDraggedRef.current = true;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    // 清理pointer ID
    activePointersRef.current.delete(e.pointerId);

    // 清理长按计时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // 如果发生了长按但没有拖动，标记应该阻止点击事件
    if (hasLongPressedRef.current && !hasDraggedRef.current) {
      shouldPreventClickRef.current = true;
      // 延迟重置标记，防止影响后续正常的点击
      setTimeout(() => {
        shouldPreventClickRef.current = false;
      }, 100);
    }

    // 在重置 draggingIndex 之前保存它，用于更新 hasDraggedAnchors
    const draggedIndex = draggingIndexRef.current;

    // 重置所有状态
    isLongPressedRef.current = false;
    hasLongPressedRef.current = false;
    isDraggingRef.current = false;
    draggingIndexRef.current = null;
    setDraggingIndex(null); // 重置状态，防止 handleImageClick 误判
    initialTouchPosRef.current = null;
    touchMovedTooMuchRef.current = false;
    dragOffsetRef.current = null;
    setLongPressedIndex(null);

    // 如果发生了拖动，更新 hasDraggedAnchors
    if (hasDraggedRef.current && draggedIndex !== null) {
      setHasDraggedAnchors(prev => {
        const newHasDragged = [...prev];
        newHasDragged[draggedIndex] = true;
        return newHasDragged;
      });
    }

    // 延迟重置 hasDraggedRef，防止 onClick 在 100ms 后误触发
    if (hasDraggedRef.current) {
      setTimeout(() => {
        hasDraggedRef.current = false;
      }, 100);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    // 清理pointer ID
    activePointersRef.current.delete(e.pointerId);

    // 清理长按计时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // 重置所有状态
    isLongPressedRef.current = false;
    isDraggingRef.current = false;
    draggingIndexRef.current = null;
    setDraggingIndex(null); // 重置状态
    initialTouchPosRef.current = null;
    touchMovedTooMuchRef.current = false;
    dragOffsetRef.current = null;
    setLongPressedIndex(null);
  };

  // 阻止右键菜单和长按菜单
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  };

  // 清理计时器和取消请求
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
      if (abortControllerRef.current) {
        console.log('🚫 组件卸载：取消后台AI识别请求');
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // 监听 pageState 变化，自动开始AI识别
  useEffect(() => {
    if (pageState === 'auto_recognizing' && imageSrc && !isRecognizing) {
      console.log('🤖 自动进入AI识别状态，开始识别...');
      // 使用 setTimeout 确保 state 更新完成
      const timer = setTimeout(() => {
        startAutoRecognition();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pageState, imageSrc]);

  // 处理文件上传
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const imageDataUrl = e.target?.result as string;

        // 取消之前正在进行的后台识别请求
        if (abortControllerRef.current) {
          console.log('🚫 取消之前的后台AI识别请求');
          abortControllerRef.current.abort();
        }

        // 创建新的 AbortController
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        // 获取图片尺寸，设置宽高比
        const img = new Image();
        img.onload = () => {
          const aspectRatio = img.width / img.height;
          setImageAspectRatio(aspectRatio);
          console.log('📐 图片尺寸:', { width: img.width, height: img.height, aspectRatio });
        };
        img.src = imageDataUrl;

        setImageSrc(imageDataUrl);
        setImageKey(prev => prev + 1);
        
        // 初始化两个瞄准框位置
        const firstY = 35;
        setAnchorPoints([
          { x: 50, y: firstY },
          { x: 50, y: firstY + 20 }
        ]);
        setHasDraggedAnchors([false, false]);
        setResult(null);
        setOriginalKey('');
        setIsAutoRecognized(false);
        setChordsData(null);
        setRecognitionCache(null);
        recognitionCacheRef.current = null;
        setIsRecognizing(false);
      setAutoRecognizeRetryCount(0); // 识别成功，重置重试次数
        setChordColor('#2563EB');

        // 直接开始AI自动识别
        setPageState('auto_recognizing');
      };
      reader.readAsDataURL(file);
    }
  };

  // 开始后台AI识别（方法1：手动定位时同时进行）
  const startBackgroundRecognition = async () => {
    // 取消之前正在进行的后台识别请求
    if (abortControllerRef.current) {
      console.log('🚫 取消之前的后台AI识别请求');
      abortControllerRef.current.abort();
    }

    // 创建新的 AbortController
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsBackgroundRecognizing(true);
    isBackgroundRecognizingRef.current = true;

    try {
      const blob = await fetch(imageSrc).then(res => res.blob());
      const imageFile = new File([blob], 'image.jpg', { type: 'image/jpeg' });

      const formData = new FormData();
      formData.append('image', imageFile);
      formData.append('onlyRecognizeKey', 'true');
      formData.append('modelMode', modelMode); // 传递模型选择

      console.log('🚀 开始后台AI识别...');

      const timeoutId = setTimeout(() => {
        console.log('⏱️ 后台识别请求超时（90秒），正在取消...');
        abortController.abort();
      }, 90000);

      fetch('/api/transpose', {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      })
      .then(res => {
        clearTimeout(timeoutId);
        if (!res.ok) {
          throw new Error(`识别失败: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        console.log('✅ 后台AI识别完成:', {
          originalKey: data.originalKey,
          centersCount: data.recognizedCenters?.length || 0,
        });

        const newCache = {
          key: data.originalKey || null,
          centers: data.recognizedCenters || [],
          timestamp: Date.now(),
        };
        setRecognitionCache(newCache);
        recognitionCacheRef.current = newCache;

        if (data.originalKey) {
          setOriginalKey(data.originalKey);
          setIsAutoRecognized(true);
          console.log('🎵 后台自动识别原调成功:', data.originalKey);
        }

        setIsBackgroundRecognizing(false);
        isBackgroundRecognizingRef.current = false;
      })
      .catch(error => {
        if (error.name === 'AbortError') {
          console.log('🚫 后台AI识别请求已被取消');
          return;
        }
        console.error('❌ 后台AI识别失败:', error);
        setIsBackgroundRecognizing(false);
        isBackgroundRecognizingRef.current = false;
      });
    } catch (error) {
      console.error('❌ 后台AI识别初始化失败:', error);
      setIsBackgroundRecognizing(false);
      isBackgroundRecognizingRef.current = false;
    }
  };

  // 开始自动识别（方法2：直接使用AI坐标）
  const startAutoRecognition = async (retryCount = 0) => {
    // 取消之前正在进行的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsRecognizing(true);
    setAutoRecognizeProgress(0);
    setAutoRecognizeRetryCount(retryCount); // 更新重试次数状态

    // 平滑进度模拟（实际进度由 API 返回决定）
    // 使用更小的更新间隔和增量，让进度条看起来更平滑
    // 根据模型模式调整速度：快速模式更快，精准模式更慢
    // 快速模式约 15-20秒，精准模式约 50秒
    let progressInterval: NodeJS.Timeout | null = null;
    let currentProgress = 0;
    const baseSpeed = modelMode === 'fast' ? 2.2 : 0.9; // 快速模式: 2.2, 精准模式: 0.9 (约50秒到95%)

    const startProgressSimulation = () => {
      progressInterval = setInterval(() => {
        let speed = baseSpeed;
        // 根据当前进度调整速度
        if (modelMode === 'fast' && currentProgress > 80) {
          speed = baseSpeed * 0.6; // 快速模式：80% 以上稍微放慢
        } else if (modelMode !== 'fast' && currentProgress > 70) {
          speed = baseSpeed * 0.6; // 精准模式：70% 以上稍微放慢
        }
        
        // 添加随机波动，让进度看起来更自然
        const increment = (0.3 + Math.random() * 0.4) * speed;
        currentProgress = Math.min(currentProgress + increment, 95);
        setAutoRecognizeProgress(currentProgress);
      }, 200); // 更频繁的更新，让进度条更平滑
    };

    const stopProgressSimulation = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };

    startProgressSimulation();

    let didTimeout = false;

    try {
      const blob = await fetch(imageSrc).then(res => res.blob());
      const imageFile = new File([blob], 'image.jpg', { type: 'image/jpeg' });

      const formData = new FormData();
      formData.append('image', imageFile);
      formData.append('onlyRecognizeKey', 'true');
      formData.append('useDirectCoordinates', 'true'); // 标记使用直接坐标模式
      formData.append('modelMode', modelMode); // 传递模型选择

      console.log('🚀 开始自动识别（方法2）...');

        const timeoutMs = modelMode === 'fast' ? 120000 : 180000;
        const timeoutId = setTimeout(() => {
          didTimeout = true;
          console.log(`⏱️ 自动识别超时（${Math.round(timeoutMs / 1000)}秒），正在取消...`);
          abortController.abort();
        }, timeoutMs);

      const response = await fetch('/api/transpose', {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);
      stopProgressSimulation();

      if (!response.ok) {
        throw new Error(`识别失败: ${response.status}`);
      }

      const data = await response.json();

      console.log('✅ 自动识别完成:', {
        originalKey: data.originalKey,
        centersCount: data.recognizedCenters?.length || 0,
        sampleCenters: data.recognizedCenters?.slice(0, 3),
      });


      // 检查是否有有效的识别结果
      if (!data.recognizedCenters || data.recognizedCenters.length === 0) {
        if (retryCount === 0) {
          // 第一次失败，重试一次
          console.log('🔄 第一次识别失败，正在重试...');
          setIsRecognizing(false);
          setTimeout(() => {
            startAutoRecognition(1);
          }, 1000);
          return;
        } 
        else {
          // 第二次失败，返回上传界面
          alert('AI 识别失败，请重新上传图片');
          setPageState('upload');
          setIsRecognizing(false);
          setAutoRecognizeProgress(0);
          setAutoRecognizeRetryCount(0); // 重置重试次数
          setImageSrc('');
          setAnchorPoints([]);
          setResult(null);
          setOriginalKey('');
          return;
        }
      }
      // 只有到这里才说明识别成功
      setAutoRecognizeProgress(100);
      
      // 对识别到的和弦文本进行预处理
      if (data.recognizedCenters) {
        data.recognizedCenters.forEach((center: any) => {
          if (center.text) {
            center.text = preprocessChordSequence(center.text, data.originalKey);
          }
        });
      }
      // 预处理结束

      // 保存识别结果
      const newCache = {
        key: data.originalKey || null,
        centers: data.recognizedCenters || [],
        timestamp: Date.now(),
      };
      setRecognitionCache(newCache);
      recognitionCacheRef.current = newCache;
      setChordsData(newCache);

      // 标记使用直接坐标模式（方法2）
      setUseDirectCoordinates(true);
      console.log('📍 方法2：启用直接坐标模式，不使用锚点校准');

      if (data.originalKey) {
        setOriginalKey(data.originalKey);
        setIsAutoRecognized(true);
      }

      setIsRecognizing(false);

      // 延迟一下再跳转，让用户看到完成状态
      setTimeout(() => {
        setPageState('settings');
      }, 500);

  } catch (error: any) {
    stopProgressSimulation();
  
    if (error.name === 'AbortError') {
      console.log('🚫 自动识别请求已被取消');

      // 避免 UI 卡死在“识别中”
      setIsRecognizing(false);
      setAutoRecognizeProgress(0);
      setAutoRecognizeRetryCount(0);

      if (didTimeout) {
        alert('识别超时，请重试或换更清晰的图片');
        setPageState('upload');
        setImageSrc('');
        setAnchorPoints([]);
        setResult(null);
        setOriginalKey('');
      }
      return;
    }
  
    console.error('❌ 自动识别失败:', error);
    
    if (retryCount === 0) {
      // 第一次失败，重试一次
      console.log('🔄 第一次识别失败，正在重试...');
      setIsRecognizing(false);
      setTimeout(() => {
        startAutoRecognition(1);
      }, 1000);
    } else {
      // 第二次失败，返回上传界面
      setAutoRecognizeProgress(0);
      setIsRecognizing(false);
      setAutoRecognizeRetryCount(0); // 重置重试次数
      alert('识别失败：' + (error.message || '未知错误') + '，请重新上传图片');
      setPageState('upload');
      setImageSrc('');
      setAnchorPoints([]);
      setResult(null);
      setOriginalKey('');
    }
    }
  }

  // 更换图片
  const handleChangeImage = () => {
    console.log('🔄 更换图片：清空所有缓存和状态');

    // 取消正在进行的后台识别请求
    if (abortControllerRef.current) {
      console.log('🚫 取换图片：取消后台AI识别请求');
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // 标记请求被取消
    isRequestAbortedRef.current = true;

    setPageState('upload');
    setImageSrc('');
    setAnchorPoints([]);
    setResult(null);
    setOriginalKey('');
    setIsAutoRecognized(false);
    setChordsData(null); // 清空预存和弦数据，因为更换了图片
    setRecognitionCache(null); // 清除识别缓存
    recognitionCacheRef.current = null; // 同步清空 ref
    isBackgroundRecognizingRef.current = false; // 清除后台识别状态 ref
    setIsBackgroundRecognizing(false); // 清除后台识别状态
    setTargetKey('');
    setDirection('');
    setSemitones('');
    setIsRecognizing(false);
    setAutoRecognizeProgress(0); // 重置自动识别进度
    setUseDirectCoordinates(false); // 重置直接坐标模式标记
    setChordColor('#2563EB'); // 重置为默认蓝色
    setFontSize(null); // 重置字体大小
    setSessionResults([]); // 清空当前会话结果
    setCurrentSessionIndex(0); // 重置会话索引

    // 额外保险：使用 setTimeout 确保所有状态更新完成
    setTimeout(() => {
      console.log('✅ 所有状态已清空，准备选择新图片');
      fileInputRef.current?.click();
    }, 150);
  };

  // 处理图片点击
  const handleImageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // 如果刚刚发生了长按但没有拖动，不处理点击（防止长按松手后误触发）
    if (shouldPreventClickRef.current) return;

    // 如果正在拖拽，不处理点击
    if (draggingIndex !== null) return;

    // 如果刚刚发生了拖动，不处理点击（防止在拖动结束时误触发）
    if (hasDraggedRef.current) return;

    // 如果已经有2个和弦，禁止点击添加新和弦
    if (anchorPoints.length >= 2) {
      return;
    }

    const container = imageContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;

    const newPoints = [...anchorPoints, { x, y }];
    setAnchorPoints(newPoints);

    if (pageState === 'locating_first') {
      setPageState('locating_last');
    } else if (pageState === 'locating_last') {
      // 两个和弦都已选择，等待用户确认
    }
  };

  // 处理标记拖拽开始
  // 判断指针位置是否在某个矩形框或文字框区域内
  const isTouchOnMarker = (pointerX: number, pointerY: number): number | null => {
    try {
      const container = imageContainerRef.current;
      if (!container) return null;

      const image = imageRef.current;
      if (!image) return null;

      if (typeof window === 'undefined') return null;

      const rect = container.getBoundingClientRect();
      const containerWidth = rect.width; // 容器在屏幕上的实际显示宽度
      const containerHeight = rect.height;
      const imageWidth = image.width;
      const imageHeight = image.height;

      // 矩形框高度（图片高度的4%）
      const boxHeight = imageHeight * 0.04;
      // 扩展区域：矩形框高度的0.5倍
      const touchPadding = boxHeight * 0.5;

      // 文字字体大小和行高
      const isCurrentlyMobile = isMobile;
      const fontSize = isCurrentlyMobile ? 16 : 18;
      // 移动端使用更小的字体，防止换行
      const actualFontSize = isCurrentlyMobile ? Math.min(fontSize, 13) : fontSize;
      const lineHeight = actualFontSize * 1.4;
      // 移动端使用更小的 padding
      const paddingVertical = isCurrentlyMobile ? 3 : 6;
      const textHeight = lineHeight + paddingVertical * 2;
      const textSpacing = isCurrentlyMobile ? 5 : 15; // 文字和矩形框的间距

      for (let i = 0; i < anchorPointsRef.current.length; i++) {
        const point = anchorPointsRef.current[i];
        // 矩形框中心Y坐标
        const centerY = (point.y / 100) * containerHeight;

        // 计算白色背景框的范围（覆盖红线上方 + 红线 + 红线下方 + 文本框 + 上下扩展区域）
        // 高度增加15%
        // 第一个图标：上端与文本框的相对位置不变，高度增加15%，下端相对位置更低
        // 第二个图标：下端与文本框的相对位置不变，高度增加15%，上端相对位置更高
        let whiteBoxTop, whiteBoxBottom;
        const boxHeightPercent = (boxHeight / containerHeight) * 100; // 2%
        
        if (i === 0) {
          // 第一个图标：白色框从红线上方开始（centerY - boxHeight/2）
          // 上端向上移动 baseHeight * 0.15，高度增加15%，下端相对位置更低
          const baseHeightPercent = 2 + ((textHeight + 2 * textSpacing) / containerHeight) * 100;
          const baseHeightPx = (baseHeightPercent / 100) * containerHeight;
          whiteBoxTop = centerY - boxHeight / 2 - baseHeightPx * 0.15;
          // 白色框高度：(2% + (textHeight + 2 * textSpacing) / containerHeight) * 1.15
          const increasedHeightPercent = baseHeightPercent * 1.15;
          const increasedHeightPx = (increasedHeightPercent / 100) * containerHeight;
          whiteBoxBottom = whiteBoxTop + increasedHeightPx;
        } else {
          // 第二个图标：白色框底部到红线下方（centerY + boxHeight/2）
          // 下端向下移动 baseHeight * 0.15，高度增加15%，上端相对位置更高
          whiteBoxBottom = centerY + boxHeight / 2;
          // 白色框高度：(2% + (textHeight + 2 * textSpacing) / containerHeight) * 1.15
          const baseHeightPercent = 2 + ((textHeight + 2 * textSpacing) / containerHeight) * 100;
          const increasedHeightPercent = baseHeightPercent * 1.15;
          const increasedHeightPx = (increasedHeightPercent / 100) * containerHeight;
          whiteBoxTop = whiteBoxBottom - increasedHeightPx;
        }

        // 检测点是否在白色背景框区域内（横向占据整个图片宽度）
        if (
          pointerX >= 0 &&
          pointerX <= containerWidth &&
          pointerY >= whiteBoxTop &&
          pointerY <= whiteBoxBottom
        ) {
          return i;
        }
      }

      return null;
    } catch (error) {
      console.error('检测触摸位置失败:', error);
      return null;
    }
  };

  // 确认选择并检查识别结果（优先使用后台AI识别的结果）
  const handleConfirmSelection = async () => {
    if (anchorPoints.length !== 2 || isRecognizing) return;

    // 优先从ref读取最新值，避免闭包问题
    const currentCache = recognitionCacheRef.current || recognitionCache;
    const currentIsRecognizing = isBackgroundRecognizingRef.current;

    console.log('🔍 handleConfirmSelection 调用，当前状态:', {
      isBackgroundRecognizing,
      isBackgroundRecognizingRef: currentIsRecognizing,
      recognitionCache: recognitionCache ? {
        key: recognitionCache.key,
        centersCount: recognitionCache.centers?.length || 0,
        timestamp: new Date(recognitionCache.timestamp).toLocaleTimeString()
      } : null,
      recognitionCacheRef: currentCache ? {
        key: currentCache.key,
        centersCount: currentCache.centers?.length || 0,
        timestamp: new Date(currentCache.timestamp).toLocaleTimeString()
      } : null,
      originalKey
    });

    // 如果已经有后台AI识别结果（从state或ref中），直接使用
    if (currentCache && currentCache.centers && currentCache.centers.length > 0) {
      console.log('✅ 使用后台AI识别的缓存结果:', {
        key: currentCache.key,
        centersCount: currentCache.centers.length,
        sampleCenters: currentCache.centers.slice(0, 3).map((c: any) => ({
          text: c.text,
          hasChords: !!c.chords
        }))
      });

      // 确保原调状态已更新（无论是否已有原调）
      if (currentCache.key) {
        setOriginalKey(currentCache.key);
        setIsAutoRecognized(true);
        console.log('🎵 已更新原调状态:', currentCache.key);
      }
      
      // ===== 新增预处理 =====
      const processedCache = { ...currentCache };
      if (processedCache.centers) {
        processedCache.centers.forEach((center: any) => {
          if (center.text) {
            center.text = preprocessChordSequence(center.text, processedCache.key || originalKey);
          }
        });
      }
      // ===== 预处理结束 =====
      
      // 重要：将缓存中的和弦数据设置到chordsData，避免转调时重复调用AI
      // 传递完整的recognitionCache对象，包含key和centers
      setChordsData(currentCache);
      console.log('📦 已将缓存识别结果设置到chordsData状态');

      setPageState('settings');
      setIsRecognizing(false);
      return;
    }

    // 检查后台是否正在识别或刚刚完成（使用ref获取最新值）
    if (isBackgroundRecognizingRef.current || (recognitionCache && recognitionCache.centers && recognitionCache.centers.length === 0)) {
      console.log('⏳ 后台识别进行中或等待缓存，每0.1秒检查一次...');

      // 重置请求取消标记
      isRequestAbortedRef.current = false;

      setIsRecognizing(true);

      const startTime = Date.now();
      const maxWaitTime = 60000; // 最多等待60秒（给后台识别足够的时间）
      let hasLoggedTimeout = false;

      const pollInterval = setInterval(() => {
        const elapsedTime = Date.now() - startTime;

        // 从ref读取最新值
        const currentCache = recognitionCacheRef.current;
        const currentIsRecognizing = isBackgroundRecognizingRef.current;

        // 优先检查：是否有缓存结果（使用最新的recognitionCache）
        if (currentCache && currentCache.centers && currentCache.centers.length > 0) {
          console.log('✅ 后台识别完成，使用缓存结果:', {
            key: currentCache.key,
            centersCount: currentCache.centers.length,
            elapsedTime: `${(elapsedTime / 1000).toFixed(1)}秒`
          });

          clearInterval(pollInterval);

          // 确保原调状态已更新（无论是否已有原调）
          if (currentCache.key) {
            setOriginalKey(currentCache.key);
            setIsAutoRecognized(true);
            console.log('🎵 已更新原调状态:', currentCache.key);
          }
          // ===== 新增预处理 =====
          const processedCache = { ...currentCache };
          if (processedCache.centers) {
            processedCache.centers.forEach((center: any) => {
              if (center.text) {
                center.text = preprocessChordSequence(center.text, processedCache.key || originalKey);
              }
            });
          }
          // ===== 预处理结束 =====
          setChordsData(currentCache);
          console.log('📦 已将缓存识别结果设置到chordsData状态');

          setPageState('settings');
          setIsRecognizing(false);
          return;
        }

        // 检查后台是否已经完成但没有缓存（识别失败）
        // 重要：只有在识别停止 AND 等待超过3秒 AND 还是没有缓存时，才判定为失败
        // 避免在状态转换的瞬间（isBackgroundRecognizing从true变为false时）误判
        const isActuallyFailed = !currentIsRecognizing && (!currentCache || currentCache.centers.length === 0) && (elapsedTime > 3000);

        // 🔍 添加详细的状态日志，每秒输出一次
        if (elapsedTime > 1000 && Math.floor(elapsedTime / 1000) * 1000 === elapsedTime) {
          console.log(`📊 轮询状态检查（${(elapsedTime / 1000).toFixed(1)}秒）:`, {
            elapsedTime: `${(elapsedTime / 1000).toFixed(1)}秒`,
            isBackgroundRecognizing: currentIsRecognizing,
            currentCache: currentCache ? {
              hasCache: true,
              key: currentCache.key,
              centersCount: currentCache.centers?.length || 0,
              timestamp: new Date(currentCache.timestamp).toLocaleTimeString()
            } : { hasCache: false },
            isActuallyFailed,
            isRequestAborted: isRequestAbortedRef.current
          });
        }

        if (isActuallyFailed) {
          // 检查是否是请求被取消（用户更换图片）
          if (isRequestAbortedRef.current) {
            console.log('🚫 请求已被取消（用户更换图片），不显示错误');
            clearInterval(pollInterval);
            setIsRecognizing(false);
            isRequestAbortedRef.current = false; // 重置标记
            return;
          }

          console.log('⚠️ 后台识别已完成但没有缓存，可能识别失败');
          console.log('❌ 详细状态:', {
            currentIsRecognizing,
            currentCache,
            elapsedTime: `${(elapsedTime / 1000).toFixed(1)}秒`,
            recognitionCache,
            isBackgroundRecognizing,
            isRequestAborted: isRequestAbortedRef.current
          });
          clearInterval(pollInterval);
          setIsRecognizing(false);
          alert('识别失败，请重新上传图片');
          setPageState('upload'); // 回到上传界面
          setImageSrc(''); // 清空图片
          setAnchorPoints([]);
          return;
        }

        // 超时检查：如果后台还在进行，且等待超时了
        if (elapsedTime >= maxWaitTime && !hasLoggedTimeout) {
          hasLoggedTimeout = true;
          console.log(`⏱️ 等待超时 (${(maxWaitTime / 1000).toFixed(0)}秒)，当前状态:`, {
            isBackgroundRecognizing: currentIsRecognizing,
            hasCache: !!(currentCache && currentCache.centers && currentCache.centers.length > 0)
          });

          // 显示错误提示
          clearInterval(pollInterval);
          setIsRecognizing(false);
          alert('识别超时，请重新上传图片');
          setPageState('upload'); // 回到上传界面
          setImageSrc(''); // 清空图片
          setAnchorPoints([]);
          return;
        }
      }, 100); // 每0.1秒（100ms）检查一次

      return;
    }

    // 如果后台识别已完成但没有缓存结果（识别失败或超时）
    // 重要：这个判断必须在"后台正在识别"的判断之后
    // 因为即使后台刚开始识别，也还没有缓存，这时不应该报错
    if (!currentIsRecognizing && !currentCache) {
      console.log('⚠️ 后台识别已完成但没有缓存结果（识别失败）');
      console.log('❌ 详细状态:', {
        currentIsRecognizing,
        currentCache,
        recognitionCache,
        isBackgroundRecognizing,
        isRequestAborted: isRequestAbortedRef.current,
        recognitionCacheRef: recognitionCacheRef.current
      });
      // 检查是否是请求被取消（用户更换图片）
      if (isRequestAbortedRef.current) {
        console.log('🚫 请求已被取消（用户更换图片），不显示错误');
        setIsRecognizing(false);
        isRequestAbortedRef.current = false; // 重置标记
        return;
      }

      setIsRecognizing(false);
      alert('识别失败，请重新上传图片');
      setPageState('upload'); // 回到上传界面
      setImageSrc(''); // 清空图片
      setAnchorPoints([]);
      return;
    }
  };

  // 用户手动选择原调时，清除自动识别标记
  // 用户手动选择原调时，清除自动识别标记
  const handleManualSelectOriginalKey = (key: string) => {
    setOriginalKey(key);
    setIsAutoRecognized(false); // 用户手动选择，标记为非自动识别
  };

  // 自动计算半音数和方向（优先选择小的）
  useEffect(() => {
    console.log('🎵 转调计算触发:', { originalKey, targetKey });
    if (originalKey && originalKey !== 'auto' && targetKey) {
      const originalIndex = getKeyIndex(originalKey);
      const targetIndex = getKeyIndex(targetKey);

      console.log('🔢 调号索引:', { 
        originalKey, 
        originalIndex,
        targetKey,
        targetIndex,
      });

      if (originalIndex !== -1 && targetIndex !== -1) {
        // 计算两个可能的半音数
        const upSemitones = (targetIndex - originalIndex + 12) % 12;
        const downSemitones = (originalIndex - targetIndex + 12) % 12;

        console.log('📊 半音数:', { upSemitones, downSemitones });

        // 优先选择半音数较小的方向
        if (upSemitones <= downSemitones) {
          setDirection('up');
          setSemitones(upSemitones);
          console.log('✅ 设置方向: up, 半音数:', upSemitones);
        } else {
          setDirection('down');
          setSemitones(downSemitones);
          console.log('✅ 设置方向: down, 半音数:', downSemitones);
        }
      } else {
        console.error('❌ 调号索引无效:', { originalIndex, targetIndex });
      }
    } else {
      console.log('⏭️ 跳过计算: originalKey或targetKey为空或为auto');
    }
  }, [targetKey, originalKey]);

  // 开始转调处理
  const handleTranspose = async () => {
    if (!imageSrc || !targetKey || !direction || semitones === '') return;

    console.log('🔄 开始转调:', {
      targetKey,
      direction,
      semitones,
      hasChordsData: !!chordsData,
      chordsDataCount: chordsData?.length || 0
    });

    setPageState('processing');

    try {
      const response = await fetch(imageSrc);
      const blob = await response.blob();
      const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });

      const formData = new FormData();
      formData.append('image', file);
      formData.append('targetKey', targetKey);

      console.log('📤 转调请求参数:', {
        targetKey,
        originalKey,
        direction,
        semitones,
        hasChordsData: !!chordsData,
        chordsDataCount: chordsData?.length || 0
      });

      if (originalKey) {
        formData.append('originalKey', originalKey);
      }
      formData.append('direction', direction);
      formData.append('semitones', semitones.toString());

      // 只有方法1（手动定位）才传递锚点，方法2（直接坐标）不传递锚点
      if (anchorPoints.length === 2 && !useDirectCoordinates) {
        console.log('📍 方法1：传递锚点进行Y轴校准', {
          first: anchorPoints[0],
          last: anchorPoints[1]
        });
        formData.append('anchorFirst', JSON.stringify(anchorPoints[0]));
        formData.append('anchorLast', JSON.stringify(anchorPoints[1]));
      } else if (useDirectCoordinates) {
        console.log('📍 方法2：使用直接坐标模式，不传递锚点');
      }

      formData.append('chordColor', chordColor);
      // 第一次转调不传fontSize，让后端自动计算

      // 传递之前识别的和弦数据，避免重复调用大模型
      if (chordsData) {
        console.log('📦 准备传递预存和弦数据:', {
          hasKey: !!chordsData.key,
          key: chordsData.key,
          centersCount: chordsData.centers?.length || 0,
          timestamp: chordsData.timestamp ? new Date(chordsData.timestamp).toLocaleTimeString() : 'N/A',
          sampleCenters: chordsData.centers?.slice(0, 3).map((c: any) => ({
            text: c.text,
            hasChords: !!c.chords
          }))
        });
        formData.append('chordsData', JSON.stringify(chordsData));
        console.log('📦 已将预存和弦数据添加到请求中');
      } else {
        console.log('📦 没有预存和弦数据，后端将调用大模型识别');
      }

      const tFetch0 = performance.now();
      const apiResponse = await fetch('/api/transpose', {
        method: 'POST',
        body: formData,
      });
      const tFetch1 = performance.now();

      const data = await apiResponse.json();
      const tFetch2 = performance.now();

      const contentLength = apiResponse.headers.get('content-length');

      const responseHeaders = {
        date: apiResponse.headers.get('date'),
        server: apiResponse.headers.get('server'),
        contentLength,
        xVercelId: apiResponse.headers.get('x-vercel-id'),
        xTraceId: apiResponse.headers.get('x-trace-id'),
        serverTiming: apiResponse.headers.get('server-timing'),
      };

      const transposeTimings = {
        headersMs: Math.round(tFetch1 - tFetch0),
        bodyJsonMs: Math.round(tFetch2 - tFetch1),
        totalMs: Math.round(tFetch2 - tFetch0),
        contentLength,
      };

      if (debugMode) {
        setLastTransposeDebug({
          timings: transposeTimings,
          headers: responseHeaders,
          debug: data?.debug,
          ok: apiResponse.ok,
          status: apiResponse.status,
          error: data?.error,
        });
      }

      console.log('✅ 转调API返回数据:', {
        ok: apiResponse.ok,
        status: apiResponse.status,
        hasError: !!data.error,
        errorMessage: data.error,
        hasResultImage: !!data.resultImage,
        chordsCount: data.chords?.length,
        originalKey: data.originalKey,
        targetKey: data.targetKey,
        debug: data.debug,
        timings: transposeTimings,
      });

      if (!apiResponse.ok) {
        console.error('❌ 转调API返回错误:', {
          status: apiResponse.status,
          statusText: apiResponse.statusText,
          errorData: data,
          debug: data?.debug,
        });
        alert(`转调失败: ${data.error || '未知错误'}`);
        setPageState('settings');
        return;
      }

      setResult(data);
      // 设置字号为后端返回的实际值（用于显示）
      if (data.fontSize) {
        setFontSize(data.fontSize);
      }
      setPageState('result');
      
      // 添加到当前会话结果（用于左右箭头导航）
      setSessionResults(prev => [{ ...data }, ...prev]);
      setCurrentSessionIndex(0);
    } catch (error) {
      console.error('转调失败:', error);
      alert('转调失败，请稍后重试');
      setPageState('settings');
    }
  };

  // 调整字体或颜色后重新生成图片
  const handleAdjustment = async (newFontSize?: number, newChordColor?: string) => {
    if (!imageSrc || !targetKey || !direction || semitones === '') return;

    // 使用传入的新值（如果有的话），否则使用当前状态
    const actualFontSize = newFontSize ?? fontSize;
    const actualChordColor = newChordColor ?? chordColor;

    setIsAdjusting(true);

    try {
      // 检查当前会话结果是否有chords数据（说明已经经过手动定位或识别）
      const currentResult = sessionResults[currentSessionIndex];

      if (currentResult && currentResult.chords && currentResult.chords.length > 0) {
        // 使用现有的chords数据重新渲染，保持Y坐标不变（包括手动定位修正后的坐标）
        console.log('🎨 调整：使用现有chords数据重新渲染（保持Y坐标）');
        console.log('📋 chords数据检查:', {
          hasChords: !!currentResult.chords,
          chordsCount: currentResult.chords.length,
          hasOriginalKey: !!currentResult.originalKey,
          hasTargetKey: !!currentResult.targetKey,
          sampleChord: currentResult.chords[0]
        });

        const requestData = {
          chords: currentResult.chords,
          originalKey: currentResult.originalKey || originalKey,
          targetKey: currentResult.targetKey || targetKey,
          chordColor: actualChordColor,
          fontSize: actualFontSize,
          imageBase64: imageSrc,
        };

        console.log('📤 发送到render API的请求:', {
          chordsCount: requestData.chords.length,
          originalKey: requestData.originalKey,
          targetKey: requestData.targetKey,
          chordColor: requestData.chordColor,
          fontSize: requestData.fontSize
        });

        const response = await fetch('/api/render', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestData),
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error('❌ render API返回错误:', errorData);
          throw new Error(`渲染失败: ${errorData.error || '未知错误'}`);
        }

        const data = await response.json();
        console.log('✅ render API返回成功:', {
          hasResultImage: !!data.resultImage,
          chordsCount: data.chords?.length,
          fontSize: data.fontSize,
          chordColor: data.chordColor
        });
        setResult(data);

        // 替换当前会话结果
        setSessionResults(prev => {
          const newResults = [...prev];
          newResults[currentSessionIndex] = { ...data };
          return newResults;
        });
      } else {
        // 原有的重新识别流程
        const response = await fetch(imageSrc);
        const blob = await response.blob();
        const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });

        const formData = new FormData();
        formData.append('image', file);
        formData.append('targetKey', targetKey);
        if (originalKey) {
          formData.append('originalKey', originalKey);
        }
        formData.append('direction', direction);
        formData.append('semitones', semitones.toString());
        if (anchorPoints.length === 2) {
          formData.append('anchorFirst', JSON.stringify(anchorPoints[0]));
          formData.append('anchorLast', JSON.stringify(anchorPoints[1]));
        }
        formData.append('chordColor', actualChordColor);
        if (actualFontSize) {
          formData.append('fontSize', actualFontSize.toString());
        }

        // 传递之前识别的和弦数据，避免重复调用大模型
        if (chordsData) {
          formData.append('chordsData', JSON.stringify(chordsData));
          console.log('📦 调整时使用预存和弦数据，跳过大模型调用');
        }

        const apiResponse = await fetch('/api/transpose', {
          method: 'POST',
          body: formData,
        });

        const data = await apiResponse.json();
        setResult(data);

        // 替换当前会话结果
        setSessionResults(prev => {
          const newResults = [...prev];
          newResults[currentSessionIndex] = { ...data };
          return newResults;
        });
      }

      // 设置字号为后端返回的实际值（用于显示）
      if (fontSize !== actualFontSize) {
        setFontSize(actualFontSize);
      }
    } catch (error) {
      console.error('调整失败:', error);
      alert('调整失败，请稍后重试');
    } finally {
      setIsAdjusting(false);
    }
  };

  // 重新定位：修正和弦位置偏离（强制重新调用大模型）
  const handleRelocate = async () => {
    if (!imageSrc || !targetKey || !direction || semitones === '') return;

    setIsRelocating(true);
    setRelocateProgress(0);

    // 进度模拟 - 重新识别使用快速模式（Lite + Vision）
    let progressInterval: NodeJS.Timeout | null = null;
    let currentProgress = 0;
    const baseSpeed = 2.2; // 快速模式速度（与第一次识别相同）

    const startProgressSimulation = () => {
      progressInterval = setInterval(() => {
        let speed = baseSpeed;
        // 根据当前进度调整速度：接近结尾时放慢
        if (currentProgress > 80) {
          speed = baseSpeed * 0.6; // 80% 以上放慢
        }
        
        // 添加随机波动，让进度看起来更自然
        const increment = (0.3 + Math.random() * 0.4) * speed;
        currentProgress = Math.min(currentProgress + increment, 95);
        setRelocateProgress(currentProgress);
      }, 200); // 更频繁的更新，让进度条更平滑
    };

    const stopProgressSimulation = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };

    startProgressSimulation();

    // 在开始识别时，先添加一个占位符（表示正在识别）
    // 这样计数会立即增加，用户能看到正确的总数（例如 2/3）
    setSessionResults(prev => [null, ...prev]);
    setCurrentSessionIndex(0);

    try {
      // 获取当前索引图片的设置（用于继承字体大小和颜色）
      const currentResult = sessionResults[currentSessionIndex];
      const actualFontSize = currentResult?.fontSize ?? fontSize;
      const actualChordColor = currentResult?.chordColor ?? chordColor;

      // 如果当前索引图片有chords数据，提取其纵向排布作为anchorPoints
      let anchorPointsToUse = anchorPoints;
      if (currentResult?.chords && currentResult.chords.length > 0) {
        const chords = currentResult.chords;

        // 提取所有和弦的纵坐标
        const yCoordinates = chords.map((chord: any) => chord.y);

        // 按纵坐标排序
        const sortedY = [...yCoordinates].sort((a, b) => a - b);

        // 分组：将纵坐标相近的和弦分为同一行
        const lines: Array<{ y: number; count: number }> = [];

        let currentLine = { y: sortedY[0], count: 1 };
        const lineHeightThreshold = 1; // 行高阈值（百分比），超过此值认为是新的一行

        for (let i = 1; i < sortedY.length; i++) {
          const y = sortedY[i];
          const diff = Math.abs(y - currentLine.y);

          if (diff < lineHeightThreshold) {
            // 同一行
            currentLine.count++;
            currentLine.y = (currentLine.y * currentLine.count + y) / (currentLine.count + 1);
          } else {
            // 新的一行
            lines.push(currentLine);
            currentLine = { y: y, count: 1 };
          }
        }
        lines.push(currentLine);

        // 使用第一行和最后一行的Y坐标作为锚点
        if (lines.length >= 2) {
          anchorPointsToUse = [
            { x: 50, y: lines[0].y }, // 第一个锚点（顶部）
            { x: 50, y: lines[lines.length - 1].y }, // 最后一个锚点（底部）
          ];
          console.log('🔄 重新识别：使用当前图片的纵向排布', anchorPointsToUse);
        } else if (lines.length === 1) {
          // 只有一行的情况
          anchorPointsToUse = [
            { x: 50, y: lines[0].y },
            { x: 50, y: lines[0].y },
          ];
          console.log('🔄 重新识别：使用当前图片的单行纵向排布', anchorPointsToUse);
        }
      }

      const response = await fetch(imageSrc);
      const blob = await response.blob();
      const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });

      const formData = new FormData();
      formData.append('image', file);
      formData.append('targetKey', targetKey);
      if (originalKey) {
        formData.append('originalKey', originalKey);
      }
      formData.append('direction', direction);
      formData.append('semitones', semitones.toString());
      if (anchorPointsToUse.length === 2) {
        formData.append('anchorFirst', JSON.stringify(anchorPointsToUse[0]));
        formData.append('anchorLast', JSON.stringify(anchorPointsToUse[1]));
      }
      formData.append('chordColor', actualChordColor);
      if (actualFontSize) {
        formData.append('fontSize', actualFontSize.toString());
      }
      formData.append('isRetry', 'true'); // 标记为重新识别，添加额外提示词

      // 调用 /api/relocate 接口，强制重新识别和弦位置
      const apiResponse = await fetch('/api/relocate', {
        method: 'POST',
        body: formData,
      });

      const data = await apiResponse.json();

      // 检查是否返回错误
      if (data.error) {
        throw new Error(data.error);
      }

      setResult(data);

      // 识别完成，用真实结果替换占位符
      setSessionResults(prev => {
        const newResults = [...prev];
        newResults[0] = { ...data };
        return newResults;
      });

      // 更新 chordsData，存储新的识别结果
      if (data.recognitionResult) {
        // ===== 新增预处理 =====
        const processed = { ...data.recognitionResult };
        if (processed.centers) {
          processed.centers.forEach((center: any) => {
            if (center.text) {
              center.text = preprocessChordSequence(center.text, processed.key || originalKey);
            }
          });
        }
        // ===== 预处理结束 =====
        
        setChordsData(processed);
        console.log('📦 重新定位完成，更新和弦数据');
      }

      // 完成进度
      stopProgressSimulation();
      setRelocateProgress(100);
    } catch (error: any) {
      stopProgressSimulation();
      console.error('重新定位失败:', error);
      // 显示具体的错误信息
      const errorMessage = error.message || '重新定位失败，请稍后重试';
      alert(errorMessage);

      // 识别失败，移除占位符
      setSessionResults(prev => {
        const newResults = [...prev];
        newResults.shift(); // 移除占位符
        return newResults;
      });
    } finally {
      setIsRelocating(false);
      setRelocateProgress(0);
    }
  };

  // 更新字号并自动调整
  const handleFontSizeChange = (newSize: number) => {
    if (isAdjusting) return;
    setFontSize(newSize);
    handleAdjustment(newSize, chordColor);
  };

  // 更新颜色并自动调整
  const handleColorChange = (newColor: string) => {
    if (isAdjusting) return;
    setChordColor(newColor);
    handleAdjustment(fontSize ?? undefined, newColor);
  };

  // 下载图片到相册
  const handleDownloadImage = () => {
    const currentResultImage = sessionResults[currentSessionIndex]?.resultImage || result?.resultImage;
    if (!currentResultImage) return;

    // 创建下载链接
    const link = document.createElement('a');
    link.href = currentResultImage;
    
    // 生成文件名：转调结果_目标调.jpg
    const currentTargetKey = sessionResults[currentSessionIndex]?.targetKey || targetKey || 'C';
    link.download = `转调结果_${currentTargetKey}.jpg`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 分享图片（使用 Web Share API）
  const handleShareImage = async () => {
    const currentResultImage = sessionResults[currentSessionIndex]?.resultImage || result?.resultImage;
    if (!currentResultImage) return;

    // 检测是否在微信环境中
    const isWeChat = /MicroMessenger/i.test(navigator.userAgent);

    if (isWeChat) {
      // 微信环境：提示用户长按图片分享
      alert('请在微信中长按图片进行分享或保存');
      return;
    }

    try {
      // 将 base64 转换为 Blob
      const base64Data = currentResultImage.split(',')[1];
      const byteCharacters = atob(base64Data);
      const byteArrays = [];

      for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
          byteNumbers[i] = slice.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
      }

      const blob = new Blob(byteArrays, { type: 'image/jpeg' });
      const file = new File([blob], '转调结果.jpg', { type: 'image/jpeg' });

      // 使用 Web Share API（如果支持）
      if (navigator.share) {
        await navigator.share({
          title: '琴献馨香 - 转调结果',
          text: `简谱转调结果 - ${sessionResults[currentSessionIndex]?.targetKey || targetKey}调`,
          files: [file]
        });
      } else {
        // 降级处理：如果不支持 Web Share API，直接下载图片
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const currentTargetKey = sessionResults[currentSessionIndex]?.targetKey || targetKey || 'C';
        link.download = `转调结果_${currentTargetKey}调.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // 用户取消了分享
        console.log('用户取消了分享');
      } else {
        console.error('分享失败:', error);
        alert('分享失败，请尝试刷新页面后重试');
      }
    }
  };

  const handleRelocateAnchors = () => {
    if (!result || !result.chords) {
      alert('没有转调结果数据，无法手动定位');
      return;
    }

    // 从转调结果中提取每行的和弦纵坐标位置（已经过Y轴重映射）
    const chords = result.chords;
    if (!chords || chords.length === 0) {
      alert('没有和弦数据，无法手动定位');
      return;
    }

    // 提取所有和弦的纵坐标（y，已经是百分比坐标）
    const yCoordinates = chords.map((chord: any) => chord.y);

    // 按纵坐标排序
    const sortedY = [...yCoordinates].sort((a, b) => a - b);

    // 分组：将纵坐标相近的和弦分为同一行
    const linePositions: number[] = [];
    const lines: Array<{ y: number; count: number }> = [];

    let currentLine = { y: sortedY[0], count: 1 };
    const lineHeightThreshold = 1; // 行高阈值（百分比），超过此值认为是新的一行

    for (let i = 1; i < sortedY.length; i++) {
      const y = sortedY[i];
      const diff = Math.abs(y - currentLine.y);

      if (diff < lineHeightThreshold) {
        // 同一行
        currentLine.count++;
        // 更新行的平均纵坐标
        currentLine.y = (currentLine.y * currentLine.count + y) / (currentLine.count + 1);
      } else {
        // 新的一行
        lines.push(currentLine);
        currentLine = { y: y, count: 1 };
      }
    }
    lines.push(currentLine);

    // 提取每行的纵坐标（已经是百分比）
    linePositions.push(...lines.map(line => line.y));

    console.log('📍 手动定位：提取到的行位置（重映射后）', linePositions);
    console.log('📍 共识别到', linePositions.length, '行和弦');
    setManualLinePositions(linePositions);
    setPageState('manual_relocating');
  };

  // 处理手动定位横线的指针按下事件
  const handleManualLinePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = imageContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const pointerY = e.clientY - rect.top;
    const containerHeight = rect.height;

    // 检查是否点击在某个横线上（允许一定的误差范围）
    const clickThreshold = 15; // 增加点击误差范围（像素），更容易选中
    let clickedIndex: number | null = null;
    let minDistance = Infinity;
    let clickedLineY = 0; // 记录被点击横线的实际 Y 坐标

    manualLinePositions.forEach((position, index) => {
      const lineY = (position / 100) * containerHeight;
      const distance = Math.abs(pointerY - lineY);
      if (distance < clickThreshold && distance < minDistance) {
        minDistance = distance;
        clickedIndex = index;
        clickedLineY = lineY;
      }
    });

    if (clickedIndex !== null) {
      // 立即阻止所有默认行为（阻止文本选择、图片拖拽等）
      e.preventDefault();
      e.stopPropagation();

      // 重置拖动标志
      hasDraggedRef.current = false;

      // 记录初始触摸位置（用于检测是否移动太多取消长按）
      initialTouchPosRef.current = { x: 0, y: pointerY };
      touchMovedTooMuchRef.current = false;
      isDraggingRef.current = false;

      // 记录手指按下位置与横线位置的偏移量（用于拖动时保持相对位置）
      manualLineDragOffsetRef.current = pointerY - clickedLineY;

      // 启动长按检测（500ms）
      longPressTimerRef.current = setTimeout(() => {
        if (!touchMovedTooMuchRef.current) {
          // 长按触发，进入拖动模式
          isDraggingRef.current = true;
          setDraggingLineIndex(clickedIndex);
          setManualLongPressedIndex(clickedIndex);

          // 禁止网页滚动
          if (container.style.touchAction !== 'none') {
            container.style.touchAction = 'none';
          }

          // 触觉反馈
          if ('vibrate' in navigator && e.pointerType === 'touch') {
            navigator.vibrate(50);
          }
        }
      }, 500);
    }
  };

  // 处理手动定位横线的指针移动事件
  const handleManualLinePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 检测是否移动了太多（基于初始位置）- 只在未触发长按时检测
    if (!isDraggingRef.current && initialTouchPosRef.current) {
      const rect = e.currentTarget.getBoundingClientRect();
      const pointerY = e.clientY - rect.top;
      const deltaY = Math.abs(pointerY - initialTouchPosRef.current.y);

      // 如果移动超过15px，视为滚动意图，取消长按检测
      if (deltaY > 15) {
        touchMovedTooMuchRef.current = true;
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        return; // 滚动意图，直接返回
      }
    }

    // 只有在长按触发后才进入拖动模式
    if (!isDraggingRef.current || draggingLineIndex === null) {
      return;
    }

    // 阻止所有默认行为（防止拖拽图片、选择文本等）
    e.preventDefault();
    e.stopPropagation();

    const container = imageContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const pointerY = e.clientY - rect.top;
    const containerHeight = rect.height;

    // 计算新的横线位置（考虑手指按下时与横线的偏移量）
    // newLineY = 当前手指位置 - 初始偏移量
    const newLineY = pointerY - manualLineDragOffsetRef.current;
    const newPosition = Math.max(0, Math.min(100, (newLineY / containerHeight) * 100));

    // 更新横线位置
    setManualLinePositions(prev => {
      const newPositions = [...prev];
      newPositions[draggingLineIndex!] = newPosition;
      return newPositions;
    });

    hasDraggedRef.current = true;
  };

  // 处理手动定位横线的指针释放事件
  const handleManualLinePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    // 清理长按计时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    isDraggingRef.current = false;
    setDraggingLineIndex(null);
    setManualLongPressedIndex(null);
    manualLineDragOffsetRef.current = 0; // 重置偏移量

    // 恢复网页滚动
    const container = imageContainerRef.current;
    if (container && container.style.touchAction === 'none') {
      container.style.touchAction = 'pan-y pinch-zoom';
    }

    // 延迟重置 hasDraggedRef
    if (hasDraggedRef.current) {
      setTimeout(() => {
        hasDraggedRef.current = false;
      }, 100);
    }
  };

  // 取消手动定位
  const handleCancelManualRelocate = () => {
    setPageState('result');
    setManualLinePositions([]);
    setDraggingLineIndex(null);
    setManualLongPressedIndex(null);
    setIsConfirmingManualRelocate(false);

    // 恢复网页滚动
    const container = imageContainerRef.current;
    if (container && container.style.touchAction === 'none') {
      container.style.touchAction = 'pan-y pinch-zoom';
    }
  };

  // 确认手动定位
  const handleConfirmManualRelocate = async () => {
    if (manualLinePositions.length === 0) return;

    if (!result || !result.chords) {
      alert('没有转调结果数据，无法手动定位');
      return;
    }

    // 显示加载状态
    setIsAdjusting(true);
    setIsConfirmingManualRelocate(true);

    try {
      // 将纵坐标数组转换为JSON字符串
      const linePositionsJson = JSON.stringify(manualLinePositions);

      // 准备请求数据
      const requestData = {
        chords: result.chords,
        originalKey: result.originalKey,
        targetKey: result.targetKey,
        chordColor: chordColor,
        fontSize: fontSize,
        imageBase64: imageSrc,
        linePositions: linePositionsJson,
      };

      // 调用后端API，使用新的纵坐标重新生成图片
      const response = await fetch('/api/manual-relocate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '手动定位失败');
      }

      const data = await response.json();

      // 将新图作为新的结果添加到会话结果数组（用于对比）
      setSessionResults(prev => {
        const newResults = [
          {
            resultImage: data.resultImage,
            chords: data.chords,
            originalKey: originalKey || result.originalKey,
            targetKey: targetKey || result.targetKey,
            fontSize: fontSize,
            chordColor: chordColor,
            isManualRelocate: true, // 标记为手动定位生成的结果
          },
          ...prev, // 新结果在最前面
        ];
        return newResults;
      });

      // 切换到新结果（索引0）
      setCurrentSessionIndex(0);

      // 更新当前显示的结果
      setResult({
        resultImage: data.resultImage,
        chords: data.chords,
        originalKey: result.originalKey,
        targetKey: result.targetKey,
      });

      console.log('📍 手动定位：已生成新图并加入对比');
    } catch (error: any) {
      console.error('手动定位失败:', error);
      alert('手动定位失败：' + error.message);
    } finally {
      setIsAdjusting(false);
      setIsConfirmingManualRelocate(false);
      setManualLinePositions([]);
      setDraggingLineIndex(null);
      setManualLongPressedIndex(null);
      setPageState('result');

      // 恢复网页滚动
      const container = imageContainerRef.current;
      if (container && container.style.touchAction === 'none') {
        container.style.touchAction = 'pan-y pinch-zoom';
      }
    }
  };

  // 处理会话结果导航（当前会话的多次识别结果）
  const handleNavigateSession = (direction: number) => {
    if (direction === -1) {
      // 向左（查看更旧的会话结果）
      if (currentSessionIndex < sessionResults.length - 1) {
        const newIndex = currentSessionIndex + 1;
        setCurrentSessionIndex(newIndex);

        // 更新字体和颜色设置（如果结果不是 null）
        const result = sessionResults[newIndex];
        if (result && result.resultImage) {
          if (result.fontSize) {
            setFontSize(result.fontSize);
          }
          if (result.chordColor) {
            setChordColor(result.chordColor);
          }
        }
      }
    } else if (direction === 1) {
      // 向右（查看更新的会话结果）
      if (currentSessionIndex > 0) {
        const newIndex = currentSessionIndex - 1;
        setCurrentSessionIndex(newIndex);

        // 更新字体和颜色设置（如果结果不是 null）
        const result = sessionResults[newIndex];
        if (result && result.resultImage) {
          if (result.fontSize) {
            setFontSize(result.fontSize);
          }
          if (result.chordColor) {
            setChordColor(result.chordColor);
          }
        }
      }
    }
  };

  // 计算调数显示文本（半音数除以2）
  const getKeyStepDisplay = () => {
    if (semitones === '') return '';
    const dir = direction === 'up' ? '升' : '降';
    const value = Number(semitones);
    const keyStep = value / 2; // 半音数除以2转换为调数
    // 如果是整数，不显示小数点
    return `${dir}${Number.isInteger(keyStep) ? keyStep : keyStep}调`;
  };

  // 格式化调名显示（去掉"大调"）
  const formatKeyLabel = (key: string) => {
    return key + '调';
  };

  // 加载中状态
  if (!mounted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <div className="text-center space-y-6">
          <Loader2 className="w-20 h-20 text-indigo-600 animate-spin mx-auto" />
          <div className="space-y-2">
            <p className="text-2xl text-gray-800 dark:text-white font-bold" style={{ fontFamily: '"Noto Serif SC", "Georgia", serif' }}>琴献馨香</p>
            <p className="text-lg text-gray-600 dark:text-gray-400">正在初始化系统...</p>
            <p className="text-sm text-gray-500 dark:text-gray-500">AI 简谱和弦转调工具</p>
          </div>
        </div>
      </div>
    );
  }

return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        {debugMode && (
          <div className="fixed bottom-3 left-3 right-3 md:left-auto md:right-3 md:w-[460px] z-50">
            <div className="rounded-lg border border-gray-200/70 dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 p-3 text-xs text-gray-800 dark:text-gray-100 shadow">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold">Debug</div>
                <div className="text-gray-500 dark:text-gray-400">debug=1</div>
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words">
                {JSON.stringify(
                  {
                    warmup: lastWarmupDebug ?? { note: 'No warmup yet' },
                    transpose: lastTransposeDebug ?? { note: 'No transpose request yet' },
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          </div>
        )}

        {/* 标题 - 在自动识别界面和手动调整界面隐藏 */}
        {pageState !== 'auto_recognizing' && pageState !== 'locating_first' && pageState !== 'locating_last' && pageState !== 'manual_relocating' && (
          <div className="text-center mb-4">
            <div className="flex items-center justify-center gap-3 mb-2">
              <Music className="w-10 h-10 text-indigo-600" />
              <h1
                className="text-4xl font-bold text-gray-900 dark:text-white"
                style={{ fontFamily: '"Noto Serif SC", "Georgia", serif' }}
              >
                琴献馨香
              </h1>
            </div>
            <p className="text-lg text-gray-600 dark:text-gray-300">
              上传简谱图片，可对和弦转调，输出新图
            </p>
          </div>
        )}

        {/* 上传区域（居中显示） */}
        {pageState === 'upload' && (
          <div className="flex justify-center mb-3">
            <Card className="w-full max-w-2xl">
              <CardContent className="pt-4 pb-4 px-8">
                
                <div
                  className={`border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-center transition-colors cursor-pointer ${
                    isMobile ? 'p-8' : 'p-16'
                  } hover:border-indigo-500`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className={`space-y-4 ${isMobile ? 'space-y-2' : ''}`}>
                    <Upload className={`mx-auto text-gray-400 ${isMobile ? 'w-14 h-14' : 'w-20 h-20'}`} />
                    <p className={`${isMobile ? 'text-lg' : 'text-xl'} text-gray-600 dark:text-gray-400 font-semibold`}>
                      点击上传简谱图片
                    </p>
                    <p className={`text-gray-500 dark:text-gray-500 ${isMobile ? 'text-sm' : 'text-base'}`}>
                      支持 JPG、PNG 格式
                    </p>
                    <p className={`text-blue-600 dark:text-blue-400 ${isMobile ? 'text-sm' : 'text-base'} font-medium`}>
                      请尽量选择较清晰的图片
                    </p>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </CardContent>
            </Card>
          </div>
        )}


          {/* 自动识别等待界面 */}
          {pageState === 'auto_recognizing' && imageSrc && (
            <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-4 py-4">
              {/* 图片轮换区域 */}
              <WaitingImageSlideshow />
            
              {/* 进度指示 - 平滑动画 */}
              <div className="w-full max-w-[280px] md:max-w-[450px] lg:max-w-[360px] mt-4 md:mt-6 flex-shrink-0">
                <div className="h-1.5 md:h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-indigo-500 rounded-full"
                    style={{ 
                      width: `${autoRecognizeProgress}%`,
                      transition: 'width 0.3s ease-out'
                    }}
                  />
                </div>
                <p className="text-center text-sm md:text-lg text-indigo-500 mt-1.5 md:mt-2">
                  {autoRecognizeRetryCount > 0 
                    ? '识别失败，重新识别中...' 
                    : (autoRecognizeProgress < 100 
                        ? (modelMode === 'fast' ? '正在识别中，请耐心等待' : '精准识别中~')
                        : '识别完成！')}
                </p>
              </div>
            </div>
          )}

        {/* 定位阶段：图片居中显示 */}
        {mounted && (pageState === 'locating_first' || pageState === 'locating_last') && imageSrc && (
          <div className="flex justify-center mb-3">
            <Card className="w-full max-w-4xl !p-0 !py-0 !gap-0">
              <CardHeader className="px-6 pt-4 pb-1 !gap-0">
                <CardTitle className="flex items-center justify-between gap-3">
                  <span className="whitespace-nowrap">定位首尾两行和弦</span>
                  <div className="flex items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // 如果图片已经预加载完成，直接显示，不显示加载状态
                        setExampleImageLoading(!exampleImageLoadedRef.current);
                        setShowExampleModal(true);
                      }}
                      className="px-3 text-orange-500 hover:text-orange-600 font-bold"
                    >
                      示例
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleChangeImage}
                      className="h-8 px-3 text-xs"
                    >
                      更换图片
                    </Button>
                  </div>
                </CardTitle>
              </CardHeader>

              <CardContent className="px-6 pt-1 pb-6">
                <div
                  ref={imageContainerRef}
                  className={`relative border-2 rounded-lg overflow-hidden transition-colors ${
                    'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20 cursor-crosshair'
                  }`}
                  style={{
                    touchAction: 'pan-y pinch-zoom',
                    WebkitUserSelect: 'none',
                    MozUserSelect: 'none',
                    msUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                  } as React.CSSProperties}
                  onClick={handleImageClick}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  onContextMenu={handleContextMenu}
                >
                  <img
                    key={imageKey}
                    ref={imageRef}
                    src={imageSrc}
                    alt="简谱图片"
                    className="w-full h-auto"
                    style={{ pointerEvents: 'none' }}
                  />

                  {/* 锚点标记 */}
                  {(pageState === 'locating_first' || pageState === 'locating_last') && anchorPoints.map((point, index) => {
                    const isLongPressed = longPressedIndex === index;
                    const isDragging = draggingIndex === index;

                    return (
                      <div
                        key={index}
                        className="absolute z-10"
                        style={{
                          left: 0,
                          top: `${point.y}%`,
                          // 向上偏移容器的一半高度，让矩形框中心对齐到 point.y
                          transform: 'translateY(-50%)',
                          pointerEvents: 'none',
                          width: '100%', // 确保锚点容器占满整个宽度
                        }}
                      >
                        {/* 使用新的CalibrationMarker组件 */}
                        <CalibrationMarker
                          index={index}
                          isFirst={index === 0}
                          isLongPressed={isLongPressed}
                          isMobile={isMobile}
                          imageWidth={800} // 传递默认值，但组件内部不再使用
                          imageHeight={600} // 传递默认值，但组件内部不再使用
                        />
                      </div>
                    );
                  })}

                </div>

                {/* 确认按钮 */}
                {anchorPoints.length === 2 && (
                  <div className="mt-4 flex flex-col items-center">
                    {isRecognizing ? (
                      <Button
                        disabled
                        size={isMobile ? 'default' : 'lg'}
                        className={`w-full ${isMobile ? 'py-6 text-lg' : 'max-w-md'}`}
                      >
                        <Loader2 className={`animate-spin ${isMobile ? 'w-5 h-5 mr-3' : 'w-4 h-4 mr-2'}`} />
                        请稍后，大约需要10-20秒
                      </Button>
                    ) : (
                      <Button
                        onClick={handleConfirmSelection}
                        disabled={!hasDraggedAnchors.every(dragged => dragged)}
                        size={isMobile ? 'default' : 'lg'}
                        className={`w-full select-none ${isMobile ? 'py-6 text-lg' : 'max-w-md'}`}
                      >
                        确认
                      </Button>
                    )}
                  </div>
                )}

                {/* 定位提示 */}
                <p className="mt-3 text-sm text-orange-600 dark:text-orange-400 text-center leading-relaxed">
                  请检查第一条红线上方<br />
                  是否有更靠上的和弦~<br />
                  （可双指缩放网页以便操作）
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 设置和结果阶段：单栏布局 */}
        {(pageState === 'settings' || pageState === 'processing' || pageState === 'result') && (
          <div className="flex justify-center">
            <div className="w-full max-w-2xl space-y-3">
              {/* 转调设置 */}
              {pageState === 'settings' && (
                <Card>
                  <CardHeader>
                    <CardTitle>转调设置</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* 原调 */}
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        原调
                      </label>
                      {isAutoRecognized ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 px-4 py-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-lg font-semibold text-center">
                              {formatKeyLabel(originalKey)}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setIsAutoRecognized(false)}
                              className="h-8 px-2 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                            >
                              修改
                            </Button>
                          </div>
                          <div className="text-xs text-green-600 dark:text-green-400 text-center">
                            （已自动识别）
                          </div>
                        </div>
                      ) : (
                        <Select value={originalKey} onValueChange={handleManualSelectOriginalKey}>
                          <SelectTrigger className="w-full justify-between">
                            <div className="flex-1 text-center">
                              <SelectValue placeholder="请选择" />
                            </div>
                          </SelectTrigger>
                          <SelectContent>
                            {ALL_KEYS.map((key) => (
                              <SelectItem key={key.value} value={key.value} style={{ textAlign: 'center', width: '100%' }}>
                                {key.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>

                    {/* 目标调 */}
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        目标调
                      </label>
                      <div className="flex items-center gap-3">
                        <Select value={targetKey} onValueChange={setTargetKey}>
                          <SelectTrigger className="flex-1 !w-full justify-between">
                            <div className="flex-1 text-center">
                              <SelectValue placeholder="请选择" />
                            </div>
                          </SelectTrigger>
                          <SelectContent className="text-center">
                            {ALL_KEYS.map((key) => (
                              <SelectItem key={key.value} value={key.value}>
                                <span className="w-full text-center">{key.label}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {targetKey && getKeyStepDisplay() && (
                          <span className="text-blue-600 dark:text-blue-400 font-semibold whitespace-nowrap">
                            {getKeyStepDisplay()}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 开始转调按钮 */}
                    <Button
                      onClick={() => {
                        console.log('🔘 按钮点击:', { targetKey, direction, semitones });
                        console.log('🔘 按钮禁用条件:', {
                          noTargetKey: !targetKey,
                          noDirection: !direction,
                              emptySemitones: semitones === '',
                          targetKey,
                          direction,
                          semitones
                        });
                        handleTranspose();
                      }}
                      disabled={!targetKey || !direction || semitones === ''}
                      className="w-full"
                      size="lg"
                    >
                      开始转调
                    </Button>
                  </CardContent>
                </Card>
              )}

              {/* 处理中 */}
              {pageState === 'processing' && (
                <Card>
                  <CardContent className="py-16 flex flex-col items-center justify-center space-y-4">
                    <Loader2 className="w-16 h-16 text-indigo-600 animate-spin" />
                    <p className="text-xl text-gray-600 dark:text-gray-400 font-semibold">
                      请稍后...
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* 识别结果 */}
              {pageState === 'result' && result && (
                <>
                  {/* 转调结果 */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span>转调结果</span>
                        {/* 转发按钮 - 只在非微信环境且支持分享API时显示 */}
                        {typeof navigator !== 'undefined' &&
                         !/MicroMessenger/i.test(navigator.userAgent) &&
                         typeof navigator.share === 'function' && (
                          <button
                            onClick={handleShareImage}
                            className="h-8 px-3 text-sm select-none bg-blue-500 hover:bg-blue-600 text-white rounded-md border border-white transition-colors"
                          >
                            保存/转发
                          </button>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4 pt-0">
                      {/* 字体调整和颜色选择 */}
                      <div className="flex flex-col gap-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg -mt-3">
                        {/* 第一行：字体大小和颜色选择 */}
                        <div className="flex flex-row flex-wrap gap-3">
                          {/* 字体调整 */}
                          <div className="flex-none min-w-[140px] max-w-[180px]">
                            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
                              字体大小（px）
                            </label>
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const newSize = (fontSize || 20) - 4;
                                  handleFontSizeChange(newSize > 8 ? newSize : 8);
                                }}
                                disabled={isAdjusting || (fontSize !== null && fontSize <= 8)}
                              >
                                <span className="text-lg font-bold">-</span>
                              </Button>
                              <div className="h-9 px-2 bg-white dark:bg-gray-700 rounded border flex items-center justify-center flex-1 min-w-[45px]">
                                <span className="font-semibold text-sm">
                                  {fontSize ? `${fontSize}` : '自动'}
                                </span>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const newSize = (fontSize || 20) + 4;
                                  handleFontSizeChange(newSize < 88 ? newSize : 88);
                                }}
                                disabled={isAdjusting || (fontSize !== null && fontSize >= 88)}
                              >
                                <span className="text-lg font-bold">+</span>
                              </Button>
                            </div>
                          </div>

                          {/* 颜色选择 */}
                          <div className="flex-1 min-w-[100px]">
                            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
                              标记颜色
                            </label>
                            <Select value={chordColor} onValueChange={handleColorChange} disabled={isAdjusting}>
                              <SelectTrigger>
                                <SelectValue placeholder="选择颜色" />
                              </SelectTrigger>
                              <SelectContent>
                                {COLOR_OPTIONS.map((color) => (
                                  <SelectItem key={color.value} value={color.value}>
                                    <div className="flex items-center">
                                      <div
                                        className="w-4 h-4 rounded border border-gray-300"
                                        style={{ backgroundColor: color.value }}
                                      />
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* 第二行：应用按钮已隐藏，因为现在字号和颜色更改会自动触发调整 */}
                        {/* <div className="flex justify-center">
                          <Button
                            onClick={handleAdjustment}
                            disabled={isAdjusting}
                            variant="outline"
                            className="min-w-[120px]"
                          >
                            {isAdjusting ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                生成中
                              </>
                            ) : (
                              '调整字号与颜色'
                            )}
                          </Button>
                        </div> */}
                      </div>

                      {/* 图片上方提示 */}
                      <div className="text-center mb-2 space-y-1">
                        <div>
                          <span className="text-sm text-orange-500 dark:text-orange-400">
                            ↑ 您可自由调整字体大小与颜色
                          </span>
                        </div>
                        <div>
                          <span className="text-sm text-blue-500 dark:text-blue-400">
                            {typeof navigator !== 'undefined' && !/MicroMessenger/i.test(navigator.userAgent) && typeof navigator.share === 'function'
                              ? '点击右上角按钮可保存/转发'
                              : '长按图片可保存/转发'}
                          </span>
                        </div>
                      </div>

                      {/* 结果图片 */}
                      {isRelocating && currentSessionIndex === 0 ? (
                        // 重新识别时，显示等待界面（白色背景+进度条）
                        <div className="max-w-4xl w-full rounded-lg overflow-hidden bg-white dark:bg-gray-900 flex flex-col items-center justify-center" style={{ aspectRatio: imageAspectRatio }}>
                          {/* 装饰图 */}
                          <WaitingImageSlideshow />
                          
                          {/* 进度条 */}
                          <div className="w-full max-w-[280px] mt-6">
                            <div className="h-2 bg-gray-200/50 dark:bg-gray-700/50 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-green-500 rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${relocateProgress}%` }}
                              />
                            </div>
                            <p className="text-center text-sm text-green-600 dark:text-green-400 mt-2">
                              {relocateProgress < 100 
                                ? '重新识别中~' 
                                : '识别完成！'}
                            </p>
                          </div>
                        </div>
                      ) : (
                        // 显示图片（包括历史结果）
                        <div className="flex justify-center">
                          <div className="relative">
                            {/* 加载提示 */}
                            {isAdjusting && (
                              <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-10 rounded-lg">
                                <div className="text-center space-y-3">
                                  <Loader2 className="w-12 h-12 text-white animate-spin mx-auto" />
                                  <p className="text-lg text-white font-semibold">
                                    字体调整中...
                                  </p>
                                </div>
                              </div>
                            )}

                            {/* 图片 */}
                            {mounted && (sessionResults[currentSessionIndex]?.resultImage || result?.resultImage) && (
                              <img
                                src={sessionResults[currentSessionIndex]?.resultImage || result?.resultImage}
                                alt="转调结果"
                                className="max-w-4xl w-full rounded-lg border shadow-lg select-none"
                              />
                            )}
                          </div>
                        </div>
                      )}

                      {/* 左右箭头切换按钮（当前会话的多次识别结果） */}
                      {/* 修改显示条件：isRelocating 时也需要显示箭头 */}
                      {sessionResults.length > 1 && (
                        <div className="flex items-center justify-end gap-2 mt-4">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleNavigateSession(-1)}
                            disabled={currentSessionIndex >= sessionResults.length - 1}
                            className={
                              currentSessionIndex >= sessionResults.length - 1
                                ? 'opacity-40 cursor-not-allowed'
                                : ''
                            }
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>

                          <span className="text-sm text-gray-600 dark:text-gray-400">
                            {sessionResults.length - currentSessionIndex}/{sessionResults.length}
                          </span>

                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleNavigateSession(1)}
                            disabled={currentSessionIndex <= 0}
                            className={
                              currentSessionIndex <= 0
                                ? 'opacity-40 cursor-not-allowed'
                                : ''
                            }
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      )}

                      {/* 对比原图提示 */}
                      <div className="pt-2 space-y-2 text-sm text-gray-700 dark:text-gray-300">
                        <div className="flex items-center gap-2">
                          <span>▸</span>
                          <span>和弦没对齐原位？快速</span>
                          <Button
                            onClick={handleRelocateAnchors}
                            variant="outline"
                            className="shrink-0 h-8 px-3 text-sm text-orange-600 border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:text-orange-400 dark:border-orange-600 dark:hover:bg-orange-950"
                          >
                            手动调整
                          </Button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span>▸</span>
                          <span>再重新识别一次？点击</span>
                          <Button
                            onClick={() => setShowDeepThinkingDialog(true)}
                            disabled={isRelocating}
                            variant="outline"
                            className="shrink-0 h-8 px-3 text-sm text-blue-600 border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:border-blue-600 dark:hover:bg-blue-950 disabled:opacity-50"
                          >
                            {isRelocating ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                                识别中...
                              </>
                            ) : (
                              '重新识别'
                            )}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* 重新识别确认弹窗 */}
                  {showDeepThinkingDialog && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowDeepThinkingDialog(false)}>
                      <div 
                        className="bg-white dark:bg-gray-800 rounded-2xl p-6 mx-4 max-w-sm w-full shadow-2xl transform animate-in fade-in zoom-in duration-200"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="text-center">
                          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                            <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </div>
                          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">重新识别</h3>
                          <p className="text-gray-600 dark:text-gray-300 mb-6 leading-relaxed font-normal">
                            将使用相同的识别流程<br />
                            重新识别图片中的和弦<br />
                            确定要继续吗？
                          </p>
                          <div className="flex gap-3">
                            <Button
                              variant="outline"
                              className="flex-1"
                              onClick={() => setShowDeepThinkingDialog(false)}
                            >
                              取消
                            </Button>
                            <Button
                              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                              onClick={() => {
                                setShowDeepThinkingDialog(false);
                                handleRelocate();
                              }}
                            >
                              确定
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 原图对照 */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span>原图对照</span>
                        <Button size="sm" variant="outline" onClick={handleChangeImage} className="h-8 px-3 text-sm">
                          <Upload className="w-4 h-4 mr-2" />
                          上传新图
                        </Button>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {mounted && imageSrc ? (
                        <div className="flex justify-center">
                          <img
                            src={imageSrc}
                            alt="原图对照"
                            className="max-w-4xl w-full rounded-lg border"
                          />
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>

                  {/* 转调设置 */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span>转调设置</span>
                        <Button size="sm" variant="outline" onClick={() => setPageState('settings')}>
                          修改
                        </Button>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex justify-between items-center py-3 border-b">
                        <span className="text-sm text-gray-600 dark:text-gray-400">原调:</span>
                        <span className="font-semibold text-lg">{formatKeyLabel(result.originalKey)}</span>
                      </div>
                      <div className="flex justify-between items-center py-3 border-b">
                        <span className="text-sm text-gray-600 dark:text-gray-400">目标调:</span>
                        <span className="font-semibold text-lg text-indigo-600 dark:text-indigo-400">
                          {formatKeyLabel(result.targetKey)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-3">
                        <span className="text-sm text-gray-600 dark:text-gray-400">转换:</span>
                        <span className="font-semibold text-lg">
                          {getKeyStepDisplay()}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </div>
        )}

        {/* 手动调整和弦纵向位置 */}
        {pageState === 'manual_relocating' && imageSrc && (
          <div className="flex justify-center">
            <Card className="w-full max-w-4xl !p-0 !py-0 !gap-0">
              <CardContent className="px-6 pt-4 pb-6">
                {/* 提示条 */}
                <div className="mb-3 border-l-4 border-blue-500 text-center pl-4 py-2 bg-slate-50 dark:bg-slate-800/50 rounded-r-lg">
                  <div className="text-sm text-slate-500 dark:text-slate-400">如何调整某行和弦的位置？</div>
                  <div className="font-medium text-blue-500 dark:text-slate-200">长按红线，红线变绿，即可拖动</div>
                </div>

                <div
                  ref={imageContainerRef}
                  className={`relative border-1 rounded-lg overflow-hidden transition-colors ${
                    'border-blue-400 bg-blue-50 dark:bg-blue-950/20 cursor-crosshair'
                  }`}
                  style={{
                    touchAction: 'pan-y pinch-zoom', // 允许垂直滚动和缩放，禁止水平滚动
                    WebkitUserSelect: 'none',
                    MozUserSelect: 'none',
                    msUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                  } as any}
                  onPointerDown={handleManualLinePointerDown}
                  onPointerMove={handleManualLinePointerMove}
                  onPointerUp={handleManualLinePointerUp}
                  onPointerCancel={handleManualLinePointerUp}
                >
                  <img
                    key={imageKey}
                    ref={imageRef}
                    src={imageSrc}
                    alt="简谱图片"
                    className="w-full h-auto"
                    style={{
                      pointerEvents: 'none', // 禁止图片本身接收指针事件（允许事件穿透到容器）
                      WebkitUserSelect: 'none',
                      MozUserSelect: 'none',
                      msUserSelect: 'none',
                      userSelect: 'none',
                    }}
                  />

                  {/* 手动定位的横线 */}
                  {manualLinePositions.map((position, index) => {
                    const isLongPressed = manualLongPressedIndex === index;
                    return (
                      <div
                        key={index}
                        className={`absolute w-full ${isDraggingRef.current && draggingLineIndex === index ? 'cursor-grabbing' : 'cursor-grab'}`}
                        style={{
                          top: `${position}%`,
                          height: '20px', // 点击区域高度
                          transform: `translateY(-50%) ${isLongPressed ? 'scale(1.05)' : 'scale(1)'}`,
                          opacity: draggingLineIndex === index ? 0.8 : 0.6,
                          transition: isLongPressed ? 'transform 0.15s ease-out' : 'none',
                          zIndex: isLongPressed ? 20 : 10,
                          // 强制禁止所有文本选择和默认触摸行为
                          WebkitUserSelect: 'none',
                          MozUserSelect: 'none',
                          msUserSelect: 'none',
                          userSelect: 'none',
                          WebkitTouchCallout: 'none',
                          touchAction: 'none', // 禁止浏览器默认触摸行为（包括滚动）
                        } as any}
                        onTouchStart={(e: any) => {
                          // 阻止浏览器的默认长按行为（如放大镜、上下文菜单等）
                          e.preventDefault();
                        }}
                        onTouchMove={(e: any) => {
                          // 阻止浏览器的默认触摸移动行为
                          e.preventDefault();
                        }}
                      >
                        {/* 视觉横线 - 1px 线，长按后变为绿色 */}
                        <div
                          className="absolute left-0 right-0"
                          style={{
                            top: '50%',
                            height: '1px',
                            backgroundColor: isLongPressed ? '#22C55E' : '#EF4444',
                            pointerEvents: 'none',
                          }}
                        />

                        {/* 线条上的文字提示 - 横线穿过文字框中心，长按后变为绿色 */}
                        <div
                          className={`absolute left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap shadow-sm ${
                            isLongPressed 
                              ? 'bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-400' 
                              : 'bg-white dark:bg-gray-800 text-red-600 dark:text-red-400'
                          }`}
                          style={{
                            top: '50%',
                            pointerEvents: 'none',
                            // 强制禁止文本选择
                            WebkitUserSelect: 'none',
                            MozUserSelect: 'none',
                            msUserSelect: 'none',
                            userSelect: 'none',
                          }}
                        >
                          第 {index + 1} 行
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mb-3 text-center pl-4 py-2 bg-slate-50 dark:bg-slate-800/50 rounded-r-lg">
                  <div className="mt-1 font-medium text-blue-500">请让红线从和弦的中心穿过</div>
                </div>
                {/* 确认和取消按钮 */}
                <div className="mt-4 flex gap-3">
                  <Button
                    onClick={handleCancelManualRelocate}
                    variant="outline"
                    className="flex-1"
                  >
                    取消
                  </Button>
                  <Button
                    onClick={handleConfirmManualRelocate}
                    className="flex-1 select-none"
                    disabled={manualLinePositions.length === 0 || isConfirmingManualRelocate}
                  >
                    {isConfirmingManualRelocate ? '请稍后' : '确认'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 示例弹窗 */}
        {showExampleModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-4xl max-h-[90vh] overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardTitle>操作示例</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowExampleModal(false)}
                >
                  返回
                </Button>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <div className="relative w-full bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden" style={{ minHeight: '300px' }}>
                  {/* 骨架屏 */}
                  {exampleImageLoading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
                      <div className="relative">
                        {/* 脉冲动画 */}
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-20 h-20 bg-blue-500/10 rounded-full animate-ping" style={{ animationDuration: '1.5s' }}></div>
                        </div>
                        {/* 中心图标 */}
                        <div className="relative w-20 h-20 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30">
                          <svg className="w-10 h-10 text-white animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                      </div>
                      <p className="mt-6 text-base font-medium text-gray-600 dark:text-gray-300">图片加载中...</p>
                      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">请稍候片刻</p>
                    </div>
                  )}
                  {/* 示例图片 */}
                  <img
                    src="/assets/example.jpg"
                    alt="定位示例"
                    className={`w-full h-auto rounded-lg transition-all duration-500 ease-out ${exampleImageLoading ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}
                    onLoad={() => setExampleImageLoading(false)}
                  />
                </div>
                <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center leading-relaxed">
                  ⚠第一行和弦不一定对应第一行歌词<br />
                  请您留意图中是否有更靠上的和弦~<br />
                  （可双指缩放网页以便操作）
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* 历史记录面板 */}
    </div>
  );
}
