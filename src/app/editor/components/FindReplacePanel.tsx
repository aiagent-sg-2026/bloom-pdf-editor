'use client';

import React from 'react';
import { Search, Replace, ChevronUp, ChevronDown, CaseSensitive, X, Loader2 } from 'lucide-react';

export interface FindReplacePanelProps {
  findText: string;
  onFindTextChange: (val: string) => void;
  replaceText: string;
  onReplaceTextChange: (val: string) => void;
  matchCount: number;
  currentMatchIndex: number;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  onClose?: () => void;
  busy?: boolean;
}

export function FindReplacePanel({
  findText,
  onFindTextChange,
  replaceText,
  onReplaceTextChange,
  matchCount,
  currentMatchIndex,
  onNextMatch,
  onPrevMatch,
  onReplaceCurrent,
  onReplaceAll,
  caseSensitive,
  onToggleCaseSensitive,
  onClose,
  busy = false,
}: FindReplacePanelProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevMatch();
      } else {
        onNextMatch();
      }
    }
  };

  return (
    <div data-theme="dark" className="p-3 space-y-2.5 bg-zinc-900/95 backdrop-blur-md rounded-xl border border-zinc-700/80 shadow-2xl w-full md:w-72 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-zinc-300 uppercase">
          <Search size={13} className="text-accent" />
          Find & Replace
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 p-1 rounded-md hover:bg-zinc-800 transition-colors"
            title="Close Search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Find input row with navigation & case sensitive controls */}
      <div className="space-y-1">
        <div className="relative flex items-center">
          <input
            value={findText}
            onChange={(e) => onFindTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search text in PDF..."
            autoFocus
            className="w-full bg-zinc-800/90 border border-zinc-700 focus:border-accent focus:ring-1 focus:ring-accent rounded-lg pl-2.5 pr-20 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 outline-none transition-all"
          />

          <div className="absolute right-1 flex items-center gap-0.5">
            {/* Match Counter Badge */}
            {findText.trim() !== '' && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-300 mr-1">
                {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '0'}
              </span>
            )}

            {/* Case Sensitivity Toggle */}
            <button
              onClick={onToggleCaseSensitive}
              title={caseSensitive ? 'Match Case (Active)' : 'Match Case (Inactive)'}
              className={`p-1 rounded transition-colors ${
                caseSensitive
                  ? 'bg-bloom-100 text-accent font-bold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
              }`}
            >
              <CaseSensitive size={14} />
            </button>

            {/* Prev / Next Buttons */}
            <button
              onClick={onPrevMatch}
              disabled={matchCount === 0}
              title="Previous Match (Shift+Enter)"
              className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50 rounded disabled:opacity-30 transition-colors"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={onNextMatch}
              disabled={matchCount === 0}
              title="Next Match (Enter)"
              className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50 rounded disabled:opacity-30 transition-colors"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Replace input row */}
      <div className="space-y-1">
        <input
          value={replaceText}
          onChange={(e) => onReplaceTextChange(e.target.value)}
          placeholder="Replace with..."
          className="w-full bg-zinc-800/90 border border-zinc-700 focus:border-accent focus:ring-1 focus:ring-accent rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 outline-none transition-all"
        />
      </div>

      {/* Replace Actions */}
      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
        <button
          onClick={onReplaceCurrent}
          disabled={busy || matchCount === 0 || !findText.trim()}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-zinc-800 hover:bg-zinc-700/90 text-zinc-200 border border-zinc-700 hover:border-zinc-600 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Replace size={12} />}
          Replace
        </button>
        <button
          onClick={onReplaceAll}
          disabled={busy || matchCount === 0 || !findText.trim()}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-bloom-100 hover:bg-bloom-100/80 text-accent border border-accent/40 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Replace size={12} />}
          Replace All
        </button>
      </div>
    </div>
  );
}
