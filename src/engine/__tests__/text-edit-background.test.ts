import { describe, expect, it, vi } from 'vitest';
import { parseContentStream } from '../content/operator-lexer';
import { interpretPage } from '../content/interpreter';
import { applyTextEdits, findAndReplace } from '../editor/text-editor';
import { buildDocumentFlow } from '../flow/index';
import { applyLineTextEdit } from '../flow/flow-editor';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject, type PDFPageInfo } from '../types';

interface TextPageFixture {
  page: PDFPageInfo;
  objects: Map<string, PDFObject>;
  bytes: Uint8Array;
}

function fixture(showing: string): TextPageFixture {
  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  const fonts = new PDFDict();
  fonts.set('F1', font);
  const resources = new PDFDict();
  resources.set('Font', fonts);
  const dict = new PDFDict();
  dict.set('Resources', resources);
  const page: PDFPageInfo = {
    index: 0, dict, ref: new PDFRef(1, 0), resources, contentRefs: [], rotate: 0,
    mediaBox: { x: 0, y: 0, width: 200, height: 100 },
    cropBox: { x: 0, y: 0, width: 200, height: 100 },
  };
  const objects = new Map<string, PDFObject>([['1 0', dict]]);
  const bytes = new TextEncoder().encode(
    `1 0 0 rg 0 0 100 20 re f\n0 0 0 rg\nBT /F1 10 Tf 1 0 0 1 5 5 Tm\n${showing}\nET\n`,
  );
  return { page, objects, bytes };
}

function showingText(bytes: Uint8Array): string {
  const text = (obj: PDFObject): string => {
    if (obj instanceof PDFString) return obj.value;
    if (obj instanceof PDFArray) return obj.items.map(text).join('');
    return '';
  };
  return parseContentStream(bytes)
    .filter(inst => inst.operator === 'Tj' || inst.operator === 'TJ')
    .map(inst => inst.operands.map(text).join('')).join('');
}

const whiteFill = /1\s+1\s+1\s+rg\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+re\s+f\b/g;

function expectBackgroundUnchanged(original: Uint8Array, edited: Uint8Array) {
  expect(parseContentStream(edited).slice(0, 3)).toEqual(parseContentStream(original).slice(0, 3));
  expect(new TextDecoder().decode(edited)).toMatch(/^1 0 0 rg\n0 0 100 20 re\nf\n/);
}

function expectCompleteRewrite(f: TextPageFixture, edited: Uint8Array, oldText: string, newText: string) {
  expect(new TextDecoder().decode(edited).match(whiteFill)).toBeNull();
  expectBackgroundUnchanged(f.bytes, edited);
  expect(showingText(edited)).not.toContain(oldText);
  expect(showingText(edited)).toBe(newText);
  expect(interpretPage(edited, f.page, f.objects).textRuns.map(run => run.text).join('')).toBe(newText);
}

describe('text edits preserve coloured backgrounds', () => {
  it.each([
    ['shorter', 'New'],
    ['longer with spaces', 'Brand New Label'],
    ['same length', 'Changed!'],
    ['deleted', ''],
  ])('does not erase a fully rewritten %s run', (_case, newText) => {
    const f = fixture('(Original) Tj');
    const before = interpretPage(f.bytes, f.page, f.objects);
    const flow = buildDocumentFlow(before.textRuns);
    const line = flow.lines[0];
    const result = applyLineTextEdit(f.bytes, f.page, f.objects, line, newText, flow, { oldText: line.text });
    expectCompleteRewrite(f, result.newContentBytes, 'Original', newText);
  });

  it('rewrites grouped fragments in one BT and empties both Tj and TJ siblings without erasing', () => {
    const f = fixture('(Original) Tj (Suffix) Tj [(Tail)] TJ');
    const before = interpretPage(f.bytes, f.page, f.objects);
    expect(before.textRuns.map(run => run.text)).toEqual(['OriginalSuffixTail']);
    const flow = buildDocumentFlow(before.textRuns);
    const result = applyLineTextEdit(f.bytes, f.page, f.objects, flow.lines[0], 'New', flow);
    expectCompleteRewrite(f, result.newContentBytes, 'OriginalSuffixTail', 'New');
    const siblings = parseContentStream(result.newContentBytes)
      .filter(inst => inst.operator === 'Tj' || inst.operator === 'TJ');
    expect(siblings[1].operands).toEqual([new PDFString('')]);
    expect(siblings[2].operands).toEqual([new PDFArray([new PDFString('')])]);
  });

  it.each(['New', 'Replacement'])('rewrites TJ text to %s while retaining its column gap', replacement => {
    const f = fixture('[(Original) -3000 (Column)] TJ');
    const result = findAndReplace(f.bytes, f.page, f.objects, 'Original', replacement, true);
    expectCompleteRewrite(f, result.newContentBytes, 'Original', `${replacement}Column`);
    const tj = parseContentStream(result.newContentBytes).find(inst => inst.operator === 'TJ')!;
    const gap = (tj.operands[0] as PDFArray).items.find(item => item instanceof PDFNumber) as PDFNumber;
    expect(gap.value).toBeLessThanOrEqual(-200);
    const beforeColumn = interpretPage(f.bytes, f.page, f.objects).textRuns[0].glyphs[8];
    const afterColumn = interpretPage(result.newContentBytes, f.page, f.objects).textRuns[0].glyphs[replacement.length];
    expect(afterColumn.tRm.e).toBeCloseTo(beforeColumn.tRm.e, 2);
  });

  it.each(['missing', 'unmatched'])('does not erase when %s source indices are recovered by text matching', mode => {
    const f = fixture('(Original) Tj');
    const run = interpretPage(f.bytes, f.page, f.objects).textRuns[0];
    const targetRun = { ...run, sourceInstructionIndices: mode === 'missing' ? [] : [run.sourceInstructionIndices![0] - 1] };
    const result = applyTextEdits(f.bytes, f.page, f.objects, [{ targetRun, newText: 'New' }]);
    expectCompleteRewrite(f, result.newContentBytes, 'Original', 'New');
  });

  it('retains one erase when an unmatched grouped source leaves an old sibling in the stream', () => {
    const f = fixture('(Original) Tj [(Suffix)] TJ');
    const run = interpretPage(f.bytes, f.page, f.objects).textRuns[0];
    const first = run.sourceInstructionIndices![0];
    const targetRun = { ...run, sourceInstructionIndices: [first, first - 1] };
    const result = applyTextEdits(f.bytes, f.page, f.objects, [{ targetRun, newText: 'New' }]);
    expect(new TextDecoder().decode(result.newContentBytes).match(whiteFill)).toHaveLength(1);
    expectBackgroundUnchanged(f.bytes, result.newContentBytes);
    expect(showingText(result.newContentBytes)).toBe('NewSuffix');
  });

  it('keeps later complete edits aligned after an incomplete rewrite inserts an erase', () => {
    const f = fixture('(Original) Tj [(Suffix)] TJ ET BT /F1 10 Tf 1 0 0 1 5 35 Tm (Later) Tj');
    const runs = interpretPage(f.bytes, f.page, f.objects).textRuns;
    const first = runs[0].sourceInstructionIndices![0];
    const result = applyTextEdits(f.bytes, f.page, f.objects, [
      { targetRun: { ...runs[0], sourceInstructionIndices: [first, first - 1] }, newText: 'New' },
      { targetRun: runs[1], newText: 'Changed' },
    ]);
    expect(new TextDecoder().decode(result.newContentBytes).match(whiteFill)).toHaveLength(1);
    expectBackgroundUnchanged(f.bytes, result.newContentBytes);
    expect(showingText(result.newContentBytes)).toBe('NewSuffixChanged');
  });

  it('retains the legacy erase for an unmatched placement hint without claiming a rewrite', () => {
    const f = fixture('(Original) Tj');
    const run = interpretPage(f.bytes, f.page, f.objects).textRuns[0];
    const targetRun = { ...run, text: 'Unmatchable', fontName: 'MissingFont', sourceInstructionIndices: [run.sourceInstructionIndices![0] - 1] };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = applyTextEdits(f.bytes, f.page, f.objects, [{ targetRun, newText: 'New' }]);
      expect(new TextDecoder().decode(result.newContentBytes).match(whiteFill)).toHaveLength(1);
      expectBackgroundUnchanged(f.bytes, result.newContentBytes);
      expect(showingText(result.newContentBytes)).toBe('Original');
    } finally {
      warning.mockRestore();
    }
  });
});
