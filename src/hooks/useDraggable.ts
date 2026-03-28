import { useState, useCallback, useRef } from 'react';

export interface UseDraggableOptions {
  onDragStart?: (id: string, position: { x: number; y: number }) => void;
  onDragMove?: (id: string, delta: { dx: number; dy: number }) => void;
  onDragEnd?: (id: string, position: { x: number; y: number }) => void;
}

export interface UseDraggableResult {
  isDragging: boolean;
  draggedId: string | null;
  startDrag: (id: string, e: React.MouseEvent | React.TouchEvent) => void;
}

export const useDraggable = (options: UseDraggableOptions): UseDraggableResult => {
  const { onDragStart, onDragMove, onDragEnd } = options;

  const [isDragging, setIsDragging] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const startPosition = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const startDrag = useCallback((id: string, e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDraggedId(id);

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    startPosition.current = { x: clientX, y: clientY };
    dragOffset.current = { x: 0, y: 0 };

    onDragStart?.(id, { x: clientX, y: clientY });
  }, [onDragStart]);

  const handleMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging || !draggedId) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const dx = clientX - startPosition.current.x;
    const dy = clientY - startPosition.current.y;

    dragOffset.current = { x: dx, y: dy };

    onDragMove?.(draggedId, { dx, dy });
  }, [isDragging, draggedId, onDragMove]);

  const handleEnd = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging || !draggedId) return;

    onDragEnd?.(draggedId, { x: dragOffset.current.x, y: dragOffset.current.y });

    setIsDragging(false);
    setDraggedId(null);
  }, [isDragging, draggedId, onDragEnd]);

  return {
    isDragging,
    draggedId,
    startDrag,
  };
};
