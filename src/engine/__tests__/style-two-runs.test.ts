/**
 * A title made of two separate BT blocks (different colour) must have BOTH runs
 * resized when a whole-line font size is applied.
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

describe('whole-line font size over two BT blocks', () => {
  it('resizes both runs', () => {
    const content =
      '0 0 1 rg BT\n14 0 0 14 34 500 Tm\n/F1 1 Tf\n[(PROJECT:)] TJ\nET\n' +
      '0 0 0 rg BT\n14 0 0 14 103.2 500 Tm\n/F1 1 Tf\n[( 30 SCIENCE PARK)] TJ\nET\n';
    const { bytes, page, objects } = makePage(content);
    const before = interpretPage(bytes, page, objects);
    const flow = buildDocumentFlow(before.textRuns);
    expect(flow.lines.length).toBe(1);
    const line = flow.lines[0];
    const res = applyStyleToSelection(bytes, page, objects, line, 0, line.text.length, { fontSize: 30 });
    const after = interpretPage(res.newContentBytes, page, objects);
    const text = new TextDecoder().decode(res.newContentBytes);
    const tms = [...text.matchAll(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) [\d.]+ Tm/g)].map((m) => [Number(m[1]), Number(m[3])]);
    console.log('tms', JSON.stringify(tms));
    expect(tms.length).toBe(2);
    expect(tms.every(([sz]) => Math.abs(sz - 30) < 0.6)).toBe(true);
    // second block must not sit on top of the (now larger) first one
    expect(after.textRuns.length).toBe(2);
    const first = after.textRuns[0];
    expect(after.textRuns[1].x).toBeGreaterThanOrEqual(first.x + first.width - 1);
  });
});
