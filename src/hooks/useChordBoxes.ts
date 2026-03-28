import { useState, useCallback } from 'react';
import { ChordBox } from '@/types/transpose';

export interface UseChordBoxesResult {
  chordBoxes: ChordBox[];
  setChordBoxes: (boxes: ChordBox[]) => void;
  updateChordBox: (id: string, updates: Partial<ChordBox>) => void;
  addChordBox: (box: ChordBox) => void;
  removeChordBox: (id: string) => void;
  clearChordBoxes: () => void;
}

export const useChordBoxes = (): UseChordBoxesResult => {
  const [chordBoxes, setChordBoxes] = useState<ChordBox[]>([]);

  const updateChordBox = useCallback((id: string, updates: Partial<ChordBox>) => {
    setChordBoxes(prev =>
      prev.map(box => (box.id === id ? { ...box, ...updates } : box))
    );
  }, []);

  const addChordBox = useCallback((box: ChordBox) => {
    setChordBoxes(prev => [...prev, box]);
  }, []);

  const removeChordBox = useCallback((id: string) => {
    setChordBoxes(prev => prev.filter(box => box.id !== id));
  }, []);

  const clearChordBoxes = useCallback(() => {
    setChordBoxes([]);
  }, []);

  return {
    chordBoxes,
    setChordBoxes,
    updateChordBox,
    addChordBox,
    removeChordBox,
    clearChordBoxes,
  };
};
