import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { applyTextEdits, insertTextRun } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';
import { applyLineTextEdit } from '../flow/flow-editor';
import { buildDocumentFlow } from '../flow/index';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream,
  type PDFDocumentData, type PDFObject,
} from '../types';

const encode = (text: string) => new TextEncoder().encode(text);

function fixture(subset = false): PDFDocumentData {
  const catalogRef = new PDFRef(1, 0);
  const pagesRef = new PDFRef(2, 0);
  const pageRef = new PDFRef(3, 0);
  const contentRef = new PDFRef(4, 0);
  const font = new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
    ['BaseFont', new PDFName(subset ? 'ABCDEF+Helvetica' : 'Helvetica')],
    ['Encoding', new PDFName('WinAnsiEncoding')],
  ]);
  let toUnicode: PDFStream | undefined;
  if (subset) {
    const cmap = encode([
      'begincmap', '1 begincodespacerange', '<00> <FF>', 'endcodespacerange',
      '3 beginbfchar', '<61> <0061>', '<62> <0062>', '<63> <0063>',
      'endbfchar', 'endcmap',
    ].join('\n'));
    toUnicode = new PDFStream(new PDFDict([
      ['Length', new PDFNumber(cmap.length)],
    ]), cmap, cmap);
    font.set('ToUnicode', new PDFRef(5, 0));
  }
  const resources = new PDFDict([['Font', new PDFDict([['F1', font]])]]);
  const catalog = new PDFDict([['Type', new PDFName('Catalog')], ['Pages', pagesRef]]);
  const pagesDict = new PDFDict([
    ['Type', new PDFName('Pages')], ['Kids', new PDFArray([pageRef])], ['Count', new PDFNumber(1)],
  ]);
  const dict = new PDFDict([
    ['Type', new PDFName('Page')], ['Parent', pagesRef], ['Contents', contentRef],
    ['Resources', resources],
    ['MediaBox', new PDFArray([0, 0, 612, 792].map(n => new PDFNumber(n)))],
  ]);
  const bytes = encode('BT /F1 12 Tf 1 0 0 1 40 700 Tm (abc) Tj ET\n');
  const objects = new Map<string, PDFObject>([
    [catalogRef.toKey(), catalog], [pagesRef.toKey(), pagesDict], [pageRef.toKey(), dict],
    [contentRef.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes)],
  ]);
  if (toUnicode) objects.set('5_0', toUnicode);
  return {
    version: '1.7', objects, catalog,
    pages: [{
      index: 0, ref: pageRef, dict, resources, contentRefs: [contentRef], rotate: 0,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
    }],
    xref: { entries: new Map(), trailerDict: new PDFDict([['Root', catalogRef]]) },
    info: {}, rawBytes: new Uint8Array(),
  };
}

async function reopen(doc: PDFDocumentData) {
  return parsePDF(await serializeDocument(doc));
}

function pageText(doc: PDFDocumentData) {
  const page = doc.pages[0];
  return interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects)
    .textRuns.map(run => run.text).join('');
}

function expectUnsupported(action: () => unknown, characters: string[]) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(UnsupportedGlyphsError);
  const unsupported = error as UnsupportedGlyphsError;
  expect(unsupported.characters).toEqual(characters);
  expect(unsupported.codePoints).toEqual(characters.map(ch => ch.codePointAt(0)));
}

describe('unsupported glyph export safety', () => {
  it.each(['计算机科学', 'ABC 计算机科学'])('reports unsupported new text before exporting %s', async text => {
    const doc = await reopen(fixture());
    const before = await serializeDocument(doc);
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    // No font in this synthetic document can supply CJK glyphs. Export must report them.
    expectUnsupported(() => insertTextRun(bytes, page, doc.objects, text, 40, 650, 12, [0, 0, 0]),
      ['计', '算', '机', '科', '学']);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(pageText(await reopen(doc))).toBe('abc');
  });

  it('keeps a batch of existing subset edits intact when a later edit needs CJK', async () => {
    const doc = await reopen(fixture(true));
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    const targetRun = interpretPage(bytes, page, doc.objects).textRuns[0];
    const before = await serializeDocument(doc);
    expectUnsupported(() => applyTextEdits(bytes, page, doc.objects, [
      { targetRun, newText: 'ABC' }, { targetRun, newText: 'ABC 计算机科学' },
    ]), ['计', '算', '机', '科', '学']);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(pageText(await reopen(doc))).toBe('abc');
  });

  it('reports unsupported characters through the editor line-commit path', async () => {
    const doc = await reopen(fixture(true));
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    const flow = buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns);
    const before = await serializeDocument(doc);
    const runIndices = flow.rawRuns.map(run => run.sourceInstructionIndices?.slice());
    expectUnsupported(() => applyLineTextEdit(bytes, page, doc.objects, flow.lines[0],
      '计算机科学', flow, { oldText: 'abc' }), ['计', '算', '机', '科', '学']);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(flow.rawRuns.map(run => run.sourceInstructionIndices)).toEqual(runIndices);
    expect(pageText(await reopen(doc))).toBe('abc');
  });

  it.each([false, true])('lists complete unsupported code points once (existing edit: %s)', existing => {
    const doc = fixture(true);
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    const targetRun = interpretPage(bytes, page, doc.objects).textRuns[0];
    expectUnsupported(() => existing
      ? applyTextEdits(bytes, page, doc.objects, [{ targetRun, newText: '计😀计😀学' }])
      : insertTextRun(bytes, page, doc.objects, '计😀计😀学', 40, 650, 12, [0, 0, 0]),
    ['计', '😀', '学']);
  });

  it.each(['ABC café?', 'Aα ≤ B★'])('preserves supported new text through export and reparse: %s', async text => {
    const doc = await reopen(fixture());
    const page = doc.pages[0];
    const bytes = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects,
      text, 40, 650, 12, [0, 0, 0]);
    await updatePageContent(page.contentRefs, bytes, doc.objects);
    expect(pageText(await reopen(doc))).toBe(`abc${text}`);
  });

  it('preserves supported subset-font fallback through export and reparse', async () => {
    const doc = await reopen(fixture(true));
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    const targetRun = interpretPage(bytes, page, doc.objects).textRuns[0];
    const edited = applyTextEdits(bytes, page, doc.objects, [{ targetRun, newText: 'ABC α★' }]);
    await updatePageContent(page.contentRefs, edited.newContentBytes, doc.objects);
    expect(pageText(await reopen(doc))).toBe('ABC α★');
  });

  it('preserves supported Symbol/Dingbats text in a grouped fallback edit', async () => {
    const doc = await reopen(fixture(true));
    const page = doc.pages[0];
    const bytes = encode('BT /F1 12 Tf 1 0 0 1 40 700 Tm (a) Tj (bc) Tj ET\n');
    await updatePageContent(page.contentRefs, bytes, doc.objects);
    const runs = interpretPage(bytes, page, doc.objects).textRuns;
    const sourceInstructionIndices = parseContentStream(bytes).flatMap((inst, index) =>
      inst.operator === 'Tj' ? [index] : []);
    const targetRun = { ...runs[0], text: 'abc', sourceInstructionIndices };
    const edited = applyTextEdits(bytes, page, doc.objects, [{ targetRun, newText: 'ABC α★' }]);
    await updatePageContent(page.contentRefs, edited.newContentBytes, doc.objects);
    expect(pageText(await reopen(doc))).toBe('ABC α★');
  });

});
