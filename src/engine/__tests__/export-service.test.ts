import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitThenCleanup } from '../../app/editor/commit-after-success';
import { interpretPage } from '../content/interpreter';
import { exportDocument } from '../export/export-service';
import { insertImageRun } from '../editor/image-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { insertTextRun, prepareTextForExport } from '../editor/text-editor';
import { applyFilters } from '../parser/filters';
import { getPageContentBytes, getResource, parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFNumber, PDFStream, type PDFDocumentData } from '../types';
import { hasDocumentEdits, saveOptimized as saveOptimizedDirect, saveQuick as saveQuickDirect } from '../writer/save-pipeline';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { resetPDFWorkerForTests, saveOptimized, saveQuick } from '../worker/client';
import { installPNGEnvironment, rawPDF, tinyPNG } from './audit-p1-fixtures';


function fixture(): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /Helv 6 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Unreachable true >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]);
}

async function signedFixture(): Promise<PDFDocumentData> {
  const doc = await parsePDF(fixture());
  doc.catalog.set('TestSignature', new PDFDict([
    ['ByteRange', new PDFArray([0, 10, 20, 10].map(n => new PDFNumber(n)))],
    ['Contents', new PDFHexString('01020304')],
  ]));
  return parsePDF(await serializeDocument(doc));
}

// Use the same native insertion/update operations as the page, with only the
// browser PNG decoding boundary supplied by the existing synthetic environment.
async function flatten(doc: PDFDocumentData, text: string, imageDataUrl: string): Promise<void> {
  await prepareTextForExport(doc.objects, [{ text }]);
  let next = getNextObjNum(doc);
  const page = doc.pages[0];
  let content = insertTextRun(new Uint8Array(getPageContentBytes(page, doc.objects)),
    page, doc.objects, text, 20, 150, 12, [0, 0, 0], { fontFamily: 'Helvetica' });
  content = (await insertImageRun(content, page, doc.objects, imageDataUrl,
    30, 80, 40, 20, () => next++)).newContentBytes;
  await updatePageContent(page.contentRefs, content, doc.objects);
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPDFWorkerForTests();
});

describe.each(['quick', 'optimized'] as const)('%s PDF export orchestration', mode => {
  it('preserves the exact worker-client and direct-writer output and page structure', async () => {
    const input = fixture();
    const doc = await parsePDF(input);
    const result = await exportDocument(doc, { mode });
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Export did not succeed');
    const workerBytes = await (mode === 'quick' ? saveQuick : saveOptimized)(await parsePDF(input));
    const directBytes = await (mode === 'quick' ? saveQuickDirect : saveOptimizedDirect)(await parsePDF(input));
    expect(result.bytes).toEqual(workerBytes);
    expect(result.bytes).toEqual(directBytes);
    const reopened = await parsePDF(result.bytes);
    expect(reopened.pages.map(page => page.mediaBox)).toEqual([{ x: 0, y: 0, width: 200, height: 200 }]);
    expect(doc.objects.has('5_0')).toBe(true);
  });

  it('awaits preparation, the pending edit, and flattened text/images before saving', async () => {
    installPNGEnvironment();
    const input = fixture();
    const doc = await parsePDF(input);
    const text = 'Floating export text';
    const image = tinyPNG([201, 102, 53, 255, 17, 99, 231, 128]);
    let prepared = false;
    let editCommitted = false;
    const result = await exportDocument(doc, {
      mode,
      prepare: async () => {
        await prepareTextForExport(doc.objects, [{ text }]);
        prepared = true;
      },
      commitPendingEdit: async () => {
        expect(prepared).toBe(true);
        await updatePageContent(doc.pages[0].contentRefs,
          new TextEncoder().encode('0 0 1 rg 0 0 10 10 re f\n'), doc.objects);
        editCommitted = true;
        return true;
      },
      flatten: async () => {
        expect(editCommitted).toBe(true);
        await flatten(doc, text, image);
      },
    });
    if (result.status !== 'success') throw new Error('Export did not succeed');

    const directDoc = await parsePDF(input);
    await updatePageContent(directDoc.pages[0].contentRefs,
      new TextEncoder().encode('0 0 1 rg 0 0 10 10 re f\n'), directDoc.objects);
    await flatten(directDoc, text, image);
    expect(result.bytes).toEqual(await (mode === 'quick' ? saveQuick : saveOptimized)(directDoc));
    const reopened = await parsePDF(result.bytes);
    const page = reopened.pages[0];
    const content = getPageContentBytes(page, reopened.objects);
    const interpreted = interpretPage(content, page, reopened.objects);
    expect(interpreted.textRuns.map(run => run.text).join('')).toBe(text);
    expect(interpreted.displayList.find(item => item.type === 'image')).toMatchObject({
      type: 'image', width: 40, height: 20,
    });
    const outputImage = getResource(page.resources, 'XObject', 'Im1', reopened.objects) as PDFStream;
    expect(outputImage.dict.getNumber('Width')).toBe(2);
    expect(outputImage.dict.getNumber('Height')).toBe(1);
    expect(Array.from(await applyFilters(outputImage.rawBytes, outputImage.getFilters(), outputImage.getDecodeParams())))
      .toEqual([201, 102, 53, 17, 99, 231]);
  });

  it('keeps edited signed documents dirty and does not publish a successful export', async () => {
    const doc = await signedFixture();
    const originalBytes = doc.rawBytes;
    doc.pages[0].dict.set('Rotate', new PDFNumber(90));
    let dirty = true;
    let committedBytes: Uint8Array | undefined;
    const result = await exportDocument(doc, { mode });
    if (result.status === 'success') {
      committedBytes = result.bytes;
      dirty = false;
    }
    expect(result).toMatchObject({ status: 'error', error: { name: 'SignedDocumentEditError' } });
    expect(dirty).toBe(true);
    expect(committedBytes).toBeUndefined();
    expect(doc.rawBytes).toBe(originalBytes);
    expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
    expect(await hasDocumentEdits(doc)).toBe(true);
  });

  it('does not clear pending overlays when their content update fails', async () => {
    const doc = await parsePDF(fixture());
    const originalContent = getPageContentBytes(doc.pages[0], doc.objects);
    let pending = ['Floating text'];
    const result = await exportDocument(doc, {
      mode,
      flatten: () => commitThenCleanup(
        () => updatePageContent([], new TextEncoder().encode(pending[0]), doc.objects),
        () => { pending = []; },
      ),
    });
    expect(result).toMatchObject({ status: 'error', error: { message: 'Cannot attach content to an unregistered page' } });
    expect(pending).toEqual(['Floating text']);
    expect(getPageContentBytes(doc.pages[0], doc.objects)).toEqual(originalContent);
  });

  it('cancels without flattening or saving when the pending edit is rejected', async () => {
    const doc = await signedFixture();
    doc.pages[0].dict.set('Rotate', new PDFNumber(90));
    const result = await exportDocument(doc, {
      mode,
      commitPendingEdit: async () => false,
      flatten: async () => { doc.pages[0].dict.set('Rotate', new PDFNumber(180)); },
    });
    // Saving this edited signed document would fail, rather than cancel.
    expect(result).toEqual({ status: 'cancelled' });
    expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
  });

  it('returns the original preparation error without committing pending edits', async () => {
    const doc = await parsePDF(fixture());
    const error = new Error('font preparation failed');
    const result = await exportDocument(doc, {
      mode,
      prepare: async () => { throw error; },
      commitPendingEdit: async () => {
        doc.pages[0].dict.set('Rotate', new PDFNumber(90));
        return true;
      },
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('Export should have failed');
    expect(result.error).toBe(error);
    expect(doc.pages[0].dict.has('Rotate')).toBe(false);
  });
});
