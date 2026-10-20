'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Replace, X } from 'lucide-react';
import type { ImageItem } from '@/engine/browser-core';
import { Z_LAYERS } from '../zLayers';
import { resizeBox, type ResizeHandle } from './resizeGeometry';

interface EmbeddedImageOverlayProps {
  item: ImageItem;
  /** Convert PDF → CSS for the live bbox */
  toCss: (pdf: { x: number; y: number; width: number; height: number }) => {
    left: number; top: number; width: number; height: number;
  };
  scale: number;
  /** Commit move (PDF units). */
  onCommitMove: (pdfDx: number, pdfDy: number) => Promise<void>;
  /** Commit the new PDF bbox, keeping the opposite edge or corner fixed. */
  onCommitResize: (box: { x: number; y: number; width: number; height: number }) => Promise<void>;
  onReplace: () => void;
  onDeselect: () => void;
}

/** Canvas-local layers, contained by the isolated workspace. */
export const EMBEDDED_IMAGE_OVERLAY_LAYERS = {
  overlay: Z_LAYERS.canvasOverlay,
  handle: Z_LAYERS.canvasHandle,
} as const;

/**
 * Interactive frame over a selected embedded PDF image — drag + eight-handle resize.
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

  const dragMode = useRef<'move' | `resize-${ResizeHandle}` | null>(null);
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
      const handle = mode.slice('resize-'.length) as ResizeHandle;
      setLive(resizeBox(origin.current, handle, {
        dx, dy, minWidth: 8, minHeight: 8, free: e.shiftKey,
      }));
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

  const begin = useCallback((mode: 'move' | `resize-${ResizeHandle}`, e: React.PointerEvent) => {
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
      className="absolute pointer-events-auto border-2 border-[#3b82f6] border-dashed bg-[#3b82f6]/10 cursor-move"
      style={{ zIndex: EMBEDDED_IMAGE_OVERLAY_LAYERS.overlay, left: box.left, top: box.top, width: box.width, height: box.height }}
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

      {([
        ['nw', 0, 0, 'cursor-nwse-resize'], ['ne', 1, 0, 'cursor-nesw-resize'],
        ['sw', 0, 1, 'cursor-nesw-resize'], ['se', 1, 1, 'cursor-nwse-resize'],
        ['n', 0.5, 0, 'cursor-ns-resize'], ['s', 0.5, 1, 'cursor-ns-resize'],
        ['e', 1, 0.5, 'cursor-ew-resize'], ['w', 0, 0.5, 'cursor-ew-resize'],
      ] as const).map(([handle, hx, hy, cursor]) => (
        <div
          key={handle}
          data-handle={handle}
          className={`absolute w-2.5 h-2.5 bg-[#3b82f6] border border-white rounded-sm pointer-events-auto ${cursor}`}
          style={{
            zIndex: EMBEDDED_IMAGE_OVERLAY_LAYERS.handle,
            left: hx === 0 ? -5 : hx === 0.5 ? '50%' : undefined,
            right: hx === 1 ? -5 : undefined,
            top: hy === 0 ? -5 : hy === 0.5 ? '50%' : undefined,
            bottom: hy === 1 ? -5 : undefined,
            transform: hx === 0.5 ? 'translateX(-50%)' : hy === 0.5 ? 'translateY(-50%)' : undefined,
          }}
          onPointerDown={(e) => begin(`resize-${handle}`, e)}
        />
      ))}
    </div>
  );
}
