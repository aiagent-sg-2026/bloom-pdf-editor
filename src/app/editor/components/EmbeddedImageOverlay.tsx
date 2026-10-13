'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Replace, X } from 'lucide-react';
import type { ImageItem } from '@/engine/browser-core';

interface EmbeddedImageOverlayProps {
  item: ImageItem;
  /** Convert PDF → CSS for the live bbox */
  toCss: (pdf: { x: number; y: number; width: number; height: number }) => {
    left: number; top: number; width: number; height: number;
  };
  scale: number;
  /** Commit move (PDF units). */
  onCommitMove: (pdfDx: number, pdfDy: number) => Promise<void>;
  /** Commit a corner resize as the new PDF bbox (the opposite corner stays fixed). */
  onCommitResize: (box: { x: number; y: number; width: number; height: number }) => Promise<void>;
  onReplace: () => void;
  onDeselect: () => void;
}

export const EMBEDDED_IMAGE_OVERLAY_LAYERS = { overlay: 70, handle: 80 } as const;

/**
 * Interactive frame over a selected embedded PDF image — drag + SE resize.
 * Visual feedback is local; PDF mutation commits on pointer-up.
 */
export function EmbeddedImageOverlay(props: EmbeddedImageOverlayProps) {
  const {
    item, toCss, scale,
    onCommitMove, onCommitResize, onReplace, onDeselect,
  } = props;

  const [live, setLive] = useState({
    x: item.x, y: item.y, width: item.width, height: item.height,
  });
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    setLive({ x: item.x, y: item.y, width: item.width, height: item.height });
  }, [item.x, item.y, item.width, item.height, item.name]);

  type Corner = 'nw' | 'ne' | 'sw' | 'se';
  const dragMode = useRef<'move' | `resize-${Corner}` | null>(null);
  const origin = useRef({
    clientX: 0, clientY: 0,
    x: 0, y: 0, width: 0, height: 0,
  });

  const onPointerMove = useCallback((e: PointerEvent) => {
    const mode = dragMode.current;
    if (!mode) return;
    const dxCss = e.clientX - origin.current.clientX;
    const dyCss = e.clientY - origin.current.clientY;
    const dx = dxCss / scale;
    const dy = -dyCss / scale; // screen down → PDF down (y decreases)

    if (mode === 'move') {
      setLive({
        x: origin.current.x + dx,
        y: origin.current.y + dy,
        width: origin.current.width,
        height: origin.current.height,
      });
    } else {
      const corner = mode.slice('resize-'.length) as Corner;
      const o = origin.current;
      const east = corner === 'ne' || corner === 'se';
      const north = corner === 'nw' || corner === 'ne';
      // PDF y grows upward; screen-down drag (dy < 0 in PDF units) shrinks a north edge.
      const newW = Math.max(8, east ? o.width + dx : o.width - dx);
      const newH = Math.max(8, north ? o.height + dy : o.height - dy);
      setLive({
        x: east ? o.x : o.x + (o.width - newW),
        y: north ? o.y : o.y + (o.height - newH),
        width: newW,
        height: newH,
      });
    }
  }, [scale]);

  const endDragStable = useCallback(async () => {
    const mode = dragMode.current;
    dragMode.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDragStable);

    if (!mode) return;
    const cur = liveRef.current;
    const dx = cur.x - origin.current.x;
    const dy = cur.y - origin.current.y;
    try {
      if (mode === 'move') {
        if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
          await onCommitMove(dx, dy);
        }
      } else if (
        Math.abs(cur.width - origin.current.width) > 0.25 ||
        Math.abs(cur.height - origin.current.height) > 0.25
      ) {
        await onCommitResize({ x: cur.x, y: cur.y, width: cur.width, height: cur.height });
      }
    } catch (err) {
      console.error('[EmbeddedImageOverlay] commit failed', err);
      setLive({
        x: origin.current.x,
        y: origin.current.y,
        width: origin.current.width,
        height: origin.current.height,
      });
    }
  }, [onCommitMove, onCommitResize, onPointerMove]);

  const begin = useCallback((mode: 'move' | `resize-${Corner}`, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragMode.current = mode;
    origin.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      x: liveRef.current.x,
      y: liveRef.current.y,
      width: liveRef.current.width,
      height: liveRef.current.height,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDragStable);
  }, [onPointerMove, endDragStable]);

  const box = toCss(live);

  return (
    <div
      className="absolute z-[70] pointer-events-auto border-2 border-[#3b82f6] border-dashed bg-[#3b82f6]/10 cursor-move"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => begin('move', e)}
    >
      <div className="absolute -top-7 left-0 flex items-center gap-1">
        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-[#3b82f6] text-white text-[10px] rounded shadow">
          <ImageIcon size={10} /> Image
        </span>
        <button
          type="button"
          title="Replace image (keep size)"
          className="flex items-center gap-1 px-1.5 py-0.5 bg-zinc-800 text-zinc-200 text-[10px] rounded border border-zinc-600 hover:bg-zinc-700 shadow"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onReplace();
          }}
        >
          <Replace size={10} /> Replace
        </button>
        <button
          type="button"
          title="Deselect"
          className="p-0.5 bg-zinc-800 text-zinc-300 rounded border border-zinc-600 hover:bg-zinc-700 shadow"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDeselect();
          }}
        >
          <X size={10} />
        </button>
      </div>

      {([['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]] as const).map(([corner, hx, hy]) => (
        <div
          key={corner}
          data-handle={corner}
          className={`absolute w-2.5 h-2.5 bg-[#3b82f6] border border-white rounded-sm z-[80] pointer-events-auto ${
            corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'
          }`}
          style={{
            left: hx === 0 ? -5 : undefined,
            right: hx === 1 ? -5 : undefined,
            top: hy === 0 ? -5 : undefined,
            bottom: hy === 1 ? -5 : undefined,
          }}
          onPointerDown={(e) => begin(`resize-${corner}`, e)}
        />
      ))}
    </div>
  );
}
