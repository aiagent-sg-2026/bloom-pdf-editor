import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ZoomOut, ZoomIn, X, Undo2, Redo2, Search, FileOutput, Sun, Moon } from 'lucide-react';
import type { DrawnPath } from '../types';
import type { PDFDocumentData } from '@/engine/browser-core';
import { DownloadDropdown } from './DownloadDropdown';
import { useTheme } from '@/app/theme/ThemeProvider';

interface ToolbarProps {
  fileName: string;
  currentPage: number;
  totalPages: number;
  scale: number;
  drawnPaths: DrawnPath[];
  isSaving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onClose: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearPaths: () => void;
  onDownload: () => void;
  saveMode?: 'quick' | 'optimized';
  onSaveModeChange?: (mode: 'quick' | 'optimized') => void;
  onToggleSearch?: () => void;
  isSearchOpen?: boolean;
  /** Open the export panel */
  onExport?: () => void;
  /** PDF document for size estimation */
  doc?: PDFDocumentData | null;
  /** Compressed download handler */
  onCompressedDownload?: (opts: import('./DownloadDropdown').CompressedDownloadOptions) => void;
}

export function Toolbar({
  fileName,
  currentPage,
  totalPages,
  scale,
  drawnPaths,
  isSaving,
  canUndo,
  canRedo,
  onClose,
  onPrevPage,
  onNextPage,
  onZoomIn,
  onZoomOut,
  onUndo,
  onRedo,
  onClearPaths,
  onDownload,
  saveMode,
  onSaveModeChange,
  onToggleSearch,
  isSearchOpen,
  onExport,
  doc,
  onCompressedDownload,
}: ToolbarProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="flex items-center justify-between px-2 md:px-4 h-12 md:h-14 bg-panel/90 backdrop-blur-lg border-b border-app shrink-0 z-40">
      {/* ── Left: close + logo + filename ── */}
      <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
        <button 
          onClick={onClose} 
          className="p-1.5 text-app-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all duration-200" 
          title="Close file & return home"
        >
          <X size={18} />
        </button>
        <Link href="/" className="flex items-center gap-2 mr-1.5 group">
          <Image
            src="/logo.png"
            alt="BloomPDF Logo"
            width={32}
            height={32}
            className="w-6 h-6 md:w-7 md:h-7 object-contain shrink-0"
            priority
          />
          <span className="hidden sm:inline font-bold text-sm tracking-tight text-app group-hover:text-[#E8607A] transition-colors">
            Bloom<span className="text-[#E8607A]">PDF</span>
          </span>
        </Link>
        <div className="w-[1px] h-4 bg-[var(--border)] hidden md:block" />
        <span className="hidden md:inline text-app font-medium text-xs sm:text-sm truncate max-w-[200px] opacity-90">{fileName}</span>
      </div>

      {/* ── Center: undo/redo, page nav, zoom ── */}
      <div className="flex items-center gap-1 md:gap-2 bg-panel-elevated px-1.5 md:px-2 py-1 md:py-1.5 rounded-lg border border-app shadow-sm overflow-x-auto scrollbar-hide">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={16} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={16} />
        </button>

        <div className="w-[1px] h-4 bg-[var(--border)] mx-0.5 md:mx-1 hidden sm:block shrink-0" />

        <button onClick={onPrevPage} disabled={currentPage === 0} className="p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0">
          <ChevronLeft size={18} />
        </button>
        <span className="text-app-muted text-xs font-medium w-12 md:w-16 text-center tracking-wider shrink-0">
          {currentPage + 1} / {totalPages}
        </span>
        <button onClick={onNextPage} disabled={currentPage >= totalPages - 1} className="p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0">
          <ChevronRight size={18} />
        </button>

        <div className="w-[1px] h-4 bg-[var(--border)] mx-0.5 md:mx-2 hidden sm:block shrink-0" />

        <button onClick={onZoomOut} disabled={scale <= 0.5} className="p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0">
          <ZoomOut size={16} />
        </button>
        <span className="text-app-muted text-xs font-medium w-10 md:w-12 text-center shrink-0">
          {Math.round(scale * 100)}%
        </span>
        <button onClick={onZoomIn} disabled={scale >= 4} className="p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0">
          <ZoomIn size={16} />
        </button>
      </div>

      {/* ── Right: actions ── */}
      <div className="flex items-center gap-1 md:gap-2 shrink-0">
        <button
          onClick={toggleTheme}
          className="p-1.5 md:p-2 rounded-lg transition-colors border bg-panel-elevated text-app-muted hover:text-app border-app"
          title={theme === 'dark' ? 'Switch to white mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {onToggleSearch && (
          <button
            onClick={onToggleSearch}
            className={`p-1.5 md:p-2 rounded-lg transition-colors border ${isSearchOpen ? 'bg-[#E8607A]/20 text-[#E8607A] border-[#E8607A]/50' : 'bg-panel-elevated text-app-muted hover:text-app border-app'}`}
            title="Toggle Find & Replace"
          >
            <Search size={16} />
          </button>
        )}

        {drawnPaths.length > 0 && (
          <button
            onClick={onClearPaths}
            className="hidden sm:block text-xs font-medium px-3 py-1.5 text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded-md transition-colors"
          >
            Clear
          </button>
        )}

        {onExport && (
          <>
            <div className="w-[1px] h-6 bg-[var(--border)] hidden md:block" />
            <button
              onClick={onExport}
              className="
                flex items-center gap-1.5 text-xs font-medium px-2 md:px-3 py-1.5 md:py-2
                bg-panel-elevated hover:opacity-90
                text-app-muted hover:text-app
                border border-app
                rounded-xl transition-all duration-200
              "
              title="Export to Word, PNG, Markdown, etc."
            >
              <FileOutput size={14} />
              <span className="hidden sm:inline">Export</span>
            </button>
          </>
        )}

        <div className="w-[1px] h-6 bg-[var(--border)] hidden sm:block" />

        <DownloadDropdown
          isSaving={isSaving}
          onDownload={onDownload}
          saveMode={saveMode ?? 'optimized'}
          onSaveModeChange={onSaveModeChange ?? (() => {})}
          doc={doc ?? null}
          onCompressedDownload={onCompressedDownload}
        />
      </div>
    </header>
  );
}
