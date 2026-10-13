import { describe, expect, it } from 'vitest';
import { explodeTJGaps } from '../content/tj-normalizer';
import { interpretPage } from '../content/interpreter';
import { buildDocumentFlow } from '../flow/index';
import { applyLineTextEdit } from '../flow/flow-editor';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, type PDFPageInfo,
} from '../types';

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
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0,
  };
  return { bytes: new TextEncoder().encode(content), page, objects: new Map<string, PDFObject>() };
}

const content =
  '1 0 0 -1 0 842 cm\nBT /F1 10 Tf 1 0 0 1 28 82 Tm\n' +
  '[(D-04) -350 (Delta) -2400 (1) -1350 (UNIT)] TJ\nET\n';

function glyphX(runs: ReturnType<typeof interpretPage>['textRuns'], text: string): number {
  for (const run of runs) {
    const index = run.text.indexOf(text);
    if (index >= 0) return run.glyphs[index].tRm.e;
  }
  return NaN;
}

function editLine(newText: string) {
  const f = fixture(content);
  const normalized = explodeTJGaps(f.bytes, f.page, f.objects);
  const before = interpretPage(normalized, f.page, f.objects);
  const flow = buildDocumentFlow(before.textRuns);
  const line = flow.lines.find(l => l.text.includes('Delta'))!;
  const edited = applyLineTextEdit(normalized, f.page, f.objects, line, newText, flow, {
    oldText: line.text,
  });
  return { before, after: interpretPage(edited.newContentBytes, f.page, f.objects) };
}

describe('TJ word-space adjustments', () => {
  it('keeps a modest TJ word gap when appending to the line', () => {
    const { before, after } = editLine('D-04Deltax');
    const beforeD = glyphX(before.textRuns, 'D-04');
    const afterD = glyphX(after.textRuns, 'D-04');
    const beforeDelta = glyphX(before.textRuns, 'Delta');
    const afterDelta = glyphX(after.textRuns, 'Delta');
    const beforeEnd = before.textRuns.find(r => r.text.includes('D-04'))!.glyphs[3];
    const afterEnd = after.textRuns.find(r => r.text.includes('D-04'))!.glyphs[3];
    expect(beforeD).toBeCloseTo(afterD, 2);
    expect(beforeDelta).toBeCloseTo(afterDelta, 2);
    expect(afterDelta - (afterEnd.tRm.e + afterEnd.width)).toBeCloseTo(3.5, 1);
    expect(after.textRuns.find(r => r.text === '1')!.x).toBeCloseTo(before.textRuns.find(r => r.text === '1')!.x, 2);
    expect(after.textRuns.find(r => r.text === 'UNIT')!.x).toBeCloseTo(before.textRuns.find(r => r.text === 'UNIT')!.x, 2);
  });

  it('keeps the gap when editing inside the first word', () => {
    const { before, after } = editLine('D-05Delta');
    const afterDelta = glyphX(after.textRuns, 'Delta');
    const afterEnd = after.textRuns.find(r => r.text.includes('D-05'))!.glyphs[3];
    expect(afterDelta - (afterEnd.tRm.e + afterEnd.width)).toBeCloseTo(3.5, 1);
    expect(after.textRuns.find(r => r.text === '1')!.x).toBeCloseTo(before.textRuns.find(r => r.text === '1')!.x, 2);
    expect(after.textRuns.find(r => r.text === 'UNIT')!.x).toBeCloseTo(before.textRuns.find(r => r.text === 'UNIT')!.x, 2);
  });
});
