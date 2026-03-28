import { useState, useCallback, useRef } from 'react';

export interface ChordRecognitionOptions {
  onProgress?: (progress: number) => void;
}

export interface UseChordRecognitionResult {
  isRecognizing: boolean;
  recognitionResult: any;
  error: string | null;
  startRecognition: (imageDataUrl: string, imageWidth: number, imageHeight: number) => Promise<void>;
  cancelRecognition: () => void;
}

export const useChordRecognition = (
  options: ChordRecognitionOptions = {}
): UseChordRecognitionResult => {
  const { onProgress } = options;

  const [isRecognizing, setIsRecognizing] = useState(false);
  const [recognitionResult, setRecognitionResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const startRecognition = useCallback(
    async (imageDataUrl: string, imageWidth: number, imageHeight: number) => {
      setIsRecognizing(true);
      setError(null);

      // 取消之前的请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

      try {
        const response = await fetch('/api/relocate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: imageDataUrl,
            imageWidth,
            imageHeight,
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error('识别失败');
        }

        const data = await response.json();
        setRecognitionResult(data);
        onProgress?.(100);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setError(err.message);
        }
      } finally {
        setIsRecognizing(false);
        abortControllerRef.current = null;
      }
    },
    [onProgress]
  );

  const cancelRecognition = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsRecognizing(false);
  }, []);

  return {
    isRecognizing,
    recognitionResult,
    error,
    startRecognition,
    cancelRecognition,
  };
};
