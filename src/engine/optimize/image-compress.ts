/**
 * Smart PDF compression.
 *
 * Strategy (smallest current-state candidate wins):
 *   1. Lossless optimize (GC + dedup + re-serialize)
 *   2. Recompress embedded Image XObjects (JPEG + DPI downsample)
 *   3. Rasterize pages → JPEG rebuild — ONLY when it beats the best
 *      candidate so far (helps scanned / image-heavy PDFs; hurts tiny
 *      text PDFs — which is why we gate it)
 *
 * Target size uses binary search on quality for steps 2/3, then returns
 * the smallest candidate that is ≤ target, or the best effort that is
 * no larger than the serialized current-state baseline (or the upload when
 * the caller explicitly proves it is still current).
 */

import { PDFDocument } from 'pdf-lib';
import {
  PDFName,
  PDFNumber,
  PDFStream,
  type PDFDocumentData,
  type PDFObject,
} from '../types';
import { decodeImage } from '../render/image-decoder';
import { renderPage } from '../render/renderer';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { saveOptimized } from '../writer/save-pipeline';
import { garbageCollect, rootsFromTrailer } from './garbage-collect';
import { recompressStreams } from './stream-recompress';
import { subsetFonts } from './font-subsetter';

export interface ImageCompressOptions {
  /** null preserves image streams; DPI and target size are not applied in this mode. */
  quality: number | null;
  /** null disables downsampling and page rasterization. */
  dpi: number | null;
  targetBytes?: number;
  /** Permit upload-byte fallback only when the upload still represents every edit. Defaults to false. */
  originalIsCurrent?: boolean;
  onProgress?: (current: number, total: number, phase: string) => void;
}

export interface ImageCompressResult {
  bytes: Uint8Array;
  imagesTouched: number;
  finalQuality: number;
  originalBytes: number;
  compressedBytes: number;
  /** True when target was set but could not be met from the current document. */
  targetMissed: boolean;
  method: 'optimized' | 'images' | 'raster' | 'unchanged';
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isImageStream(obj: PDFObject): obj is PDFStream {
  return obj instanceof PDFStream && obj.dict.getName('Subtype') === 'Image';
}

function countImages(doc: PDFDocumentData): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const [, obj] of doc.objects) {
    if (!isImageStream(obj)) continue;
    const w = obj.dict.getNumber('Width') ?? 0;
    const h = obj.dict.getNumber('Height') ?? 0;
    if (w < 8 || h < 8) continue;
    if (obj.dict.getBool('ImageMask')) continue;
    count++;
    bytes += obj.rawBytes?.length ?? 0;
  }
  return { count, bytes };
}

async function serializeOptimizedCopy(doc: PDFDocumentData): Promise<Uint8Array> {
  try {
    const roots = rootsFromTrailer(doc.xref.trailerDict);
    const gc = garbageCollect(doc.objects, roots, { deduplicateStreams: true });
    const saved = new Map(doc.objects);
    doc.objects.clear();
    for (const [k, v] of gc.objects) doc.objects.set(k, v);
    try {
      // Flate recompression: re-encode all non-image streams at max compression
      try {
        await recompressStreams(doc.objects);
      } catch {
        // Non-critical — continue without recompression
      }

      // Font subsetting: zero out unused glyph outlines
      try {
        await subsetFonts(doc);
      } catch {
        // Non-critical — continue without subsetting
      }

      // Use compact serializer (ObjStm + xref stream) for maximum compression
      return await serializeDocumentCompact(doc);
    } finally {
      doc.objects.clear();
      for (const [k, v] of saved) doc.objects.set(k, v);
    }
  } catch {
    return serializeDocument(doc);
  }
}

async function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array> {
  const q = Math.min(0.95, Math.max(0.05, quality));
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))),
      'image/jpeg',
      q,
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function rgbaToJpegBytes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  quality: number,
  scale: number,
): Promise<Uint8Array | null> {
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);

  const src = document.createElement('canvas');
  src.width = width;
  src.height = height;
  const srcCtx = src.getContext('2d');
  if (!srcCtx) return Promise.resolve(null);

  srcCtx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, outW, outH);

  return canvasToJpeg(canvas, quality);
}

function scaleForDpi(targetDpi: number, referenceDpi = 300): number {
  if (targetDpi <= 0) return 1;
  return Math.min(1, targetDpi / referenceDpi);
}

interface ImageSnapshot {
  stream: PDFStream;
  rawBytes: Uint8Array;
  decodedBytes: Uint8Array | null;
  dictEntries: Map<string, PDFObject>;
}

function snapshotImages(doc: PDFDocumentData): ImageSnapshot[] {
  const snaps: ImageSnapshot[] = [];
  for (const [, obj] of doc.objects) {
    if (!isImageStream(obj)) continue;
    const dictEntries = new Map<string, PDFObject>();
    for (const [k, v] of obj.dict.entries()) dictEntries.set(k, v);
    snaps.push({
      stream: obj,
      rawBytes: obj.rawBytes.slice(),
      decodedBytes: obj.decodedBytes ? obj.decodedBytes.slice() : null,
      dictEntries,
    });
  }
  return snaps;
}

function restoreImages(snaps: ImageSnapshot[]): void {
  for (const snap of snaps) {
    for (const k of [...snap.stream.dict.keys()]) snap.stream.dict.delete(k);
    for (const [k, v] of snap.dictEntries) snap.stream.dict.set(k, v);
    snap.stream.rawBytes = snap.rawBytes.slice();
    snap.stream.decodedBytes = snap.decodedBytes ? snap.decodedBytes.slice() : null;
  }
}

async function recompressEmbeddedImages(
  doc: PDFDocumentData,
  quality: number,
  dpi: number,
): Promise<number> {
  const scale = scaleForDpi(dpi);
  let touched = 0;

  for (const [, obj] of doc.objects) {
    if (!isImageStream(obj)) continue;
    const w = obj.dict.getNumber('Width') ?? 0;
    const h = obj.dict.getNumber('Height') ?? 0;
    if (w < 8 || h < 8) continue;
    if (obj.dict.getBool('ImageMask')) continue;

    try {
      const decoded = await decodeImage(obj, doc.objects);
      if (!decoded || decoded.width < 8 || decoded.height < 8) continue;

      const jpeg = await rgbaToJpegBytes(
        decoded.data,
        decoded.width,
        decoded.height,
        quality,
        scale,
      );
      if (!jpeg || jpeg.length === 0) continue;
      // Skip if recompress would grow this image
      if (jpeg.length >= (obj.rawBytes?.length ?? 0) && scale >= 0.99) continue;

      const outW = Math.max(1, Math.round(decoded.width * scale));
      const outH = Math.max(1, Math.round(decoded.height * scale));
      obj.dict.set('Width', new PDFNumber(outW));
      obj.dict.set('Height', new PDFNumber(outH));
      obj.dict.set('ColorSpace', new PDFName('DeviceRGB'));
      obj.dict.set('BitsPerComponent', new PDFNumber(8));
      obj.dict.set('Filter', new PDFName('DCTDecode'));
      obj.dict.set('Length', new PDFNumber(jpeg.length));
      obj.dict.delete('DecodeParms');
      obj.dict.delete('SMask');
      obj.dict.delete('Mask');
      obj.dict.delete('ImageMask');
      obj.rawBytes = jpeg;
      obj.decodedBytes = null;
      touched++;
    } catch {
      // skip
    }
  }
  return touched;
}

async function rebuildFromJpegs(
  doc: PDFDocumentData,
  quality: number,
  dpi: number,
  onProgress?: ImageCompressOptions['onProgress'],
): Promise<{ bytes: Uint8Array; pages: number }> {
  // Cap DPI for rebuild — tiny DPI still produces huge JPEGs vs text PDFs
  const effectiveDpi = Math.min(dpi, 150);
  const scale = Math.max(0.35, effectiveDpi / 72);
  const out = await PDFDocument.create();
  const pageCount = doc.pages.length;

  for (let i = 0; i < pageCount; i++) {
    onProgress?.(i + 1, pageCount, 'rasterizing');
    const page = doc.pages[i];
    const { mediaBox, rotate } = page;
    const isRotated = rotate === 90 || rotate === 270;
    const pageWidthPt = isRotated ? mediaBox.height : mediaBox.width;
    const pageHeightPt = isRotated ? mediaBox.width : mediaBox.height;

    const result = await renderPage(doc, i, { scale, devicePixelRatio: 1 });
    const jpegBytes = await canvasToJpeg(result.canvas, quality);
    const embedded = await out.embedJpg(jpegBytes);
    const newPage = out.addPage([pageWidthPt, pageHeightPt]);
    newPage.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt,
    });
  }

  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: pageCount };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function compressDocumentImages(
  doc: PDFDocumentData,
  options: ImageCompressOptions,
): Promise<ImageCompressResult> {
  if (options.quality === null) {
    const bytes = await saveOptimized(doc);
    return {
      bytes,
      imagesTouched: 0,
      finalQuality: 1,
      originalBytes: doc.rawBytes?.length || bytes.length,
      compressedBytes: bytes.length,
      targetMissed: options.targetBytes != null && bytes.length > options.targetBytes,
      method: 'optimized',
      message: 'Saved with original image quality (no image re-encoding or downsampling).',
    };
  }

  const dpi = options.dpi === null ? 0 : options.dpi > 0 ? options.dpi : 150;
  const quality = Math.min(0.95, Math.max(0.05, options.quality));
  const target = options.targetBytes;

  // Upload size is normally only a reporting/rasterization metric.
  // Only an explicit caller guarantee makes these bytes a safe fallback.
  const originalBytes = doc.rawBytes?.length ?? 0;

  options.onProgress?.(0, 1, 'baseline');
  // Serialization failures must propagate rather than export stale upload bytes.
  let best = await serializeOptimizedCopy(doc);
  let method: ImageCompressResult['method'] = 'optimized';
  if (options.originalIsCurrent === true && originalBytes > 0 && doc.rawBytes.length <= best.length) {
    best = doc.rawBytes;
    method = 'unchanged';
  }

  let imagesTouched = 0;
  let finalQuality = 1;
  let targetMissed = false;

  const { count: imageCount, bytes: imageBytes } = countImages(doc);
  const imageHeavy =
    imageCount > 0 && (imageBytes > Math.max(originalBytes, 1) * 0.25 || imageCount >= 2);

  // Rasterize ONLY for larger / image-heavy docs. Tiny text PDFs always grow.
  const rasterCandidate =
    originalBytes >= 100 * 1024 && (imageHeavy || originalBytes >= 250 * 1024);

  // ── Embedded image recompression ──
  if (imageCount > 0) {
    const snaps = snapshotImages(doc);
    try {
      const qualities =
        target != null && target > 0
          ? [0.85, 0.65, 0.45, 0.25, 0.12]
          : [quality];

      for (const q of qualities) {
        restoreImages(snaps);
        options.onProgress?.(1, qualities.length, `images q=${q}`);
        const touched = await recompressEmbeddedImages(doc, q, dpi);
        if (touched === 0) continue;
        const bytes = await serializeOptimizedCopy(doc);
        if (bytes.length < best.length) {
          best = bytes;
          method = 'images';
          imagesTouched = touched;
          finalQuality = q;
        }
        if (target != null && bytes.length <= target) break;
      }
    } finally {
      restoreImages(snaps);
    }
  }

  // ── Rasterize only when it can win ──
  const stillNeedShrink =
    (target != null && best.length > target) ||
    (target == null && best.length > originalBytes * 0.9);

  if (options.dpi !== null && rasterCandidate && stillNeedShrink) {
    const qualities =
      target != null && target > 0
        ? [0.55, 0.35, 0.18, 0.08]
        : [quality];

    for (const q of qualities) {
      options.onProgress?.(1, qualities.length, `raster q=${q}`);
      try {
        const { bytes, pages } = await rebuildFromJpegs(doc, q, dpi, options.onProgress);
        if (bytes.length < best.length) {
          best = bytes;
          method = 'raster';
          imagesTouched = pages;
          finalQuality = q;
        }
        if (target != null && bytes.length <= target) break;
      } catch (err) {
        console.warn('[Compress] Raster pass failed:', err);
      }
    }
  }

  if (target != null && target > 0 && best.length > target) {
    targetMissed = true;
  }

  if (best.length >= originalBytes * 0.99) {
    method = method === 'images' || method === 'raster' ? method : 'unchanged';
  }

  let message: string;
  if (originalBytes > 0 && originalBytes < 32 * 1024 && imageCount === 0) {
    message =
      `This PDF is only ${formatBytes(originalBytes)} and has no images. ` +
      `Other tools (iLovePDF, Ghostscript, Acrobat) mainly shrink large image/scan PDFs — ` +
      `they cannot turn a tiny text file into ${target != null ? formatBytes(target) : 'a much smaller file'}. ` +
      `Best result: ${formatBytes(best.length)}.`;
  } else if (target != null && targetMissed) {
    message =
      `Could not reach ${formatBytes(target)} — best is ${formatBytes(best.length)} ` +
      `(original ${formatBytes(originalBytes)}).`;
  } else if (method === 'unchanged') {
    message = `Already as small as we can get (${formatBytes(best.length)}).`;
  } else {
    message = `Compressed ${formatBytes(originalBytes)} → ${formatBytes(best.length)} (${method}).`;
  }

  return {
    bytes: best,
    imagesTouched,
    finalQuality,
    originalBytes: originalBytes || best.length,
    compressedBytes: best.length,
    targetMissed,
    method,
    message,
  };
}
