import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { buildDocumentFlow } from '../flow/index';
import { applyLineTextEdit } from '../flow/flow-editor';
import { SYMBOL_TO_UNICODE, ZAPF_DINGBATS_TO_UNICODE } from '../fonts/dingbat-encodings';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, type PDFPageInfo } from '../types';

function fixture() {
  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  const fonts = new PDFDict(); fonts.set('F1', font);
  const resources = new PDFDict(); resources.set('Font', fonts);
  const pageDict = new PDFDict();
  pageDict.set('Resources', resources);
  pageDict.set('MediaBox', new PDFArray([0, 0, 612, 792].map(n => new PDFNumber(n))));
  const page: PDFPageInfo = {
    index: 0, dict: pageDict, resources, ref: new PDFRef(1, 0), contentRefs: [new PDFRef(2, 0)],
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0,
  };
  return {
    page,
    objects: new Map<string, PDFObject>(),
    bytes: new TextEncoder().encode('BT /F1 12 Tf 1 0 0 1 40 700 Tm (abc) Tj ET\n'),
  };
}

function edit(text: string) {
  const f = fixture();
  const before = interpretPage(f.bytes, f.page, f.objects);
  const line = buildDocumentFlow(before.textRuns).lines[0];
  const result = applyLineTextEdit(f.bytes, f.page, f.objects, line, text, buildDocumentFlow(before.textRuns), {
    oldText: line.text,
  });
  return { ...f, result, output: new TextDecoder().decode(result.newContentBytes) };
}

function fontResources(page: PDFPageInfo): PDFDict {
  return (page.dict.get('Resources') as PDFDict).get('Font') as PDFDict;
}

describe('Unicode Symbol and ZapfDingbats fallback', () => {
  it('uses Symbol encoding for Greek and preserves following text position', () => {
    const f = edit('α');
    expect(f.output).not.toContain('?');
    expect(fontResources(f.page).has('SymAug')).toBe(true);
    expect(f.output).toContain(String.fromCharCode(0x61));
    expect(SYMBOL_TO_UNICODE[0x61]).toBe('α');
  });

  it('splits normal text and math symbols without replacing them', () => {
    const f = edit('x ≤ y');
    expect(f.output).not.toContain('?');
    expect(fontResources(f.page).has('SymAug')).toBe(true);
    expect(f.output).toContain('\\243');
  });

  it('uses ZapfDingbats for stars and mixed neighbouring text', () => {
    const star = edit('★');
    expect(star.output).not.toContain('?');
    expect(star.output).toContain('/DingAug');
    expect(star.output).toContain(String.fromCharCode(0x48));
    expect(ZAPF_DINGBATS_TO_UNICODE[0x48]).toBe('★');

    const mixed = edit('A★B');
    expect(mixed.output).not.toContain('?');
    expect(fontResources(mixed.page).has('DingAug')).toBe(true);
    expect(fontResources(mixed.page).has('HelvAug')).toBe(true);
  });

  it('keeps ASCII digits, spaces and Latin-1 characters in the normal font', () => {
    const f = edit('D-04 ±α');
    expect(f.output).toContain('(D-04 \\261) Tj');
    expect(f.output).not.toMatch(/SymAug[^\n]*\n\([0-9 ]\)/);
  });
});
