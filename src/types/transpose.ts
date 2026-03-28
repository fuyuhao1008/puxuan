export interface Point {
  x: number;
  y: number;
}

export type PageState = 'upload' | 'locating_first' | 'locating_last' | 'settings' | 'processing' | 'result';

export interface RecognitionCache {
  id: string;
  imageFile: File;
  imageUrl: string;
  imageOriginalWidth: number;
  imageOriginalHeight: number;
  recognitionResult: any;
  transposeResult: any;
  createdAt: number;
}

export interface ChordBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface ColorOption {
  name: string;
  value: string;
}

export interface RecognitionResult {
  centers: Array<{ x: number; y: number; text: string }>;
}

export interface TransposeRequest {
  image: string;
  scale: number;
  targetKey: string;
  chordCenters: Array<{ x: number; y: number; text: string }>;
}
