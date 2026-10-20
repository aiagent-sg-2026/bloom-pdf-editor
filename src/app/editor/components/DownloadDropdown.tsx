'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Download,
  ChevronDown,
  Loader2,
  Gauge,
  Target,
  HardDrive,
  Info,
} from 'lucide-react';
import type { PDFDocumentData } from '@/engine/browser-core';
import {
  estimateDocumentSize,
  formatFileSize,
  type SizeEstimation,
} from '../export-formats';

import {
  COMPRESSION_PRESETS,
  DEFAULT_DOWNLOAD_OPTIONS,
  DPI_PRESETS,
  downloadQualityLabel,
} from './downloadQualityOptions';
import type { CompressedDownloadOptions } from './downloadQualityOptions';

// ─── Props ──────────────────────────────────────────────────────────────────────

interface DownloadDropdownProps {
  isSaving: boolean;
  onDownload: () => void;
  saveMode: 'quick' | 'optimized';
  onSaveModeChange: (mode: 'quick' | 'optimized') => void;
  doc: PDFDocumentData | null;
  /** Custom download with compression / DPI / target size. */
  onCompressedDownload?: (opts: CompressedDownloadOptions) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function DownloadDropdown({
  isSaving,
  onDownload,
  onSaveModeChange,
  doc,
  onCompressedDownload,
  saveMode,
}: DownloadDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedDpi, setSelectedDpi] = useState<number | null>(DEFAULT_DOWNLOAD_OPTIONS.dpi);
  const [compressionQuality, setCompressionQuality] = useState<number | null>(DEFAULT_DOWNLOAD_OPTIONS.quality);
  const [sizeEstimation, setSizeEstimation] = useState<SizeEstimation | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && doc) {
      setSizeEstimation(estimateDocumentSize(doc));
    }
  }, [isOpen, doc]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen]);

  const handleOptionsDownload = useCallback(() => {
    if (!onCompressedDownload) {
      onDownload();
      setIsOpen(false);
      return;
    }
    onCompressedDownload({
      quality: compressionQuality === null ? null : compressionQuality / 100,
      dpi: selectedDpi,
    });
    setIsOpen(false);
  }, [
    onCompressedDownload,
    onDownload,
    compressionQuality,
    selectedDpi,
  ]);

  const currentSize = sizeEstimation?.currentSizeBytes ?? 0;

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex items-stretch shadow-md shadow-accent/15 rounded-xl">
        <button
          onClick={onDownload}
          disabled={isSaving}
          title="Download original / edited PDF (no recompression)"
          className="flex items-center gap-2 text-xs font-semibold pl-3 md:pl-4 pr-2 md:pr-3 py-2 bg-gradient-to-b from-bloom-500 to-bloom-600 hover:from-bloom-600 hover:to-bloom-700 disabled:from-zinc-700 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-l-xl transition-all duration-200 ease-out active:scale-[0.98]"
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          <span className="hidden sm:inline">Download</span>
        </button>

        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={isSaving}
          title="Download options"
          className="flex items-center px-2 py-2 bg-gradient-to-b from-bloom-500 to-bloom-600 hover:from-bloom-600 hover:to-bloom-700 disabled:from-zinc-700 disabled:to-zinc-800 disabled:text-zinc-500 text-white rounded-r-xl border-l border-bloom-200/30 transition-all duration-200 ease-out active:scale-[0.98]"
        >
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* Z_LAYERS.drawer (400) on mobile; dropdown (200) and tooltips on desktop. */}
      {isOpen && (
        <div
          className="fixed inset-x-0 bottom-0 md:absolute md:inset-auto md:right-0 md:top-full md:mt-2 w-full md:w-[380px] bg-panel/98 backdrop-blur-2xl border border-app md:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/50 overflow-hidden z-[400] md:z-[200] text-app max-h-[80vh] md:max-h-none overflow-y-auto"
          style={{ animation: 'dropdownIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          <div className="px-5 pt-4 pb-3 border-b border-app">
            <div className="flex items-center gap-2 mb-1">
              <HardDrive size={13} className="text-app-muted" />
              <span className="text-[11px] font-medium text-app-muted uppercase tracking-wider">Current File</span>
            </div>
            <div className="text-lg font-semibold text-app tracking-tight">
              {currentSize > 0 ? formatFileSize(currentSize) : '—'}
            </div>
            {sizeEstimation && sizeEstimation.imageCount > 0 && (
              <p className="text-[10px] text-app-faint mt-1">
                {sizeEstimation.imageCount} image{sizeEstimation.imageCount > 1 ? 's' : ''} · {sizeEstimation.pageCount} page{sizeEstimation.pageCount > 1 ? 's' : ''}
              </p>
            )}
          </div>

          <div className="px-5 py-3 border-b border-app">
            <div className="flex items-center gap-1.5 mb-2">
              <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider block">
                Save Mode
              </label>
              <div className="group relative flex items-center justify-center">
                <Info size={12} className="text-app-muted hover:text-app cursor-help transition-colors" />
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 p-2.5 bg-panel-elevated border border-app rounded-xl shadow-xl text-[10.5px] text-app opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[200] leading-relaxed">
                  <strong className="text-app font-semibold">Save Mode</strong> determines how changes are saved.
                  <ul className="mt-1.5 space-y-1 list-disc pl-3.5 text-app-muted">
                    <li><strong className="text-app">Optimized:</strong> Rebuilds the file and removes unused data. Slower, but results in a smaller file.</li>
                    <li><strong className="text-app">Quick:</strong> Appends changes to the end. Faster, but file size grows over time.</li>
                  </ul>
                  <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-app" />
                </div>
              </div>
            </div>
            <div className="flex gap-1.5 p-1 bg-panel-elevated rounded-xl border border-app">
              {[
                { value: 'optimized' as const, label: 'Optimized', desc: 'GC + dedup' },
                { value: 'quick' as const, label: 'Quick', desc: 'Incremental' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onSaveModeChange(opt.value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                    saveMode === opt.value
                      ? 'bg-bloom-500 text-white shadow-sm font-semibold'
                      : 'text-app-muted hover:text-app'
                  }`}
                >
                  {opt.label}
                  <span className="block text-[9px] opacity-70 mt-0.5">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="px-5 py-3 border-b border-app">
            <div className="flex items-center gap-2 mb-2">
              <Gauge size={13} className="text-app-muted" />
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider">
                  Resolution
                </label>
                <div className="group relative flex items-center justify-center">
                  <Info size={12} className="text-app-muted hover:text-app cursor-help transition-colors" />
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 p-2.5 bg-panel-elevated border border-app rounded-xl shadow-xl text-[10.5px] text-app opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[200] leading-relaxed">
                    <strong className="text-app font-semibold">DPI (Dots Per Inch)</strong> controls image clarity. Higher DPI looks better but makes the file bigger.
                    <ul className="mt-1.5 space-y-1 list-disc pl-3.5 text-app-muted">
                      <li><strong className="text-app">Original:</strong> No downsampling.</li>
                      <li><strong className="text-app">72:</strong> Good for sharing on web/email.</li>
                      <li><strong className="text-app">150:</strong> Good balance for viewing on screens.</li>
                      <li><strong className="text-app">300:</strong> Standard for high-quality printing.</li>
                      <li><strong className="text-app">600:</strong> Maximum detail (very large file).</li>
                    </ul>
                    <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-app" />
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {DPI_PRESETS.map(preset => (
                <button
                  key={preset.value ?? 'original'}
                  onClick={() => setSelectedDpi(preset.value)}
                  title={preset.desc}
                  aria-pressed={selectedDpi === preset.value}
                  className={`px-2 py-2 rounded-lg text-center transition-all duration-200 ${
                    selectedDpi === preset.value
                      ? 'bg-bloom-100 text-accent border border-accent/40 ring-1 ring-accent/20 font-semibold'
                      : 'bg-panel-elevated text-app-muted border border-app hover:text-app'
                  }`}
                >
                  <div className="text-xs font-medium">{preset.label}</div>
                  <div className="text-[9px] opacity-60 mt-0.5">{preset.value ?? 'No resize'}</div>
                </button>
              ))}
            </div>
            <p className="text-[9px] text-app-faint mt-2">
              {compressionQuality === null && selectedDpi !== null
                ? 'Downsampling requires image re-encoding. Choose a compression preset to apply this DPI; Original compression keeps image bytes unchanged.'
                : 'Original keeps image resolution. Other presets downsample embedded images.'}
            </p>
          </div>

          <div className="px-5 py-3 border-b border-app">
            <div className="flex items-center gap-2 mb-2">
              <Target size={13} className="text-app-muted" />
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider">
                  Compression
                </label>
                <div className="group relative flex items-center justify-center">
                  <Info size={12} className="text-app-muted hover:text-app cursor-help transition-colors" />
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 p-2.5 bg-panel-elevated border border-app rounded-xl shadow-xl text-[10.5px] text-app opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[200] leading-relaxed">
                    <strong className="text-app font-semibold">Compression</strong> shrinks the file size.
                    <p className="mt-1.5 text-app-muted">Original passes image bytes through unchanged. Lower quality makes images smaller but slightly blurrier.</p>
                    <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-app" />
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {COMPRESSION_PRESETS.map(preset => (
                <button
                  key={preset.value ?? 'original'}
                  onClick={() => setCompressionQuality(preset.value)}
                  aria-pressed={compressionQuality === preset.value}
                  className={`px-2 py-2 rounded-lg text-center transition-all duration-200 ${
                    compressionQuality === preset.value
                      ? 'bg-bloom-100 text-accent border border-accent/40 ring-1 ring-accent/20 font-semibold'
                      : 'bg-panel-elevated text-app-muted border border-app hover:text-app'
                  }`}
                >
                  <div className="text-xs font-medium">{preset.label}</div>
                  <div className="text-[9px] opacity-60 mt-0.5">{preset.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="px-5 py-3">
            <p className="text-[10px] text-app-faint mb-2 leading-relaxed">
              The default keeps original quality, just like the left “Download”. Compression is applied only when you choose a compression preset.
            </p>
            <button
              onClick={handleOptionsDownload}
              disabled={isSaving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-b from-bloom-500 to-bloom-600 hover:from-bloom-600 hover:to-bloom-700 disabled:from-zinc-700 disabled:to-zinc-800 disabled:text-zinc-500 text-white font-medium text-sm rounded-xl shadow-lg shadow-accent/25 transition-all duration-200 ease-out active:scale-[0.98]"
            >
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {downloadQualityLabel({
                quality: compressionQuality === null ? null : compressionQuality / 100,
                dpi: selectedDpi,
              })}
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes dropdownIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
