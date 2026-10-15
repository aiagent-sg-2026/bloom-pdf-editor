import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData } from 'canvas';
import { deflateSync } from 'node:zlib';
import { DEFAULT_DOWNLOAD_OPTIONS } from '../../app/editor/components/downloadQualityOptions';
import { compressDocumentImages } from '../optimize/image-compress';
import { getResource, parsePDF } from '../parser/parser';
import { PDFStream } from '../types';
import type { PDFDocumentData } from '../types';
import { saveOptimized } from '../writer/save-pipeline';
import { rawPDF, tinyJPEG } from './audit-p1-fixtures';

function fixture(): Uint8Array {
  const pixels = Buffer.alloc(64 * 64 * 3);
  let seed = 123;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const flate = deflateSync(pixels, { level: 0 });
  const jpeg = tinyJPEG();
  const content = 'q 64 0 0 64 0 0 cm /Flate Do Q q 1 0 0 1 70 0 cm /Jpeg Do Q';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Flate 5 0 R /Jpeg 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >>\nstream\n${flate.toString('latin1')}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${Buffer.from(jpeg).toString('latin1')}\nendstream`,
  ]);
}

function image(doc: PDFDocumentData, name: string): PDFStream {
  const stream = getResource(doc.pages[0].resources, 'XObject', name, doc.objects);
  if (!(stream instanceof PDFStream)) throw new Error(`Missing image ${name}`);
  return stream;
}

// Use the real JPEG encoder already supplied by fabric's Node canvas dependency.
function installCanvas(): void {
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('document', {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`Unexpected element ${tag}`);
      const canvas = createCanvas(1, 1);
      return Object.assign(canvas, {
        toBlob(callback: BlobCallback, _mime: string, quality: number) {
          const jpeg = canvas.toBuffer('image/jpeg', { quality });
          callback(new Blob([new Uint8Array(jpeg)]));
        },
      });
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('download image quality', () => {
  it.each([null, 150])('preserves Flate and DCT bytes with Original compression and dpi=%s', async dpi => {
    installCanvas();
    const input = fixture();
    const original = await parsePDF(input);
    const result = await compressDocumentImages(await parsePDF(input), {
      ...DEFAULT_DOWNLOAD_OPTIONS, dpi,
    });
    const reopened = await parsePDF(result.bytes);
    for (const name of ['Flate', 'Jpeg']) {
      expect(image(reopened, name).rawBytes).toEqual(image(original, name).rawBytes);
      expect(image(reopened, name).getFilters()).toEqual(image(original, name).getFilters());
    }
    expect(result.imagesTouched).toBe(0);
    expect(result.bytes).toEqual(await saveOptimized(await parsePDF(input)));
  });

  it.each([
    { dpi: null, width: 64 },
    { dpi: 150, width: 32 },
  ])('re-encodes at custom quality with dpi=$dpi, retaining the selected resolution', async ({ dpi, width }) => {
    installCanvas();
    const input = fixture();
    const original = await parsePDF(input);
    const result = await compressDocumentImages(original, { quality: 0.25, dpi });
    const reopened = await parsePDF(result.bytes);
    expect(image(reopened, 'Flate').rawBytes).not.toEqual(image(original, 'Flate').rawBytes);
    expect(image(reopened, 'Flate').getFilters()).toEqual(['DCTDecode']);
    expect(image(reopened, 'Flate').dict.getNumber('Width')).toBe(width);
    expect(image(reopened, 'Flate').dict.getNumber('Height')).toBe(width);
    // Compression candidates must not degrade the live editor document.
    expect(image(original, 'Flate').getFilters()).toEqual(['FlateDecode']);
    expect(image(original, 'Flate').dict.getNumber('Width')).toBe(64);
  });
});
