'use client';

import React, { useEffect, useRef } from 'react';

export type LinkPopoverMode = 'hover' | 'edit';

export interface LinkPopoverProps {
  mode: LinkPopoverMode;
  /** CSS center-X of the link rect. */
  anchorX: number;
  /** CSS bottom-Y of the link rect (popover sits below). */
  anchorY: number;
  url: string;
  displayText: string;
  onUrlChange?: (url: string) => void;
  onDisplayChange?: (text: string) => void;
  onEdit: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onClose?: () => void;
  onPopoverEnter?: () => void;
  onPopoverLeave?: () => void;
}

/**
 * Acrobat/Sejda-style link popovers over the PDF page.
 * Hover: URL + Edit + Open Link
 * Edit: Display / Link to / Link + Remove + Open Link
 */
export function LinkPopover({
  mode,
  anchorX,
  anchorY,
  url,
  displayText,
  onUrlChange,
  onDisplayChange,
  onEdit,
  onOpen,
  onRemove,
  onClose,
  onPopoverEnter,
  onPopoverLeave,
}: LinkPopoverProps) {
  const displayRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'edit') {
      displayRef.current?.focus();
      displayRef.current?.select();
    }
  }, [mode]);

  // Canvas-local z-50 (Z_LAYERS.canvasMin..canvasMax), not a global dropdown.
  return (
    <div
      className="absolute z-50"
      data-link-popover
      style={{ left: anchorX, top: anchorY, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onPopoverEnter}
      onMouseLeave={onPopoverLeave}
    >
      {/* Invisible bridge so the pointer can travel from the link into the popover */}
      <div className="h-3 w-full" aria-hidden />

      {/* Caret pointer */}
      <div
        className="absolute top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-zinc-100 border-l border-t border-zinc-200"
        aria-hidden
      />

      {mode === 'hover' ? (
        <div className="relative bg-zinc-100 rounded-xl shadow-lg border border-zinc-200/80 p-2.5 min-w-[220px] max-w-[320px]">
          <div className="bg-zinc-200/80 rounded-lg px-3 py-2 text-[12px] text-zinc-700 font-mono truncate mb-2">
            {url || '(empty URL)'}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="flex-1 py-2 rounded-lg bg-zinc-200 hover:bg-zinc-300 text-zinc-700 text-[12px] font-semibold transition-colors"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onOpen}
              className="flex-1 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-[12px] font-semibold transition-colors"
            >
              Open Link
            </button>
          </div>
        </div>
      ) : (
        <div className="relative bg-zinc-200 rounded-xl shadow-lg border border-zinc-300/80 p-3 w-[280px]">
          <div className="space-y-2.5">
            <label className="flex items-center gap-2 text-[12px] text-zinc-600">
              <span className="w-14 shrink-0">Display:</span>
              <input
                ref={displayRef}
                type="text"
                value={displayText}
                onChange={(e) => onDisplayChange?.(e.target.value)}
                className="flex-1 min-w-0 rounded-md border-2 border-orange-400 bg-white px-2 py-1 text-[12px] text-zinc-800 outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-zinc-600">
              <span className="w-14 shrink-0">Link to:</span>
              <div className="flex-1 flex items-center rounded-md border border-zinc-300 bg-white px-2 py-1 text-[12px] text-zinc-800">
                <span className="flex-1">Web page</span>
                <span className="ml-1 w-5 h-5 rounded bg-orange-500 text-white text-[10px] flex items-center justify-center">↕</span>
              </div>
            </label>
            <label className="flex items-center gap-2 text-[12px] text-zinc-600">
              <span className="w-14 shrink-0">Link:</span>
              <input
                type="url"
                value={url}
                onChange={(e) => onUrlChange?.(e.target.value)}
                className="flex-1 min-w-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[12px] text-zinc-800 outline-none focus:border-orange-400"
              />
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onRemove}
                className="flex-1 py-2 rounded-lg bg-zinc-300 hover:bg-zinc-400 text-zinc-700 text-[12px] font-semibold transition-colors"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={onOpen}
                className="flex-1 py-2 rounded-lg bg-zinc-300 hover:bg-zinc-400 text-zinc-700 text-[12px] font-semibold transition-colors"
              >
                Open Link
              </button>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-zinc-500 text-white text-[10px] leading-none hover:bg-zinc-600"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}
