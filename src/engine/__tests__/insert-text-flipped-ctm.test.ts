/**
 * Firefox/cairo pages open with a top-level flip `cm`. Text added afterwards must
 * still land at the requested PDF position, upright.
 */
import { describe, it, expect } from 'vitest';
import { insertTextRun } from '../editor/text-editor';
import { interpretPage } from '../content/interpreter';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFArray, type PDFPageInfo, type PDFObject } from '../types';

describe('insertTextRun on a flipped-CTM page', () => {
  it('lands at the requested position, upright', () => {
    const original = new TextEncoder().encode('1 0 0 -1 0 842 cm\nq\n1 1 1 rg 18 18 560 806 re f\nQ\n');
    const pageDict = new PDFDict();
    const resources = new PDFDict();
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(596), new PDFNumber(842)]));
    const page: PDFPageInfo = {
      index: 0, dict: pageDict, mediaBox: { x: 0, y: 0, width: 596, height: 842 }, cropBox: { x: 0, y: 0, width: 596, height: 842 },
      rotate: 0, ref: new PDFRef(1, 0), resources, contentRefs: [new PDFRef(2, 0)],
    };
    const objects = new Map<string, PDFObject>(); objects.set('1 0', pageDict);
    const out = insertTextRun(original, page, objects, 'HELLO', 300, 62, 12, [0, 0, 0]);
    const run = interpretPage(out, page, objects).textRuns.find((r) => r.text === 'HELLO')!;
    expect(run).toBeTruthy();
    expect(Math.abs(run.x - 300)).toBeLessThan(0.5);
    expect(Math.abs(run.y - 62)).toBeLessThan(0.5);
    const g = run.glyphs[0].tRm;
    expect(g.d).toBeGreaterThan(0); // not mirrored
  });
});
