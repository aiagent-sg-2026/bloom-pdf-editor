import { describe, expect, it } from 'vitest';
import { explodeTJGaps } from '../content/tj-normalizer';
import { interpretPage } from '../content/interpreter';
import { buildDocumentFlow } from '../flow/index';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, type PDFPageInfo } from '../types';

function fixture(content: string) {
  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  const fonts = new PDFDict(); fonts.set('F1', font);
  const resources = new PDFDict(); resources.set('Font', fonts);
  const dict = new PDFDict();
  dict.set('Resources', resources);
  dict.set('MediaBox', new PDFArray([0, 0, 612, 792].map(n => new PDFNumber(n))));
  const page: PDFPageInfo = {
    index: 0, dict, resources, ref: new PDFRef(1, 0), contentRefs: [new PDFRef(2, 0)],
    mediaBox: { x: 0, y: 0, width: 612, height: 792 }, cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0,
  };
  return { bytes: new TextEncoder().encode(content), page, objects: new Map<string, PDFObject>() };
}

describe('explodeTJGaps', () => {
  it('preserves glyph order and positions while splitting gutter cells', () => {
    const f = fixture('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(DESC)-3000(UNIT)-3000(PRICE)] TJ\nET\n');
    const before = interpretPage(f.bytes, f.page, f.objects);
    const normalized = explodeTJGaps(f.bytes, f.page, f.objects);
    const after = interpretPage(normalized, f.page, f.objects);
    expect(after.textRuns.map(r => r.text).join('')).toBe(before.textRuns.map(r => r.text).join(''));
    expect(after.textRuns.length).toBe(3);
    const bg = before.textRuns.flatMap(r => r.glyphs);
    const ag = after.textRuns.flatMap(r => r.glyphs);
    expect(ag.map(g => [g.tRm.e, g.tRm.f])).toEqual(bg.map(g => [expect.closeTo(g.tRm.e, 0.01), expect.closeTo(g.tRm.f, 0.01)]));
  });

  it('does not split kerning/word-spacing gaps and is idempotent', () => {
    const f = fixture('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(AV)-80(ATE) 400(NEXT)] TJ\nET\n');
    const once = explodeTJGaps(f.bytes, f.page, f.objects);
    expect(once).toBe(f.bytes);
    expect(explodeTJGaps(once, f.page, f.objects)).toBe(once);
  });

  it('keeps following shared-BT relative lines in place', () => {
    const f = fixture('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(A)-3000(B)] TJ\n0 -20 Td\n(C) Tj\nET\n');
    const before = interpretPage(f.bytes, f.page, f.objects).textRuns;
    const after = interpretPage(explodeTJGaps(f.bytes, f.page, f.objects), f.page, f.objects).textRuns;
    expect(after.find(r => r.text === 'C')!.y).toBeCloseTo(before.find(r => r.text === 'C')!.y, 2);
    expect(buildDocumentFlow(after).lines.length).toBeGreaterThanOrEqual(2);
  });
});
