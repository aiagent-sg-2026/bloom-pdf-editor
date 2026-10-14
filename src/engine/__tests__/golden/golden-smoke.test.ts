import { afterEach, describe, it, expect, vi } from 'vitest';
import { createCanvas } from 'canvas';
import { PDFDocument, rgb } from 'pdf-lib';
import { parsePDF } from '../../parser/parser';
import { renderPage } from '../../render/renderer';

/** Synthetic PDF with writer-generated stream lengths and cross references. */
async function minimalPdfBytes() {
  const source = await PDFDocument.create();
  const page = source.addPage([200, 200]);
  page.drawText('Hello', { x: 50, y: 100, size: 12 });
  page.drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: rgb(0, 0, 0) });
  return source.save({ useObjectStreams: false });
}

afterEach(() => vi.unstubAllGlobals());

describe('golden smoke', () => {
  it('parses and renders synthetic text and a black rectangle', async () => {
    // Use the existing native canvas dependency, not a no-op Canvas mock.
    // Only element creation/style need an adapter in Vitest's Node environment.
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`);
        return Object.assign(createCanvas(1, 1), { style: {} });
      },
    });
    const doc = await parsePDF(await minimalPdfBytes());
    expect(doc.pages).toHaveLength(1);
    const result = await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(result.canvas.width).toBe(200);
    expect(result.canvas.height).toBe(200);
    expect(result.textRuns.map(run => run.text).join('')).toBe('Hello');
    const ctx = result.canvas.getContext('2d')!;
    expect(Array.from(ctx.getImageData(15, 185, 1, 1).data)).toEqual([0, 0, 0, 255]);
    expect(Array.from(ctx.getImageData(190, 10, 1, 1).data)).toEqual([255, 255, 255, 255]);
  });
});
