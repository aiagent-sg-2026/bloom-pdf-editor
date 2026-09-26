'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  X,
  Image as ImageIcon,
  Camera,
  Pencil,
  AlignLeft,
  Download,
  ChevronRight,
  Check,
  Loader2,
} from 'lucide-react';
import type { PDFDocumentData } from '@/engine/browser-core';
import {
  EXPORT_FORMATS,
  exportDocument,
  type ExportFormat,
  type ExportOptions,
} from '../export-formats';

// ─── Icon mapping ───────────────────────────────────────────────────────────────

const FORMAT_ICONS: Record<ExportFormat, React.ReactNode> = {
  png: <ImageIcon size={22} />,
  jpeg: <Camera size={22} />,
  svg: <Pencil size={22} />,
  txt: <AlignLeft size={22} />,
};

const FORMAT_GRADIENTS: Record<ExportFormat, string> = {
  png: 'from-sky-500/20 to-sky-600/5',
  jpeg: 'from-amber-500/20 to-amber-600/5',
  svg: 'from-cyan-500/20 to-cyan-600/5',
  txt: 'from-zinc-400/20 to-zinc-500/5',
};

const FORMAT_ACCENT: Record<ExportFormat, string> = {
  png: 'text-sky-400',
  jpeg: 'text-amber-400',
  svg: 'text-cyan-400',
  txt: 'text-zinc-400',
};

const FORMAT_RING: Record<ExportFormat, string> = {
  png: 'ring-sky-500/40',
  jpeg: 'ring-amber-500/40',
  svg: 'ring-cyan-500/40',
  txt: 'ring-zinc-500/40',
};

// ─── Props ──────────────────────────────────────────────────────────────────────

interface ExportPanelProps {
  isOpen: boolean;
  onClose: () => void;
  doc: PDFDocumentData | null;
  engine: typeof import('@/engine/browser-core') | null;
  fileName: string;
  totalPages: number;
  currentPage: number;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function ExportPanel({
  isOpen,
  onClose,
  doc,
  engine,
  fileName,
  totalPages,
  currentPage,
}: ExportPanelProps) {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('png');
  const [pageRange, setPageRange] = useState<'all' | 'current' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState(1);
  const [customTo, setCustomTo] = useState(totalPages);
  const [dpi, setDpi] = useState(150);
  const [jpegQuality, setJpegQuality] = useState(92);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportTotal, setExportTotal] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const formatInfo = EXPORT_FORMATS.find((f) => f.id === selectedFormat)!;

  // Reset panel state when it opens.
  useEffect(() => {
    if (!isOpen) return;
    setExportDone(false);
    setExportError(null);
    setExportProgress(0);
    setCustomTo(totalPages);
  }, [isOpen, totalPages]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const getPageIndices = useCallback((): number[] | null => {
    if (pageRange === 'all') return null;
    if (pageRange === 'current') return [currentPage];
    const from = Math.max(0, customFrom - 1);
    const to = Math.min(totalPages - 1, customTo - 1);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }, [pageRange, currentPage, customFrom, customTo, totalPages]);

  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleRenderExport = useCallback(async () => {
    if (!doc || !engine) return;

    setIsExporting(true);
    setExportDone(false);
    setExportError(null);
    setExportProgress(0);

    try {
      const title = fileName.replace(/\.pdf$/i, '') || 'export';
      const options: ExportOptions = {
        format: selectedFormat,
        pages: getPageIndices(),
        dpi,
        quality: jpegQuality / 100,
        title,
      };

      const result = await exportDocument(doc, engine, options, (current, total) => {
        setExportProgress(current);
        setExportTotal(total);
      });

      triggerDownload(result.blob, result.filename);
      setExportDone(true);
    } catch (err) {
      console.error('[Export] Failed:', err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, engine, fileName, selectedFormat, getPageIndices, dpi, jpegQuality, triggerDownload]);

  if (!isOpen) return null;

  const progressPct = exportTotal > 0 ? Math.round((exportProgress / exportTotal) * 100) : 0;
  const primaryDisabled = !doc || !engine || isExporting;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        style={{ animation: 'fadeIn 0.2s ease-out' }}
        onClick={onClose}
      />

      <div
        ref={panelRef}
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-[520px] flex flex-col"
        style={{
          animation: 'slideInRight 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="flex flex-col h-full bg-zinc-900/95 backdrop-blur-2xl border-l border-zinc-700/50 shadow-2xl">
          <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-800/80">
            <div>
              <h2 className="text-lg font-semibold text-white tracking-tight">Export Document</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                {fileName} · {totalPages} page{totalPages !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all duration-200"
            >
              <X size={18} />
            </button>
          </div>

          <div
            className="flex-1 overflow-y-auto px-6 py-5 space-y-6"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#3f3f46 transparent' }}
          >
            <div>
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-3 block">
                  Render format
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {EXPORT_FORMATS.map((fmt) => (
                    <button
                      key={fmt.id}
                      onClick={() => setSelectedFormat(fmt.id)}
                      className={`
                        group relative flex items-center gap-3 px-4 py-3.5 rounded-xl border text-left
                        transition-all duration-200 ease-out
                        ${
                          selectedFormat === fmt.id
                            ? `bg-gradient-to-br ${FORMAT_GRADIENTS[fmt.id]} border-zinc-600/80 ring-2 ${FORMAT_RING[fmt.id]} shadow-lg`
                            : 'bg-zinc-800/40 border-zinc-800 hover:bg-zinc-800/80 hover:border-zinc-700'
                        }
                      `}
                    >
                      <div
                        className={`
                        flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center
                        transition-all duration-200
                        ${
                          selectedFormat === fmt.id
                            ? `${FORMAT_ACCENT[fmt.id]} bg-white/5`
                            : 'text-zinc-500 bg-zinc-800/60 group-hover:text-zinc-300'
                        }
                      `}
                      >
                        {FORMAT_ICONS[fmt.id]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-sm font-medium truncate ${selectedFormat === fmt.id ? 'text-white' : 'text-zinc-300'}`}
                        >
                          {fmt.label}
                        </div>
                        <div className="text-[10px] text-zinc-500 truncate leading-snug mt-0.5">
                          {fmt.extension}
                        </div>
                      </div>
                      {selectedFormat === fmt.id && (
                        <div
                          className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${FORMAT_ACCENT[fmt.id]} bg-white/10`}
                        >
                          <Check size={12} strokeWidth={3} />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-zinc-500 leading-relaxed">{formatInfo.description}</p>
            </div>

            {/* Page Range */}
            <div>
              <label className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-3 block">
                Pages
              </label>
              <div className="flex gap-1.5 p-1 bg-zinc-800/60 rounded-xl border border-zinc-800">
                {[
                  { value: 'all' as const, label: 'All Pages' },
                  { value: 'current' as const, label: `Page ${currentPage + 1}` },
                  { value: 'custom' as const, label: 'Range' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setPageRange(opt.value)}
                    className={`
                      flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-all duration-200
                      ${
                        pageRange === opt.value
                          ? 'bg-zinc-700 text-white shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }
                    `}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {pageRange === 'custom' && (
                <div className="flex items-center gap-3 mt-3">
                  <div className="flex-1">
                    <label className="text-[10px] text-zinc-600 mb-1 block">From</label>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={customFrom}
                      onChange={(e) =>
                        setCustomFrom(Math.max(1, Math.min(totalPages, Number(e.target.value))))
                      }
                      className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:ring-2 focus:ring-[#E8607A]/40 focus:border-[#E8607A]/50 outline-none transition-all"
                    />
                  </div>
                  <span className="text-zinc-600 text-xs mt-4">to</span>
                  <div className="flex-1">
                    <label className="text-[10px] text-zinc-600 mb-1 block">To</label>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={customTo}
                      onChange={(e) =>
                        setCustomTo(Math.max(1, Math.min(totalPages, Number(e.target.value))))
                      }
                      className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:ring-2 focus:ring-[#E8607A]/40 focus:border-[#E8607A]/50 outline-none transition-all"
                    />
                  </div>
                </div>
              )}
            </div>

            {(formatInfo.supportsDpi || formatInfo.supportsQuality) && (
              <div className="space-y-4">
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-widest block">
                  Quality Settings
                </label>

                {formatInfo.supportsDpi && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-zinc-400">Resolution (DPI)</span>
                      <span className="text-xs font-mono text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded">
                        {dpi}
                      </span>
                    </div>
                    <div className="flex gap-1.5 p-1 bg-zinc-800/60 rounded-xl border border-zinc-800">
                      {[
                        { value: 72, label: 'Screen' },
                        { value: 150, label: 'Standard' },
                        { value: 300, label: 'Print' },
                        { value: 600, label: 'High' },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setDpi(opt.value)}
                          className={`
                            flex-1 px-2 py-2 text-xs font-medium rounded-lg transition-all duration-200
                            ${
                              dpi === opt.value
                                ? 'bg-zinc-700 text-white shadow-sm'
                                : 'text-zinc-500 hover:text-zinc-300'
                            }
                          `}
                        >
                          <div>{opt.label}</div>
                          <div className="text-[9px] opacity-60 mt-0.5">{opt.value} DPI</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {formatInfo.supportsQuality && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-zinc-400">JPEG Quality</span>
                      <span className="text-xs font-mono text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded">
                        {jpegQuality}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={jpegQuality}
                      onChange={(e) => setJpegQuality(Number(e.target.value))}
                      className="w-full accent-[#E8607A]"
                      style={{ height: '4px' }}
                    />
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-zinc-600">Smaller file</span>
                      <span className="text-[10px] text-zinc-600">Best quality</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {exportError && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                {exportError}
              </div>
            )}

            {exportDone && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center gap-2">
                <Check size={14} />
                Export complete — file downloaded!
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-zinc-800/80 bg-zinc-900/90">
            {isExporting ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Exporting…
                  </span>
                  <span className="text-zinc-300 font-mono">
                    {exportProgress}/{exportTotal}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[#E8607A] to-[#FF9BB3] rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            ) : (
              <button
                onClick={() => void handleRenderExport()}
                disabled={primaryDisabled}
                className="
                  w-full flex items-center justify-center gap-2.5 px-4 py-3
                  bg-gradient-to-b from-[#E8607A] to-[#D94D6A]
                  hover:from-[#FF6B8E] hover:to-[#E8607A]
                  disabled:from-zinc-700 disabled:to-zinc-800 disabled:text-zinc-500
                  text-white font-medium text-sm rounded-xl
                  shadow-lg shadow-[#E8607A]/30
                  transition-all duration-200 ease-out
                  active:scale-[0.98]
                "
              >
                <Download size={16} />
                {`Export as ${formatInfo.label}`}
                <ChevronRight size={14} className="opacity-50" />
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}
