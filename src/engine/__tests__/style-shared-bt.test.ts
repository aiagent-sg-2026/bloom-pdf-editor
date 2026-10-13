/**
 * Cairo/Firefox put many lines in ONE BT sharing a single Tf/Tm. Styling one line
 * (size / bold) must not restyle the lines after it.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentFlow } from '../flow/index';
import { applyStyleToSelection } from '../flow/style-edit';
import { interpretPage } from '../content/interpreter';
import {
  PDFDict, PDFName, PDFNumber, PDFRef, PDFArray,
  type PDFPageInfo, type PDFObject,
} from '../types';

function makePage(content: string) {
  const bytes = new TextEncoder().encode(content);
  const fontDict = new PDFDict();
  const helv = new PDFDict();
  helv.set('Type', new PDFName('Font'));
  helv.set('Subtype', new PDFName('Type1'));
  helv.set('BaseFont', new PDFName('Helvetica'));
  fontDict.set('F1', helv);
  const resources = new PDFDict();
  resources.set('Font', fontDict);
  const pageDict = new PDFDict();
  pageDict.set('Resources', resources);
  pageDict.set('MediaBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792)]));
  const page: PDFPageInfo = {
    index: 0, dict: pageDict,
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    rotate: 0, ref: new PDFRef(1, 0), resources, contentRefs: [new PDFRef(2, 0)],
  };
  const objects = new Map<string, PDFObject>();
  objects.set('1 0', pageDict);
  return { bytes, page, objects };
}

describe('style on one line of a shared BT', () => {
  const content =
    'BT\n10 0 0 -10 50 100 Tm\n/F1 1 Tf\n[(AAAA)] TJ\n0 -1.5 Td\n[(BBBB)] TJ\n0 -1.5 Td\n[(CCCC)] TJ\nET\n';
  const setup = () => {
    const { bytes, page, objects } = makePage(content);
    const flow = buildDocumentFlow(interpretPage(bytes, page, objects).textRuns);
    const line = flow.lines.find((l) => l.text === 'BBBB')!;
    return { bytes, page, objects, line };
  };
  const posOf = (bytes: Uint8Array, page: PDFPageInfo, objects: Map<string, PDFObject>, t: string) =>
    interpretPage(bytes, page, objects).textRuns.find((r) => r.text === t)!;

  it('font size only affects that line', () => {
    const { bytes, page, objects, line } = setup();
    const res = applyStyleToSelection(bytes, page, objects, line, 0, 4, { fontSize: 20 });
    const a = posOf(res.newContentBytes, page, objects, 'AAAA');
    const b = posOf(res.newContentBytes, page, objects, 'BBBB');
    const c = posOf(res.newContentBytes, page, objects, 'CCCC');
    const a0 = posOf(bytes, page, objects, 'AAAA');
    const c0 = posOf(bytes, page, objects, 'CCCC');
    expect(Math.abs(a.fontSize - a0.fontSize)).toBeLessThan(0.1);
    expect(Math.abs(c.fontSize - c0.fontSize)).toBeLessThan(0.1);
    expect(Math.abs(c.y - c0.y)).toBeLessThan(0.1);
    expect(b.fontSize).toBeGreaterThan(a.fontSize * 1.5);
  });

  it('bold only affects that line', () => {
    const { bytes, page, objects, line } = setup();
    const res = applyStyleToSelection(bytes, page, objects, line, 0, 4, { bold: true });
    const text = new TextDecoder().decode(res.newContentBytes);
    const fonts = (t: string) => interpretPage(res.newContentBytes, page, objects).textRuns.find((r) => r.text === t)!.fontName;
    expect(fonts('AAAA')).toBe('F1');
    expect(fonts('CCCC')).toBe('F1');
    expect(fonts('BBBB')).not.toBe('F1');
    expect(text).toMatch(/Bold/);
  });

  it('colour only affects that line', () => {
    const { bytes, page, objects, line } = setup();
    const res = applyStyleToSelection(bytes, page, objects, line, 0, 4, { color: [1, 0, 0] });
    const runs = interpretPage(res.newContentBytes, page, objects).textRuns;
    const colorOf = (t: string) => runs.find((r) => r.text === t)!.fillColor ?? [0, 0, 0];
    expect(colorOf('AAAA')).toEqual([0, 0, 0]);
    expect(colorOf('CCCC')).toEqual([0, 0, 0]);
    expect(colorOf('BBBB')).toEqual([1, 0, 0]);
  });
});

describe('underline on a flipped-CTM page', () => {
  it('draws the stroke just below the text, not mirrored', () => {
    const content = '1 0 0 -1 0 792 cm\nBT\n10 0 0 -10 50 100 Tm\n/F1 1 Tf\n[(AAAA)] TJ\nET\n';
    const { bytes, page, objects } = makePage(content);
    const flow = buildDocumentFlow(interpretPage(bytes, page, objects).textRuns);
    const line = flow.lines[0];
    const res = applyStyleToSelection(bytes, page, objects, line, 0, 4, { underline: true });
    const text = new TextDecoder().decode(res.newContentBytes);
    const m = text.match(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l/);
    expect(m).toBeTruthy();
    const uy = Number(m![2]);
    expect(uy).toBeGreaterThan(100);
    expect(uy).toBeLessThan(103);
    expect(Math.abs(Number(m![1]) - 50)).toBeLessThan(1);
  });
});

describe('remove underline on a flipped-CTM page', () => {
  it('removes a path underline drawn in flipped user space', () => {
    const content =
      '1 0 0 -1 0 792 cm\n0 0 0 RG q 1 0 0 1 0 0 cm\n50 101.2 m 90 101.2 l S Q\nBT\n10 0 0 -10 50 100 Tm\n/F1 1 Tf\n[(AAAA)] TJ\nET\n';
    const { bytes, page, objects } = makePage(content);
    const flow = buildDocumentFlow(interpretPage(bytes, page, objects).textRuns);
    const res = applyStyleToSelection(bytes, page, objects, flow.lines[0], 0, 4, { underline: false });
    const text = new TextDecoder().decode(res.newContentBytes);
    expect(text).not.toMatch(/ l\s+S/);
  });
});

describe('moving text carries its path underline', () => {
  it('shifts the stroke by the same delta, once', async () => {
    const { moveUnderlinesWithRuns } = await import('../flow/style-edit');
    const content =
      '1 0 0 -1 0 792 cm\n0 0 0 RG q 1 0 0 1 0 0 cm\n50 101.2 m 90 101.2 l S Q\n0 0 0 RG q 1 0 0 1 0 0 cm\n50 101.2 m 90 101.2 l S Q\nBT\n10 0 0 -10 50 100 Tm\n/F1 1 Tf\n[(AAAA)] TJ\nET\n';
    const { bytes, page, objects } = makePage(content);
    const flow = buildDocumentFlow(interpretPage(bytes, page, objects).textRuns);
    const out = moveUnderlinesWithRuns(bytes, flow.lines[0].runs, 7, 5); // page space: +7 right, +5 up
    const text = new TextDecoder().decode(out);
    const ms = [...text.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l/g)];
    expect(ms.length).toBe(2);
    for (const m of ms) {
      expect(Math.abs(Number(m[1]) - 57)).toBeLessThan(0.01);
      expect(Math.abs(Number(m[2]) - 96.2)).toBeLessThan(0.01); // flipped: up = smaller user y
      expect(Math.abs(Number(m[3]) - 97)).toBeLessThan(0.01);
    }
  });
});
