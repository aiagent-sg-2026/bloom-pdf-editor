import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPagePlainText } from '../ai/compare';
import { insertTextRun } from '../editor/text-editor';
import { insertImageRun } from '../editor/image-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { captureHistoryEntry, EditorHistory, restoreDocumentStructure } from '../editing/editor-history';
import { getPageContentBytes, getResource, parsePDF } from '../parser/parser';
import { decodeImage } from '../render/image-decoder';
import { PDFRef, PDFStream } from '../types';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { dehydrateDocument, hydrateDocument } from '../worker/codec';
import { extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { installPNGEnvironment, rawPDF, tinyPNG } from './audit-p1-fixtures';

const emptyOverlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };
const blankPDF = () => rawPDF([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
]);

afterEach(() => vi.unstubAllGlobals());
describe('insertions on a page with no Contents', () => {
  for (const save of [saveQuick, saveOptimized]) {
    it(`${save.name} preserves inserted text after reparsing`, async () => {
      const doc = await parsePDF(blankPDF());
      const page = doc.pages[0];
      expect(page.dict.has('Contents')).toBe(false);
      const bytes = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects, 'NEW TEXT', 20, 100, 12, [0, 0, 0]);
      await updatePageContent(page.contentRefs, bytes, doc.objects);
      const reopened = await parsePDF(await save(doc));
      expect(reopened.pages[0].dict.get('Contents')).toBeInstanceOf(PDFRef);
      expect(extractPagePlainText(reopened, 0)).toBe('NEW TEXT');
    });

    it(`${save.name} preserves inserted PNG pixels after reparsing`, async () => {
      installPNGEnvironment();
      const doc = await parsePDF(blankPDF());
      const page = doc.pages[0];
      const expected = [201, 102, 53, 255, 17, 99, 231, 255];
      const inserted = await insertImageRun(new Uint8Array(), page, doc.objects, tinyPNG(expected), 20, 100, 40, 20, () => 4);
      await updatePageContent(page.contentRefs, inserted.newContentBytes, doc.objects);
      const reopened = await parsePDF(await save(doc));
      expect(reopened.pages[0].dict.get('Contents')).toBeInstanceOf(PDFRef);
      const image = getResource(reopened.pages[0].resources, 'XObject', 'Im1', reopened.objects) as PDFStream;
      expect(Array.from((await decodeImage(image, reopened.objects))!.data)).toEqual(expected);
    });
  }

  it('includes the changed page dictionary in an explicit incremental quick save', async () => {
    const doc = await parsePDF(blankPDF());
    const page = doc.pages[0];
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, 'INCREMENTAL', 20, 100, 12, [0, 0, 0]), doc.objects);
    const saved = await saveQuick(doc, new Set(page.contentRefs.map(ref => ref.toKey())));
    expect(extractPagePlainText(await parsePDF(saved), 0)).toBe('INCREMENTAL');
  });

  it('undo restores absent Contents and redo restores inserted text', async () => {
    const doc = await parsePDF(blankPDF());
    const history = new EditorHistory();
    history.seed(captureHistoryEntry(doc, 0, new Uint8Array(), emptyOverlays, 'blank'));
    const page = doc.pages[0];
    const bytes = insertTextRun(new Uint8Array(), page, doc.objects, 'UNDOABLE', 20, 100, 12, [0, 0, 0]);
    await updatePageContent(page.contentRefs, bytes, doc.objects);
    history.push(captureHistoryEntry(doc, 0, bytes, emptyOverlays, 'insert'));
    await restoreDocumentStructure(doc, history.undo()!, updatePageContent);
    expect(doc.pages[0].dict.has('Contents')).toBe(false);
    expect(doc.pages[0].contentRefs).toEqual([]);
    expect((await parsePDF(await saveQuick(doc))).pages[0].dict.has('Contents')).toBe(false);
    await restoreDocumentStructure(doc, history.redo()!, updatePageContent);
    expect(extractPagePlainText(await parsePDF(await saveOptimized(doc)), 0)).toBe('UNDOABLE');
  });

  it('allows another insertion after undo restored absent Contents', async () => {
    const doc = await parsePDF(blankPDF());
    const snapshot = captureHistoryEntry(doc, 0, new Uint8Array(), emptyOverlays, 'blank');
    let page = doc.pages[0];
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, 'FIRST', 20, 100, 12, [0, 0, 0]), doc.objects);
    await restoreDocumentStructure(doc, snapshot, updatePageContent);
    page = doc.pages[0];
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, 'SECOND', 20, 100, 12, [0, 0, 0]), doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveQuick(doc)), 0)).toBe('SECOND');
  });

  it.each(['worker', 'merge', 'extract'] as const)('retains page ownership through %s reconstruction', async mode => {
    const source = await parsePDF(blankPDF());
    let doc = source;
    let index = 0;
    if (mode === 'worker') doc = hydrateDocument(dehydrateDocument(source));
    if (mode === 'merge') {
      doc = await parsePDF(blankPDF());
      insertPagesFromDocument(doc, source, 1);
      index = 1;
    }
    if (mode === 'extract') doc = extractPages(source, [0]);
    const page = doc.pages[index];
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, 'REBUILT', 20, 100, 12, [0, 0, 0]), doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveOptimized(doc)), index)).toBe('REBUILT');
  });
});
