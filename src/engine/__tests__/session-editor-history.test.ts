import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { addAnnotationToPage, clearMarkupAnnotationsOnPage, createAnnotationDict, eraseAnnotationsAtPoint, type Annotation } from '../editor/annotation-engine';
import { addHighlightFromLineSelection } from '../editor/highlight';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
import { insertTextRun } from '../editor/text-editor';
import { buildDocumentFlow } from '../flow';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { addDrawingAnnotations, collectDrawingRemovals, collectMarkupRemovals, removeMarkupReferences, SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { deletePage } from '../writer/page-operations';
import { PDFRef } from '../types';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

const overlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };

async function setup() {
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ]));
  const history = new SessionEditorHistory();
  const capture = (label: string, floatingTexts: unknown[] = []) => captureHistoryEntry(
    doc, 0, getPageContentBytes(doc.pages[0], doc.objects), { ...overlays, floatingTexts }, label,
  );
  const content = (text: string) => updatePageContent(
    doc.pages[0].contentRefs, new TextEncoder().encode(text), doc.objects,
  );
  const sessionEdit = async (label: string, text: string, floatingTexts: unknown[] = []) => {
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, label, staged => updatePageContent(
      staged.pages[0].contentRefs, new TextEncoder().encode(text), staged.objects,
    ));
    history.push(capture(label, floatingTexts), editor);
  };
  const textBox = async (text: string, fontFamily = 'Courier') => {
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'add-text-box', async staged => {
      const page = staged.pages[0];
      const bytes = insertTextRun(
        getPageContentBytes(page, staged.objects), page, staged.objects,
        text, 20, 90, 14, [0.8, 0.1, 0.2],
        { fontFamily, bold: true, italic: true, underline: true, opacity: 0.5, width: 150 },
      );
      await updatePageContent(page.contentRefs, bytes, staged.objects);
    });
    return editor;
  };
  const move = async (direction: 'undo' | 'redo') => {
    const result = await history[direction](doc);
    if (result && !result.restoredDocument) await restoreDocumentStructure(doc, result.entry, updatePageContent);
    return result?.entry;
  };
  history.seed(capture('initial'));
  return { doc, history, capture, content, sessionEdit, textBox, move };
}

describe('SessionEditorHistory', () => {
  it.each(['rectangle', 'ellipse', 'line', 'arrow'] as const)(
    'orders Ink, %s, legacy snapshots, and one mixed Ink erase transaction',
    async kind => {
      const { doc, history, capture, textBox, move } = await setup();
      await textBox('Markup');
      history.seed(capture('initial'));
      history.push(capture('legacy-overlay', [{ text: 'keep overlay' }]));
      const beforeInk = await serializeDocument(doc);
      const ink: Annotation = {
        type: 'Ink', rect: { x: 18, y: 88, width: 64, height: 4 }, color: [0, 0, 0],
        opacity: 1, lineWidth: 2, inkPaths: [[20, 90, 80, 90]],
      };
      const drawing = new SessionDocumentEditor();
      await drawing.edit(doc, 'draw-stroke', async staged => {
        addDrawingAnnotations(staged, 0, [ink, { ...ink, opacity: 0.4 }]);
      });
      history.push(capture('draw-stroke'), drawing);
      const drawn = await serializeDocument(doc);
      history.push(capture('legacy-overlay-2', [{ text: 'second overlay' }]));
      const shape: Annotation = kind === 'rectangle' || kind === 'ellipse'
        ? { type: kind === 'rectangle' ? 'Square' : 'Circle',
          rect: { x: 140, y: 140, width: 30, height: 20 }, color: [1, 0, 0], opacity: 1, lineWidth: 3 }
        : { type: 'Line', rect: { x: 132, y: 132, width: 46, height: 36 },
          color: [1, 0, 0], opacity: 1, lineWidth: 3,
          x1: 140, y1: 140, x2: 170, y2: 160, startStyle: 'None',
          endStyle: kind === 'arrow' ? 'OpenArrow' : 'None' };
      const shapes = new SessionDocumentEditor();
      await shapes.edit(doc, 'draw-shape', async staged => { addDrawingAnnotations(staged, 0, [shape]); });
      history.push(capture('draw-shape'), shapes);
      const shaped = await serializeDocument(doc);
      // Existing text markup shares the Ink gesture's single transaction.
      const page = doc.pages[0];
      const line = buildDocumentFlow(interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).textRuns).lines[0];
      const markup = new SessionDocumentEditor();
      await markup.edit(doc, 'highlight', async staged => {
        addHighlightFromLineSelection(staged, 0, line, 0, line.text.length, [1, 1, 0], 'Underline');
      });
      history.push(capture('highlight'), markup);
      const beforeErase = await serializeDocument(doc);
      const hits = collectDrawingRemovals(doc, 0, (dict, objects) => eraseAnnotationsAtPoint(dict, objects, 25, 90, 4));
      expect(hits.transactional.map(ref => ref.toKey()).sort()).toEqual(
        capture('probe').annotSnapshot.annotRefKeys.filter((_, index) => index !== 2).sort(),
      );
      expect(hits.legacy).toEqual([]);
      const removal = new SessionDocumentEditor();
      const failure = new Error('erase staging failed');
      await expect(removal.edit(doc, 'erase', async staged => {
        removeMarkupReferences(staged, 0, hits.transactional);
        throw failure;
      })).rejects.toBe(failure);
      expect(await serializeDocument(doc)).toEqual(beforeErase);
      expect(history.peek()?.label).toBe('highlight');
      await removal.edit(doc, 'erase', async staged => { removeMarkupReferences(staged, 0, hits.transactional); });
      history.push(capture('erase'), removal);
      const erased = await serializeDocument(doc);
      expect(capture('erased').annotSnapshot.annotRefKeys).toEqual(
        (await parsePDF(shaped)).pages[0].dict.getArray('Annots')!.items.slice(2).map(ref => (ref as PDFRef).toKey()),
      );
      for (let cycle = 0; cycle < 2; cycle++) {
        expect((await move('undo'))?.label).toBe('highlight');
        expect(await serializeDocument(doc)).toEqual(beforeErase);
        expect((await move('undo'))?.label).toBe('draw-shape');
        expect(await serializeDocument(doc)).toEqual(shaped);
        expect((await move('undo'))?.label).toBe('legacy-overlay-2');
        expect(await serializeDocument(doc)).toEqual(drawn);
        expect((await move('undo'))?.overlays.floatingTextsJson).toBe('[]');
        expect((await move('undo'))?.label).toBe('legacy-overlay');
        expect(await serializeDocument(doc)).toEqual(beforeInk);
        expect((await move('undo'))?.label).toBe('initial');
        expect(history.canUndo()).toBe(false);
        expect((await move('redo'))?.overlays.floatingTextsJson).toBe('[{"text":"keep overlay"}]');
        expect((await move('redo'))?.label).toBe('draw-stroke');
        expect(await serializeDocument(doc)).toEqual(drawn);
        expect((await move('redo'))?.label).toBe('legacy-overlay-2');
        expect((await move('redo'))?.label).toBe('draw-shape');
        expect(await serializeDocument(doc)).toEqual(shaped);
        expect((await move('redo'))?.label).toBe('highlight');
        expect(await serializeDocument(doc)).toEqual(beforeErase);
        expect((await move('redo'))?.label).toBe('erase');
        expect(await serializeDocument(doc)).toEqual(erased);
        expect(history.canRedo()).toBe(false);
      }
      await move('undo');
      const failedErase = new SessionDocumentEditor();
      await expect(failedErase.edit(doc, 'erase', async staged => {
        removeMarkupReferences(staged, 0, hits.transactional);
        throw failure;
      })).rejects.toBe(failure);
      expect(await serializeDocument(doc)).toEqual(beforeErase);
      expect(history.peek()?.label).toBe('highlight');
      expect(history.canRedo()).toBe(true);
      const failedBranch = new SessionDocumentEditor();
      await expect(failedBranch.edit(doc, 'draw-shape', async staged => {
        addDrawingAnnotations(staged, 0, [shape]);
        throw failure;
      })).rejects.toBe(failure);
      expect(await serializeDocument(doc)).toEqual(beforeErase);
      expect(history.peek()?.label).toBe('highlight');
      expect(history.canRedo()).toBe(true);
      expect((await move('redo'))?.label).toBe('erase');
      expect(await serializeDocument(doc)).toEqual(erased);
      await move('undo');
      await failedBranch.edit(doc, 'draw-shape', async staged => { addDrawingAnnotations(staged, 0, [shape]); });
      history.push(capture('draw-shape'), failedBranch);
      expect(history.canRedo()).toBe(false);
      expect((await move('undo'))?.label).toBe('highlight');
      expect(await serializeDocument(doc)).toEqual(beforeErase);
    },
  );

  it.each(['Highlight', 'Underline', 'StrikeOut'] as const)(
    'orders %s creation and mixed legacy erasure without consuming failed edits',
    async subtype => {
      const { doc, history, capture, textBox, move } = await setup();
      await textBox('Markup');
      history.seed(capture('initial'));
      const original = await serializeDocument(doc);
      const page = doc.pages[0];
      const line = buildDocumentFlow(interpretPage(
        getPageContentBytes(page, doc.objects), page, doc.objects,
      ).textRuns).lines[0];
      const editor = new SessionDocumentEditor();
      await editor.edit(doc, subtype, async staged => {
        addHighlightFromLineSelection(staged, 0, line, 0, line.text.length, [1, 1, 0], subtype);
      });
      history.push(capture(subtype), editor);
      const marked = await serializeDocument(doc);
      const clearEditor = new SessionDocumentEditor();
      const clearRefs = collectMarkupRemovals(doc, 0, clearMarkupAnnotationsOnPage).textMarkup;
      await clearEditor.edit(doc, 'clear-markup', async staged => { removeMarkupReferences(staged, 0, clearRefs); });
      history.push(capture('clear-markup'), clearEditor);
      const cleared = await serializeDocument(doc);
      for (let cycle = 0; cycle < 2; cycle++) {
        expect((await move('undo'))?.label).toBe(subtype);
        expect(await serializeDocument(doc)).toEqual(marked);
        expect((await move('undo'))?.label).toBe('initial');
        expect(await serializeDocument(doc)).toEqual(original);
        expect((await move('redo'))?.label).toBe(subtype);
        expect(await serializeDocument(doc)).toEqual(marked);
        expect((await move('redo'))?.label).toBe('clear-markup');
        expect(await serializeDocument(doc)).toEqual(cleared);
      }
      await move('undo');
      const clearFailure = new Error('clear failed');
      await expect(clearEditor.edit(doc, 'clear-markup', async staged => {
        removeMarkupReferences(staged, 0, clearRefs);
        throw clearFailure;
      })).rejects.toBe(clearFailure);
      expect(await serializeDocument(doc)).toEqual(marked);
      expect(history.canRedo()).toBe(true);
      expect((await move('redo'))?.label).toBe('clear-markup');
      expect(await serializeDocument(doc)).toEqual(cleared);
      await move('undo');
      const inkRef = new PDFRef(getNextObjNum(doc), 0);
      const { dict } = createAnnotationDict({
        type: 'Ink', rect: { x: 20, y: 85, width: 60, height: 20 },
        color: [0, 0, 0], opacity: 1, inkPaths: [[20, 90, 80, 90]], lineWidth: 2,
      }, inkRef.objNum, doc.objects);
      addAnnotationToPage(doc.pages[0].dict, dict, inkRef, doc.objects);
      history.push(capture('draw-stroke'));
      const mixed = await serializeDocument(doc);
      const { textMarkup, legacy } = collectMarkupRemovals(doc, 0, (dict, objects) =>
        eraseAnnotationsAtPoint(dict, objects, 25, 90, 4));
      expect(legacy.map(ref => ref.toKey())).toEqual([inkRef.toKey()]);
      expect(textMarkup.map(ref => ref.toKey())).toEqual(capture('probe').annotSnapshot.annotRefKeys.slice(0, 1));
      removeMarkupReferences(doc, 0, legacy);
      history.push(capture('erase'));
      const beforeFailure = await serializeDocument(doc);
      const removal = new SessionDocumentEditor();
      const failure = new Error('erase failed');
      await expect(removal.edit(doc, 'erase', async staged => {
        removeMarkupReferences(staged, 0, textMarkup);
        throw failure;
      })).rejects.toBe(failure);
      expect(await serializeDocument(doc)).toEqual(beforeFailure);
      expect(history.peek()?.label).toBe('erase');
      await removal.edit(doc, 'erase', async staged => { removeMarkupReferences(staged, 0, textMarkup); });
      history.replace(capture('erase'), true, removal);
      for (let cycle = 0; cycle < 2; cycle++) {
        expect((await move('undo'))?.label).toBe('draw-stroke');
        expect(capture('restored').annotSnapshot.annotRefKeys).toEqual(
          (await parsePDF(mixed)).pages[0].dict.getArray('Annots')!.items.map(ref => (ref as PDFRef).toKey()),
        );
        expect((await move('undo'))?.label).toBe(subtype);
        expect(capture('restored').annotSnapshot.annotRefKeys).toEqual(textMarkup.map(ref => ref.toKey()));
        expect((await move('undo'))?.label).toBe('initial');
        expect(await serializeDocument(doc)).toEqual(original);
        expect(history.canUndo()).toBe(false);
        expect((await move('redo'))?.label).toBe(subtype);
        expect(await serializeDocument(doc)).toEqual(marked);
        expect((await move('redo'))?.label).toBe('draw-stroke');
        expect((await move('redo'))?.label).toBe('erase');
        expect(capture('erased').annotSnapshot.annotRefKeys).toEqual([]);
        expect(history.canRedo()).toBe(false);
      }
      await move('undo');
      const clear = collectMarkupRemovals(doc, 0, clearMarkupAnnotationsOnPage);
      expect(clear.textMarkup.map(ref => ref.toKey())).toEqual(textMarkup.map(ref => ref.toKey()));
      expect(clear.legacy.map(ref => ref.toKey())).toEqual([inkRef.toKey()]);
    },
  );

  it('keeps legacy text, overlays, and session edits in one chronological history', async () => {
    const { doc, history, capture, content, sessionEdit, move } = await setup();
    await content('BT (first) Tj ET\n');
    history.push(capture('text-edit'));
    const beforeWatermark = await serializeDocument(doc);
    await sessionEdit('watermark', 'BT (first watermark) Tj ET\n');
    const watermarked = await serializeDocument(doc);
    await content('BT (second watermark) Tj ET\n');
    history.push(capture('text-edit'));
    const textEdited = await serializeDocument(doc);
    history.push(capture('add-text-box', [{ text: 'overlay' }]));
    await sessionEdit('replace-image', 'BT (replacement) Tj ET\n', [{ text: 'overlay' }]);
    const replaced = await serializeDocument(doc);

    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect((await move('undo'))?.label).toBe('add-text-box');
    expect(await serializeDocument(doc)).toEqual(textEdited);
    expect((await move('undo'))?.label).toBe('text-edit');
    expect((await move('undo'))?.label).toBe('watermark');
    expect(new TextDecoder().decode(getPageContentBytes(doc.pages[0], doc.objects)).trim())
      .toBe('BT (first watermark) Tj ET');
    expect((await move('undo'))?.label).toBe('text-edit');
    expect(await serializeDocument(doc)).toEqual(beforeWatermark);
    expect((await move('undo'))?.label).toBe('initial');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    expect((await move('redo'))?.label).toBe('text-edit');
    expect((await move('redo'))?.label).toBe('watermark');
    expect(await serializeDocument(doc)).toEqual(watermarked);
    expect((await move('redo'))?.label).toBe('text-edit');
    expect((await move('redo'))?.overlays.floatingTextsJson).toBe('[{"text":"overlay"}]');
    const replacementEntry = await move('redo');
    expect(replacementEntry?.label).toBe('replace-image');
    expect(replacementEntry?.overlays.floatingTextsJson).toBe('[{"text":"overlay"}]');
    expect(await serializeDocument(doc)).toEqual(replaced);
    expect(history.canRedo()).toBe(false);
  });

  it('discards session redo when a legacy edit branches from undo', async () => {
    const { history, capture, content, sessionEdit, move } = await setup();
    await sessionEdit('watermark', 'q Q\n');
    await move('undo');
    await content('0 0 10 10 re f\n');
    history.push(capture('text-edit'));
    expect(history.canRedo()).toBe(false);
    expect(await move('redo')).toBeUndefined();
    expect((await move('undo'))?.label).toBe('initial');
  });

  it('retains baked native content when export replaces a session snapshot', async () => {
    const { doc, history, capture, content, sessionEdit, move } = await setup();
    const original = await serializeDocument(doc);
    await sessionEdit('watermark', 'q Q\n');
    await content('q Q\n0 0 10 10 re f\n');
    history.replace(capture('commit-drawings'), true);
    expect((await move('undo'))?.label).toBe('initial');
    expect(await serializeDocument(doc)).toEqual(original);
    expect((await move('redo'))?.label).toBe('commit-drawings');
    expect(new TextDecoder().decode(getPageContentBytes(doc.pages[0], doc.objects)).trim())
      .toBe('q Q\n0 0 10 10 re f');
  });

  it('keeps session redo when export replaces the state below it', async () => {
    const { doc, history, capture, sessionEdit, move } = await setup();
    history.push(capture('add-text-box', [{ text: 'box' }]));
    await sessionEdit('watermark', 'q Q\n');
    const applied = await serializeDocument(doc);
    await move('undo');
    history.replace(capture('commit-drawings'), true);
    expect(history.canRedo()).toBe(true);
    await move('redo');
    expect(await serializeDocument(doc)).toEqual(applied);
  });

  it.each([false, true])('bakes text into a single toolbar boundary with an existing session: %s', async withSession => {
    const { doc, history, capture, content, sessionEdit, textBox, move } = await setup();
    const original = await serializeDocument(doc);
    history.push(capture('add-text-box', [{ text: 'Box' }]));
    if (withSession) await sessionEdit('watermark', 'q Q\n', [{ text: 'Box' }]);
    else await content('0 0 10 10 re f\n'); // Legacy drawing flattened before text.
    const editor = await textBox('Box');
    history.replace(capture('commit-drawings'), true, editor);
    const exported = await serializeDocument(doc);
    const reopened = await parsePDF(exported);
    expect(interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects)
      .textRuns.map(run => run.text)).toEqual(['Box']);
    for (let cycle = 0; cycle < 2; cycle++) {
      const undone = await move('undo');
      expect(undone?.label).toBe(withSession ? 'add-text-box' : 'initial');
      expect(undone?.overlays.floatingTextsJson).toBe(withSession ? '[{"text":"Box"}]' : '[]');
      expect(getPageContentBytes(doc.pages[0], doc.objects)).toEqual(new Uint8Array());
      if (withSession) expect(await serializeDocument(doc)).toEqual(original);
      expect((await move('redo'))?.overlays.floatingTextsJson).toBe('[]');
      expect(await serializeDocument(doc)).toEqual(exported);
      expect(history.canRedo()).toBe(false);
    }
  });

  it('restores baked text and font objects when undoing preserved session redo', async () => {
    const { doc, history, capture, textBox, move } = await setup();
    history.push(capture('add-text-box', [{ text: 'Box' }]));
    const later = await textBox('Later', 'Helvetica');
    history.push(capture('text-edit', [{ text: 'Box' }]), later);
    const laterBytes = await serializeDocument(doc);
    await move('undo');
    const baked = await textBox('Box', 'Courier');
    history.replace(capture('commit-drawings'), true, baked);
    const exported = await serializeDocument(doc);
    expect(history.canRedo()).toBe(true);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect((await move('redo'))?.overlays.floatingTextsJson).toBe('[{"text":"Box"}]');
      expect(await serializeDocument(doc)).toEqual(laterBytes);
      expect((await move('undo'))?.overlays.floatingTextsJson).toBe('[]');
      expect(await serializeDocument(doc)).toEqual(exported);
    }
  });

  it('preserves detached legacy page resources across session restoration', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
      '<< /Length 0 >>\nstream\nendstream',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
      '<< /Length 0 >>\nstream\nendstream',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]));
    const history = new SessionEditorHistory();
    history.seed(captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects), overlays, 'initial'));
    deletePage(doc, 1);
    history.push(captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects), overlays, 'delete-page'));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'watermark', staged => updatePageContent(
      staged.pages[0].contentRefs, new TextEncoder().encode('q Q\n'), staged.objects,
    ));
    history.push(captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects), overlays, 'watermark'), editor);
    await history.undo(doc);
    const deletedPageUndo = await history.undo(doc);
    if (!deletedPageUndo) throw new Error('Missing page-delete undo');
    await restoreDocumentStructure(doc, deletedPageUndo.entry, updatePageContent);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(reopened.pages.map(page => page.ref.toKey())).toEqual(['3_0', '5_0']);
    expect(reopened.objects.has('6_0')).toBe(true);
    expect(reopened.objects.has('7_0')).toBe(true);
  });
});
