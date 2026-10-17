import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { replaceImageXObject } from '../editor/image-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { insertTextRun } from '../editor/text-editor';
import { applyLineTextEdit, buildDocumentFlow } from '../flow';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { decodeImage } from '../render/image-decoder';
import { SessionDocumentEditor } from '../session/document-edit';
import { PDFStream, type PDFDocumentData } from '../types';
import { applyWatermarks } from '../watermark/watermark-engine';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { installPNGEnvironment, rawPDF, tinyPNG } from './audit-p1-fixtures';

function fixture(): Uint8Array {
  const content = 'q 20 0 0 20 10 10 cm /Edit Do Q\n';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Edit 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\x0a\x14\x1e\nendstream',
  ]);
}

async function watermark(doc: PDFDocumentData): Promise<void> {
  const updates = await applyWatermarks(doc, [{
    id: 'session', type: 'text', text: 'SESSION', fontName: 'Helvetica', fontSize: 12,
    color: [0, 0, 0], opacity: 0.5, blendMode: 'Normal', rotation: 0,
    tile: false, layer: 'above', position: 'center', pageIndices: [0],
  }], () => getNextObjNum(doc));
  await Promise.all([...updates].map(([index, content]) =>
    updatePageContent(doc.pages[index].contentRefs, content, doc.objects)));
}

function textFixture(): Uint8Array {
  const content = 'q 0.2 0.4 0.6 rg 10 120 180 40 re f Q\nBT /F1 12 Tf 20 140 Td (Original) Tj ET\n';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

type TextEditKind = 'existing-line' | 'add-text-box';

async function editText(doc: PDFDocumentData, kind: TextEditKind): Promise<void> {
  const page = doc.pages[0];
  const bytes = getPageContentBytes(page, doc.objects);
  const next = kind === 'existing-line'
    ? applyLineTextEdit(
      bytes, page, doc.objects,
      buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns).lines[0],
      'Replacement',
    ).newContentBytes
    : insertTextRun(
      bytes, page, doc.objects, 'Text box', 20, 90, 14, [0.8, 0.1, 0.2],
      { fontFamily: 'Courier', bold: true, italic: true, underline: true, opacity: 0.5, width: 150 },
    );
  await updatePageContent(page.contentRefs, next, doc.objects);
}

function textRuns(doc: PDFDocumentData) {
  const page = doc.pages[0];
  return interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).textRuns;
}

beforeEach(installPNGEnvironment);
afterEach(() => vi.unstubAllGlobals());

describe('SessionDocumentEditor', () => {
  it.each<TextEditKind>(['existing-line', 'add-text-box'])(
    'restores byte-identical %s revisions without changing native output',
    async kind => {
      const doc = await parsePDF(textFixture());
      const direct = await parsePDF(textFixture());
      const original = await serializeDocument(doc);
      const editor = new SessionDocumentEditor();
      await editor.edit(doc, kind, async staged => {
        await editText(staged, kind);
        expect(await serializeDocument(doc)).toEqual(original);
      });
      await editText(direct, kind);
      const applied = await serializeDocument(doc);
      expect(applied).toEqual(await serializeDocument(direct));
      const expectedText = kind === 'existing-line' ? ['Replacement'] : ['Original', 'Text box'];
      expect(textRuns(doc).map(run => run.text)).toEqual(expectedText);
      expect(textRuns(await parsePDF(applied)).map(run => run.text)).toEqual(expectedText);
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(await editor.undo(doc)).toBe(true);
        expect(await serializeDocument(doc)).toEqual(original);
        expect(textRuns(doc).map(run => run.text)).toEqual(['Original']);
        expect(await editor.redo(doc)).toBe(true);
        expect(await serializeDocument(doc)).toEqual(applied);
        expect(textRuns(doc).map(run => run.text)).toEqual(expectedText);
      }
    },
  );

  it.each<TextEditKind>(['existing-line', 'add-text-box'])(
    'isolates a failed %s after content and resource staging',
    async kind => {
      const doc = await parsePDF(textFixture());
      const original = await serializeDocument(doc);
      const page = doc.pages[0];
      const objects = doc.objects;
      const editor = new SessionDocumentEditor();
      const failure = new Error('text commit failed');
      await expect(editor.edit(doc, kind, async staged => {
        await editText(staged, kind);
        throw failure;
      })).rejects.toBe(failure);
      expect(await serializeDocument(doc)).toEqual(original);
      expect(textRuns(doc).map(run => run.text)).toEqual(['Original']);
      expect(doc.pages[0]).toBe(page);
      expect(doc.objects).toBe(objects);
      expect(editor.canUndo).toBe(false);
      expect(editor.canRedo).toBe(false);
      await editor.edit(doc, kind, staged => editText(staged, kind));
      expect(await editor.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(original);
    },
  );

  it.each(['text', 'image'] as const)('restores byte-identical %s watermark revisions', async type => {
    const doc = await parsePDF(fixture());
    const original = await serializeDocument(doc);
    const upload = doc.rawBytes;
    const objects = doc.objects;
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'watermark', async staged => {
      if (type === 'text') return watermark(staged);
      const updates = await applyWatermarks(staged, [{
        id: 'image-session', type: 'image',
        imageBytes: new Uint8Array(Buffer.from(tinyPNG([230, 40, 60, 128]).split(',')[1], 'base64')),
        mimeType: 'image/png', width: 20, height: 20,
        opacity: 0.5, blendMode: 'Normal', rotation: 0,
        tile: false, layer: 'above', position: 'center', pageIndices: [0],
      }], () => getNextObjNum(staged));
      await Promise.all([...updates].map(([index, content]) =>
        updatePageContent(staged.pages[index].contentRefs, content, staged.objects)));
    });
    const applied = await serializeDocument(doc);
    expect(applied).not.toEqual(original);
    expect(editor.canUndo).toBe(true);
    expect(editor.canRedo).toBe(false);
    expect(await editor.undo(doc)).toBe(true);
    expect(await serializeDocument(doc)).toEqual(original);
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(true);
    expect(await editor.redo(doc)).toBe(true);
    expect(await serializeDocument(doc)).toEqual(applied);
    expect(doc.rawBytes).toBe(upload);
    expect(doc.objects).toBe(objects);
  });

  it('restores replacement bytes and live pixels through repeated undo/redo', async () => {
    const doc = await parsePDF(fixture());
    const original = await serializeDocument(doc);
    const editor = new SessionDocumentEditor();
    const image = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects)
      .displayList.find(item => item.type === 'image');
    if (!image || image.type !== 'image') throw new Error('Fixture image missing');
    const rgba = [220, 30, 30, 255, 0, 0, 0, 0];
    await editor.edit(doc, 'replace-image', staged =>
      replaceImageXObject(staged, 0, image, tinyPNG(rgba), () => getNextObjNum(staged)));
    const replaced = await serializeDocument(doc);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await editor.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(original);
      expect(Array.from((await decodeImage(doc.objects.get('5_0') as PDFStream, doc.objects))!.data))
        .toEqual([10, 20, 30, 255]);
      expect(await editor.redo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(replaced);
      expect(Array.from((await decodeImage(doc.objects.get('5_0') as PDFStream, doc.objects))!.data))
        .toEqual(rgba);
    }
  });

  it('keeps native watermark output and publishes only after the async edit succeeds', async () => {
    const doc = await parsePDF(fixture());
    const direct = await parsePDF(fixture());
    const original = await serializeDocument(doc);
    const objects = doc.objects;
    const page = doc.pages[0];
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'watermark', async staged => {
      await watermark(staged);
      expect(await serializeDocument(doc)).toEqual(original);
    });
    await watermark(direct);
    expect(await serializeDocument(doc)).toEqual(await serializeDocument(direct));
    expect(doc.objects).toBe(objects);
    expect(doc.pages[0]).toBe(page);
  });

  it('preserves live image identity, decoded alpha, and repeated replacement', async () => {
    const doc = await parsePDF(fixture());
    const original = doc.objects.get('5_0') as PDFStream;
    const editor = new SessionDocumentEditor();
    for (const rgba of [
      [220, 30, 30, 255, 0, 0, 0, 0],
      [30, 180, 70, 255, 0, 0, 0, 0],
    ]) {
      const page = doc.pages[0];
      const image = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects)
        .displayList.find(item => item.type === 'image');
      if (!image || image.type !== 'image') throw new Error('Fixture image missing');
      await editor.edit(doc, 'replace-image', async staged => {
        await replaceImageXObject(staged, 0, image, tinyPNG(rgba), () => getNextObjNum(staged));
      });
      expect(doc.objects.get('5_0')).toBe(original);
      expect(Array.from((await decodeImage(original, doc.objects))!.data)).toEqual(rgba);
      const reopened = await parsePDF(await serializeDocument(doc));
      expect(Array.from((await decodeImage(reopened.objects.get('5_0') as PDFStream, reopened.objects))!.data))
        .toEqual(rgba);
    }
  });

  it('discards partially applied native edits on failure and permits the next edit', async () => {
    const doc = await parsePDF(fixture());
    const original = await serializeDocument(doc);
    const editor = new SessionDocumentEditor();
    const error = new Error('second page failed');
    await expect(editor.edit(doc, 'watermark', async staged => {
      await watermark(staged);
      throw error;
    })).rejects.toBe(error);
    expect(await serializeDocument(doc)).toEqual(original);
    await editor.edit(doc, 'watermark', watermark);
    const interpreted = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects);
    expect(interpreted.textRuns.map(run => run.text).join('')).toBe('SESSION');
  });

  it('rejects overlapping edits and does not overwrite a concurrent legacy mutation', async () => {
    const doc = await parsePDF(fixture());
    const editor = new SessionDocumentEditor();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = editor.edit(doc, 'watermark', async staged => {
      await watermark(staged);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await expect(editor.edit(doc, 'replace-image', watermark)).rejects.toThrow(/transaction.*active/i);
    const legacyContent = new TextEncoder().encode('1 0 0 rg 0 0 40 40 re f\n');
    await updatePageContent(doc.pages[0].contentRefs, legacyContent, doc.objects);
    const legacyBytes = await serializeDocument(doc);
    release.resolve();
    await expect(pending).rejects.toThrow('Document changed during the edit transaction');
    expect(await serializeDocument(doc)).toEqual(legacyBytes);
  });
});
