import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
import { insertTextRun } from '../editor/text-editor';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { deletePage } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
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
