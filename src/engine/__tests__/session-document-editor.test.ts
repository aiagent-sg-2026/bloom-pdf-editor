import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { addAnnotationToPage, clearMarkupAnnotationsOnPage, createAnnotationDict, eraseAnnotationsAtPoint, type Annotation } from '../editor/annotation-engine';
import { addHighlightFromLineSelection } from '../editor/highlight';
import { replaceImageXObject } from '../editor/image-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { insertTextRun } from '../editor/text-editor';
import { applyLineTextEdit, buildDocumentFlow } from '../flow';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { decodeImage } from '../render/image-decoder';
import { addDrawingAnnotations, collectDrawingRemovals, collectMarkupRemovals, previewMarkupRemoval, removeMarkupReferences, SessionDocumentEditor } from '../session/document-edit';
import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFDocumentData } from '../types';
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

const drawingCases: { name: string; annotation: Annotation }[] = [
  { name: 'draw stroke', annotation: {
    type: 'Ink', rect: { x: 18, y: 88, width: 64, height: 24 },
    color: [0.2, 0.4, 0.8], opacity: 1, lineWidth: 2, inkPaths: [[20, 90, 50, 110, 80, 90]],
  } },
  { name: 'freehand highlighter', annotation: {
    type: 'Ink', rect: { x: 18, y: 88, width: 64, height: 24 },
    color: [1, 1, 0], opacity: 0.4, lineWidth: 8, inkPaths: [[20, 90, 80, 90]],
  } },
  { name: 'rectangle', annotation: {
    type: 'Square', rect: { x: 20, y: 90, width: 60, height: 30 },
    color: [0.2, 0.4, 0.8], opacity: 1, lineWidth: 2, fillColor: null,
  } },
  { name: 'ellipse', annotation: {
    type: 'Circle', rect: { x: 20, y: 90, width: 60, height: 30 },
    color: [0.2, 0.4, 0.8], opacity: 1, lineWidth: 2, fillColor: null,
  } },
  ...(['None', 'OpenArrow'] as const).map(endStyle => ({
    name: endStyle === 'None' ? 'line' : 'arrow',
    annotation: {
      type: 'Line' as const, rect: { x: 12, y: 82, width: 76, height: 46 },
      color: [0.2, 0.4, 0.8] as [number, number, number], opacity: 1, lineWidth: 2,
      x1: 80, y1: 90, x2: 20, y2: 120, startStyle: 'None' as const, endStyle,
    },
  })),
];

beforeEach(installPNGEnvironment);
afterEach(() => vi.unstubAllGlobals());

describe('SessionDocumentEditor', () => {
  it.each(drawingCases)('restores exact $name bytes and isolates failed creation', async ({ annotation }) => {
    const doc = await parsePDF(textFixture());
    const direct = await parsePDF(textFixture());
    const original = await serializeDocument(doc);
    const editor = new SessionDocumentEditor();
    const failure = new Error('drawing staging failed');
    await expect(editor.edit(doc, 'draw', async staged => {
      addDrawingAnnotations(staged, 0, [annotation]);
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(original);
    expect(editor.canUndo).toBe(false);
    await editor.edit(doc, 'draw', async staged => { addDrawingAnnotations(staged, 0, [annotation]); });
    const ref = new PDFRef(getNextObjNum(direct), 0);
    const { dict } = createAnnotationDict(annotation, ref.objNum, direct.objects);
    addAnnotationToPage(direct.pages[0].dict, dict, ref, direct.objects);
    const applied = await serializeDocument(doc);
    expect(applied).toEqual(await serializeDocument(direct));
    const reopened = await parsePDF(applied);
    const annotationDict = (target: PDFDocumentData) =>
      target.objects.get((target.pages[0].dict.getArray('Annots')!.items[0] as PDFRef).toKey()) as PDFDict;
    const restoredDict = annotationDict(reopened);
    expect(restoredDict.getName('Subtype')).toBe(annotation.type);
    for (const key of ['Rect', 'C', 'CA', 'BS', 'InkList', 'L', 'LE']) {
      expect(restoredDict.get(key)).toEqual(dict.get(key));
    }
    const appearance = (target: PDFDocumentData) =>
      (target.objects.get(annotationDict(target).getDict('AP')!.getRef('N')!.toKey()) as PDFStream).getBytes();
    expect(appearance(reopened)).toEqual(appearance(direct));
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await editor.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(original);
      expect(await editor.redo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(applied);
    }
  });

  it.each([false, true])('stages Ink erasure with indirect Annots=%s without publishing previews or failures', async indirect => {
    const doc = await parsePDF(textFixture());
    addDrawingAnnotations(doc, 0, [
      { type: 'Ink', rect: { x: 18, y: 88, width: 64, height: 4 }, color: [0, 0, 0],
        opacity: 1, lineWidth: 2, inkPaths: [[20, 90, 80, 90]] },
      { type: 'Ink', rect: { x: 18, y: 88, width: 64, height: 4 }, color: [1, 1, 0],
        opacity: 0.4, lineWidth: 8, inkPaths: [[20, 90, 80, 90]] },
      { type: 'Square', rect: { x: 140, y: 140, width: 20, height: 20 }, color: [1, 0, 0],
        opacity: 1, lineWidth: 2 },
    ]);
    const refs = [...doc.pages[0].dict.getArray('Annots')!.items] as PDFRef[];
    if (indirect) {
      const arrayRef = new PDFRef(getNextObjNum(doc), 0);
      doc.objects.set(arrayRef.toKey(), doc.pages[0].dict.getArray('Annots')!);
      doc.pages[0].dict.set('Annots', arrayRef);
    }
    const original = await serializeDocument(doc);
    const hits = collectDrawingRemovals(doc, 0, (dict, objects) => eraseAnnotationsAtPoint(dict, objects, 25, 90, 4));
    expect(hits.transactional.map(ref => ref.toKey())).toEqual(refs.slice(0, 2).map(ref => ref.toKey()));
    expect(hits.legacy).toEqual([]);
    const preview = previewMarkupRemoval(doc, 0, new Map(hits.transactional.map(ref => [ref.toKey(), ref])));
    expect(preview.pages[0].dict.getArray('Annots')!.items).toEqual([refs[2]]);
    expect(await serializeDocument(doc)).toEqual(original);
    const editor = new SessionDocumentEditor();
    const failure = new Error('Ink erase failed');
    await expect(editor.edit(doc, 'erase', async staged => {
      removeMarkupReferences(staged, 0, hits.transactional);
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(original);
    expect(editor.canUndo).toBe(false);
    await editor.edit(doc, 'erase', async staged => { removeMarkupReferences(staged, 0, hits.transactional); });
    const erased = await serializeDocument(doc);
    const reopened = await parsePDF(erased);
    const annots = reopened.pages[0].dict.get('Annots');
    const array = annots instanceof PDFRef ? reopened.objects.get(annots.toKey()) as PDFArray : annots as PDFArray;
    expect(array.items).toEqual([refs[2]]);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await editor.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(original);
      expect(await editor.redo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(erased);
    }
  });

  it.each(['Highlight', 'Underline', 'StrikeOut'] as const)(
    'commits and removes byte-identical %s appearances without publishing failed drafts',
    async subtype => {
      const doc = await parsePDF(textFixture());
      const direct = await parsePDF(textFixture());
      const original = await serializeDocument(doc);
      const line = buildDocumentFlow(textRuns(doc)).lines[0];
      const add = (target: PDFDocumentData) =>
        addHighlightFromLineSelection(target, 0, line, 0, line.text.length, [1, 1, 0], subtype);
      const editor = new SessionDocumentEditor();
      const failure = new Error('markup staging failed');
      await expect(editor.edit(doc, subtype, async staged => {
        add(staged);
        throw failure;
      })).rejects.toBe(failure);
      expect(await serializeDocument(doc)).toEqual(original);
      expect(editor.canUndo).toBe(false);
      await editor.edit(doc, subtype, async staged => { add(staged); });
      add(direct);
      const applied = await serializeDocument(doc);
      expect(applied).toEqual(await serializeDocument(direct));
      const appearance = (target: PDFDocumentData) => {
        const annots = target.pages[0].dict.get('Annots') as PDFArray;
        const annot = target.objects.get((annots.items[0] as PDFRef).toKey()) as PDFDict;
        expect(annot.getName('Subtype')).toBe(subtype);
        const ap = target.objects.get(annot.getDict('AP')!.getRef('N')!.toKey()) as PDFStream;
        return ap.getBytes();
      };
      expect(appearance(await parsePDF(applied))).toEqual(appearance(doc));
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(await editor.undo(doc)).toBe(true);
        expect(await serializeDocument(doc)).toEqual(original);
        expect(await editor.redo(doc)).toBe(true);
        expect(await serializeDocument(doc)).toEqual(applied);
      }
      for (const operation of [
        (dict: PDFDict, objects: PDFDocumentData['objects']) => eraseAnnotationsAtPoint(dict, objects, 25, 140, 4),
        clearMarkupAnnotationsOnPage,
      ]) {
        const { textMarkup, legacy } = collectMarkupRemovals(doc, 0, operation);
        expect(textMarkup.map(ref => ref.toKey())).toEqual(
          (doc.pages[0].dict.get('Annots') as PDFArray).items.map(ref => (ref as PDFRef).toKey()),
        );
        expect(legacy).toEqual([]);
        const preview = previewMarkupRemoval(doc, 0, new Map(textMarkup.map(ref => [ref.toKey(), ref])));
        expect(preview.pages[0].dict.getArray('Annots')!.items).toEqual([]);
        expect(await serializeDocument(doc)).toEqual(applied);
        const removal = new SessionDocumentEditor();
        await expect(removal.edit(doc, 'erase', async staged => {
          removeMarkupReferences(staged, 0, textMarkup);
          throw failure;
        })).rejects.toBe(failure);
        expect(await serializeDocument(doc)).toEqual(applied);
        expect(removal.canUndo).toBe(false);
        await removal.edit(doc, 'erase', async staged => { removeMarkupReferences(staged, 0, textMarkup); });
        const removed = await serializeDocument(doc);
        expect((await parsePDF(removed)).pages[0].dict.get('Annots')).toEqual(new PDFArray());
        expect(await removal.undo(doc)).toBe(true);
        expect(await serializeDocument(doc)).toEqual(applied);
        expect(await removal.redo(doc)).toBe(true);
        expect(await serializeDocument(doc)).toEqual(removed);
        await removal.undo(doc);
      }
    },
  );

  it('restores an indirect annotation array after transactional erasure', async () => {
    const doc = await parsePDF(textFixture());
    const line = buildDocumentFlow(textRuns(doc)).lines[0];
    const ref = addHighlightFromLineSelection(doc, 0, line, 0, line.text.length, [1, 1, 0], 'Underline')!;
    const annots = doc.pages[0].dict.getArray('Annots')!;
    const arrayRef = new PDFRef(getNextObjNum(doc), 0);
    doc.objects.set(arrayRef.toKey(), annots);
    doc.pages[0].dict.set('Annots', arrayRef);
    const original = await serializeDocument(doc);
    const hit = collectMarkupRemovals(doc, 0, (dict, objects) => eraseAnnotationsAtPoint(dict, objects, 25, 140, 4));
    expect(hit.textMarkup.map(item => item.toKey())).toEqual([ref.toKey()]);
    expect(await serializeDocument(doc)).toEqual(original);
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'erase', async staged => { removeMarkupReferences(staged, 0, hit.textMarkup); });
    const erased = await serializeDocument(doc);
    const reopened = await parsePDF(erased);
    expect((reopened.objects.get(arrayRef.toKey()) as PDFArray).items).toEqual([]);
    expect(reopened.pages[0].dict.getRef('Annots')!.toKey()).toBe(arrayRef.toKey());
    expect(await editor.undo(doc)).toBe(true);
    expect(await serializeDocument(doc)).toEqual(original);
    expect(await editor.redo(doc)).toBe(true);
    expect(await serializeDocument(doc)).toEqual(erased);
  });

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
