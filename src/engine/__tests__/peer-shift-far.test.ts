/**
 * A left block and a right block that merely share a baseline (address vs
 * "DATE : ..." header) are independent: editing the left one must not push the
 * right one unless the grown text would actually run into it.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentFlow } from '../flow/index';
import { applyLineTextEdit } from '../flow/flow-editor';
import { interpretPage } from '../content/interpreter';
import {
  PDFDict, PDFName, PDFNumber, PDFRef, PDFArray,
  type PDFPageInfo, type PDFObject,
} from '../types';

function setup() {
  const content =
    'BT\n/F1 9 Tf\n1 0 0 1 44 700 Tm\n(135 JOO SENG ROAD) Tj\nET\n' +
    'BT\n/F1 9 Tf\n1 0 0 1 330 700 Tm\n(DATE : 28/09/2026) Tj\nET\n';
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

describe('same-baseline peers in a different block', () => {
  it('stay put when the edited line grows without reaching them', () => {
    const { bytes, page, objects } = setup();
    const before = interpretPage(bytes, page, objects);
    const flow = buildDocumentFlow(before.textRuns);
    const line = flow.lines.find((l) => l.text.includes('JOO'))!;
    const dateBefore = before.textRuns.find((r) => r.text.includes('DATE'))!;
    const out = applyLineTextEdit(bytes, page, objects, line, line.text + 'X', flow, { oldText: line.text });
    const after = interpretPage(out.newContentBytes, page, objects);
    const dateAfter = after.textRuns.find((r) => r.text.includes('DATE'))!;
    expect(dateAfter.x).toBeCloseTo(dateBefore.x, 1);
  });
});
