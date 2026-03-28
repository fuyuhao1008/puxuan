import { useState, useCallback } from 'react';
import { RecognitionCache } from '@/types/transpose';

export interface ImageHandlerResult {
  imageFile: File | null;
  imageUrl: string | null;
  imageOriginalWidth: number;
  imageOriginalHeight: number;
  handleImageUpload: (file: File) => void;
  handleSelectFromHistory: (cache: RecognitionCache) => void;
  handleImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  clearImage: () => void;
}

export const useImageHandler = (): ImageHandlerResult => {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageOriginalWidth, setImageOriginalWidth] = useState(0);
  const [imageOriginalHeight, setImageOriginalHeight] = useState(0);

  const handleImageUpload = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('请上传图片文件！');
      return;
    }

    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageUrl(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleSelectFromHistory = useCallback((cache: RecognitionCache) => {
    setImageFile(cache.imageFile);
    setImageUrl(cache.imageUrl);
    setImageOriginalWidth(cache.imageOriginalWidth);
    setImageOriginalHeight(cache.imageOriginalHeight);
  }, []);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.target as HTMLImageElement;
    setImageOriginalWidth(img.naturalWidth);
    setImageOriginalHeight(img.naturalHeight);
  }, []);

  const clearImage = useCallback(() => {
    setImageFile(null);
    setImageUrl(null);
    setImageOriginalWidth(0);
    setImageOriginalHeight(0);
  }, []);

  return {
    imageFile,
    imageUrl,
    imageOriginalWidth,
    imageOriginalHeight,
    handleImageUpload,
    handleSelectFromHistory,
    handleImageLoad,
    clearImage,
  };
};
