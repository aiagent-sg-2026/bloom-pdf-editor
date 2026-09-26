'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, PenLine, Upload, Type, Eraser, Check } from 'lucide-react';
import {
  SignatureDrawEngine,
  importSignatureFile,
  isAllowedSignatureFile,
  renderTypedSignature,
  listTypedSignatureFonts,
  buildSignatureAppearance,
  renderSignatureAppearance,
  listAppearanceTemplates,
  type SignatureSourceKind,
  type SignatureLibraryEntry,
} from '@/engine/browser-core';

export interface SignatureCreateResult {
  entry: Omit<SignatureLibraryEntry, 'id' | 'createdAt' | 'updatedAt' | 'favorite'>;
  appearanceId?: string;
  appearanceImageDataUrl?: string;
}

interface SignatureCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (result: SignatureCreateResult) => void;
}

type Tab = 'draw' | 'upload' | 'typed';

export function SignatureCreateDialog({ open, onOpenChange, onSave }: SignatureCreateDialogProps) {
  const [tab, setTab] = useState<Tab>('draw');
  const [name, setName] = useState('My signature');
  const [drawColor, setDrawColor] = useState('#1a1a2e');
  const [drawWidth, setDrawWidth] = useState(2.5);
  const [typedText, setTypedText] = useState('');
  const [typedFont, setTypedFont] = useState(listTypedSignatureFonts()[0]);
  const [typedSize, setTypedSize] = useState(48);
  const [typedColor, setTypedColor] = useState('#1a1a2e');
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadDims, setUploadDims] = useState<{ w: number; h: number } | null>(null);
  const [templateId, setTemplateId] = useState('minimal');
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef(new SignatureDrawEngine());
  const drawingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // subtle guide line
    ctx.strokeStyle = '#e4e4e7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, canvas.height * 0.72);
    ctx.lineTo(canvas.width - 24, canvas.height * 0.72);
    ctx.stroke();
    engineRef.current.paint(ctx);
  }, []);

  useEffect(() => {
    if (!open) return;
    engineRef.current = new SignatureDrawEngine({ color: drawColor, width: drawWidth });
    setUploadPreview(null);
    setUploadDims(null);
    setError(null);
    requestAnimationFrame(redraw);
  }, [open, redraw]);

  useEffect(() => {
    engineRef.current.setStyle({ color: drawColor, width: drawWidth });
  }, [drawColor, drawWidth]);

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
      pressure: e.pressure || undefined,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    engineRef.current.beginStroke(canvasPoint(e));
    redraw();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    engineRef.current.addPoint(canvasPoint(e));
    redraw();
  };
  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    engineRef.current.endStroke();
    redraw();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      if (!isAllowedSignatureFile(file)) throw new Error('Use PNG, JPG, or SVG');
      const imported = await importSignatureFile(file);
      setUploadPreview(imported.imageDataUrl);
      setUploadDims({ w: imported.width, h: imported.height });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const buildEntry = async (): Promise<SignatureCreateResult | null> => {
    setError(null);
    let imageDataUrl = '';
    let width = 160;
    let height = 60;
    let source: SignatureSourceKind = 'draw';
    let typedMeta: Partial<SignatureLibraryEntry> = {};

    if (tab === 'draw') {
      const canvas = canvasRef.current;
      if (!canvas || engineRef.current.isEmpty()) {
        setError('Draw a signature first');
        return null;
      }
      const url = engineRef.current.toDataURL(canvas.width, canvas.height);
      if (!url) {
        setError('Could not export drawing');
        return null;
      }
      imageDataUrl = url;
      source = 'draw';
      // rough dims from canvas crop
      width = 200;
      height = 80;
    } else if (tab === 'upload') {
      if (!uploadPreview || !uploadDims) {
        setError('Upload a PNG, JPG, or SVG');
        return null;
      }
      imageDataUrl = uploadPreview;
      width = uploadDims.w;
      height = uploadDims.h;
      source = 'upload';
    } else {
      if (!typedText.trim()) {
        setError('Enter a name to type');
        return null;
      }
      const rendered = renderTypedSignature({
        text: typedText,
        fontFamily: typedFont,
        fontSize: typedSize,
        color: typedColor,
      });
      imageDataUrl = rendered.imageDataUrl;
      width = rendered.width;
      height = rendered.height;
      source = 'typed';
      typedMeta = {
        typedText: rendered.text,
        typedFont: rendered.fontFamily,
        typedColor: rendered.color,
        typedFontSize: rendered.fontSize,
      };
    }

    // Wrap with appearance template (Phase 3)
    const appearance = buildSignatureAppearance({
      templateId,
      name,
      signatureImageDataUrl: imageDataUrl,
      typedName: tab === 'typed' ? typedText : name,
      date: new Date().toLocaleDateString(),
    });
    const renderedAp = renderSignatureAppearance(appearance, {
      width: Math.max(220, width),
      height: Math.max(90, height + 40),
      preferVector: true,
    });

    return {
      entry: {
        name,
        source,
        imageDataUrl: templateId === 'minimal' ? imageDataUrl : renderedAp.imageDataUrl,
        width: templateId === 'minimal' ? width : renderedAp.width,
        height: templateId === 'minimal' ? height : renderedAp.height,
        ...typedMeta,
      },
      appearanceId: appearance.id,
      appearanceImageDataUrl: renderedAp.imageDataUrl,
    };
  };

  const handleSave = async () => {
    const result = await buildEntry();
    if (!result) return;
    onSave(result);
    onOpenChange(false);
  };

  const fonts = listTypedSignatureFonts();
  const templates = listAppearanceTemplates();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
            <Dialog.Title className="text-sm font-semibold text-zinc-100">
              Create signature
            </Dialog.Title>
            <Dialog.Close className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="flex border-b border-zinc-700">
            {(
              [
                ['draw', PenLine, 'Draw'],
                ['upload', Upload, 'Upload'],
                ['typed', Type, 'Type'],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-medium transition-colors ${
                  tab === id
                    ? 'text-[#E8607A] border-b-2 border-[#E8607A] bg-zinc-800/40'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-zinc-300">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-200 outline-none focus:border-[#E8607A]"
              />
            </div>

            {tab === 'draw' && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <label className="text-[11px] text-zinc-400">Ink</label>
                  <input
                    type="color"
                    value={drawColor}
                    onChange={(e) => setDrawColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer"
                  />
                  <label className="text-[11px] text-zinc-400 ml-2">Width</label>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={0.5}
                    value={drawWidth}
                    onChange={(e) => setDrawWidth(Number(e.target.value))}
                    className="flex-1"
                  />
                  <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-zinc-300 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                    onClick={() => {
                      engineRef.current.clear();
                      redraw();
                    }}
                  >
                    <Eraser size={12} /> Clear
                  </button>
                </div>
                <canvas
                  ref={canvasRef}
                  width={520}
                  height={180}
                  className="w-full rounded-lg border border-zinc-700 bg-white touch-none cursor-crosshair"
                  style={{ touchAction: 'none' }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={onPointerUp}
                />
                <p className="text-[10px] text-zinc-500">
                  Draw with mouse, touch, or pen. Transparency is preserved on export.
                </p>
              </div>
            )}

            {tab === 'upload' && (
              <div className="space-y-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml"
                  className="hidden"
                  onChange={handleUpload}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full py-8 rounded-lg border border-dashed border-zinc-600 text-zinc-400 text-xs hover:border-[#E8607A] hover:text-[#E8607A] transition-colors"
                >
                  Click to upload PNG, JPG, or SVG
                </button>
                {uploadPreview && (
                  <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3 flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={uploadPreview}
                      alt="Upload preview"
                      className="max-h-32 object-contain"
                    />
                  </div>
                )}
              </div>
            )}

            {tab === 'typed' && (
              <div className="space-y-3">
                <input
                  value={typedText}
                  onChange={(e) => setTypedText(e.target.value)}
                  placeholder="Type your name"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-200 outline-none focus:border-[#E8607A]"
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">Font</label>
                    <select
                      value={typedFont}
                      onChange={(e) => setTypedFont(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200"
                    >
                      {fonts.map((f) => (
                        <option key={f} value={f}>
                          {f.split(',')[0]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">Size</label>
                    <input
                      type="range"
                      min={24}
                      max={72}
                      value={typedSize}
                      onChange={(e) => setTypedSize(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-zinc-400">Color</label>
                  <input
                    type="color"
                    value={typedColor}
                    onChange={(e) => setTypedColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer"
                  />
                </div>
                <div
                  className="rounded-lg border border-zinc-700 bg-white px-4 py-6 text-center"
                  style={{
                    fontFamily: typedFont,
                    fontSize: typedSize * 0.55,
                    color: typedColor,
                  }}
                >
                  {typedText.trim() || 'Your name'}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-zinc-300">Appearance template</label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-200"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.description}
                  </option>
                ))}
              </select>
            </div>

            {error && <p className="text-[11px] text-red-400">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
            <Dialog.Close className="px-3 py-1.5 text-xs text-zinc-300 rounded hover:bg-zinc-800">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void handleSave()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#E8607A] rounded hover:bg-[#D94D6A]"
            >
              <Check size={14} /> Save to library
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
