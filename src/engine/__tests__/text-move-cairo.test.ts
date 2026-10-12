/**
 * Moving a text run on cairo/Firefox-style pages: a flipped CTM, font size
 * folded into the text matrix (`9 0 0 -9 x y Tm`, `/F 1 Tf`) and relative `Td`
 * chains. Deltas are page-space and must be converted before touching Tm/Td,
 * and later runs in a Td chain must not drift.
 */
import { describe, it, expect } from 'vitest';
import { applyRunPositionShifts } from '../editor/text-editor';
import { interpretPage, type TextRun } from '../content/interpreter';
import {
  PDFDict, PDFName, PDFNumber, PDFRef, PDFArray,
  type PDFPageInfo, type PDFObject,
} from '../types';

function setup(content: string) {
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
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(595), new PDFNumber(842),
  ]));
  const page: PDFPageInfo = {
    index: 0, dict: pageDict,
    mediaBox: { x: 0, y: 0, width: 595, height: 842 },
    cropBox: { x: 0, y: 0, width: 595, height: 842 },
    rotate: 0, ref: new PDFRef(1, 0), resources, contentRefs: [new PDFRef(2, 0)],
  };
  const objects = new Map<string, PDFObject>();
  objects.set('1 0', pageDict);
  return { bytes, page, objects };
}

const CAIRO =
  '1 0 0 -1 0 842 cm\n' +
  'BT\n' +
  '11 0 0 -11 35 297 Tm\n/F1 1 Tf\n(S/N) Tj\n' +
  '9 0 0 -9 94.5 296.8 Tm\n/F1 1 Tf\n(ITEM) Tj\n' +
  '15.69 0 Td\n(DESCRIPTION) Tj\n' +
  '18.63 0 Td\n(QTY) Tj\n' +
  'ET\n';

const byText = (runs: TextRun[], t: string) => runs.find((r) => r.text.includes(t))!;

describe('applyRunPositionShifts: cairo/Firefox text matrix', () => {
  for (const [name, target] of [['Tm-positioned run', 'ITEM'], ['Td-positioned run', 'DESCRIPTION']] as const) {
    it(`moves only the ${name} by exactly the page-space delta`, () => {
      const { bytes, page, objects } = setup(CAIRO);
      const before = interpretPage(bytes, page, objects).textRuns;
      const run = byText(before, target);

      const out = applyRunPositionShifts(bytes, [{ run, dx: 10, dy: 5 }]);
      const after = interpretPage(out, page, objects).textRuns;

      for (const r of before) {
        const a = byText(after, r.text.trim());
        const expectMoved = r.text.includes(target);
        expect(a.x).toBeCloseTo(r.x + (expectMoved ? 10 : 0), 1);
        expect(a.y).toBeCloseTo(r.y + (expectMoved ? 5 : 0), 1);
      }
    });
  }
});
