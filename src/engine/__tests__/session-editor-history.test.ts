import { describe, expect, it } from 'vitest';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
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
  const move = async (direction: 'undo' | 'redo') => {
    const result = await history[direction](doc);
    if (result && !result.restoredDocument) await restoreDocumentStructure(doc, result.entry, updatePageContent);
    return result?.entry;
  };
  history.seed(capture('initial'));
  return { doc, history, capture, content, sessionEdit, move };
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
