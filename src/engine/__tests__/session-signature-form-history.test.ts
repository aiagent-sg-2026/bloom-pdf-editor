import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
import { flattenFormFieldsOnPage, setFormFieldValue } from '../forms/apply-field';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import * as parser from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { placeVisualSignature, removeVisualSignature } from '../session/signature-edit';
import { createSignatureFieldAtPoint } from '../signatures/fields/signature-field';
import { createVisualSignature } from '../signatures/visual/signature-model';
import type { VisualSignature } from '../signatures/visual/visual-types';
import { serializeDocument } from '../writer/serializer';
import { installPNGEnvironment, rawPDF, tinyPNG } from './audit-p1-fixtures';

beforeEach(installPNGEnvironment);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup() {
  const doc = await parser.parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> /Contents 4 0 R /Annots 7 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
    '<< /Fields 6 0 R >>',
    '[8 0 R]',
    '[8 0 R]',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [10 10 100 30] /V (Before) /P 3 0 R >>',
  ]));
  await updatePageContent(doc.pages[0].contentRefs, new Uint8Array(), doc.objects);
  const history = new SessionEditorHistory();
  const capture = (label: string, signatures: VisualSignature[] = [], text: unknown[] = []) => captureHistoryEntry(
    doc, 0, parser.getPageContentBytes(doc.pages[0], doc.objects),
    { drawnPaths: [], floatingTexts: text, floatingImages: [], signatures }, label,
  );
  const move = async (direction: 'undo' | 'redo') => {
    const result = await history[direction](doc);
    if (result && !result.restoredDocument) await restoreDocumentStructure(doc, result.entry, updatePageContent);
    return result?.entry;
  };
  history.seed(capture('initial'));
  return { doc, history, capture, move };
}

describe('signature and form toolbar history', () => {
  it('orders creation, signature placement, values, removal, and flattening around legacy snapshots', async () => {
    const { doc, history, capture, move } = await setup();
    const before = await serializeDocument(doc);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('q 1 0 0 rg 0 0 5 5 re f Q\n'), doc.objects);
    history.push(capture('legacy-content'));
    const legacy = await serializeDocument(doc);
    const creation = new SessionDocumentEditor();
    await creation.edit(doc, 'create-form-field', async staged => {
      createSignatureFieldAtPoint(staged, 0, 120, 180, { fieldName: 'Approval' });
    });
    history.push(capture('create-form-field'), creation);
    const created = await serializeDocument(doc);
    const signature = createVisualSignature({ pageIndex: 0, x: 120, y: 120, appearanceId: 'draw', appearanceType: 'drawn' });
    const image = tinyPNG([10, 30, 60, 128]);
    const addition = new SessionDocumentEditor();
    await addition.edit(doc, 'add-signature', staged => placeVisualSignature(staged, signature, image));
    history.push(capture('add-signature', [signature]), addition);
    const placed = await serializeDocument(doc);
    history.push(capture('legacy-overlay', [signature], [{ text: 'Preview' }]));
    const value = new SessionDocumentEditor();
    await value.edit(doc, 'form-value', async staged => {
      setFormFieldValue(staged, detectFormFieldsOnPage(staged, 0).find(field => field.fieldName === 'Name')!, 'After');
    });
    history.push(capture('form-value', [signature], [{ text: 'Preview' }]), value);
    const changed = await serializeDocument(doc);
    const deletion = new SessionDocumentEditor();
    await deletion.edit(doc, 'delete-signature', async staged => { removeVisualSignature(staged, signature.id); });
    history.push(capture('delete-signature', [], [{ text: 'Preview' }]), deletion);
    const deleted = await serializeDocument(doc);
    const flattening = new SessionDocumentEditor();
    await flattening.edit(doc, 'flatten-forms', staged => flattenFormFieldsOnPage(staged, 0, detectFormFieldsOnPage(staged, 0)));
    history.push(capture('flatten-forms', [], [{ text: 'Preview' }]), flattening);
    const flattened = await serializeDocument(doc);
    expect(detectFormFieldsOnPage(await parser.parsePDF(flattened), 0)).toEqual([]);
    const states = [
      { label: 'initial', bytes: before },
      { label: 'legacy-content', bytes: legacy },
      { label: 'create-form-field', bytes: created },
      { label: 'add-signature', bytes: placed },
      { label: 'legacy-overlay', bytes: placed },
      { label: 'form-value', bytes: changed },
      { label: 'delete-signature', bytes: deleted },
      { label: 'flatten-forms', bytes: flattened },
    ];
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let index = states.length - 2; index >= 0; index--) {
        const entry = await move('undo');
        expect(entry?.label).toBe(states[index].label);
        expect(await serializeDocument(doc)).toEqual(states[index].bytes);
        if (entry?.label === 'legacy-overlay') {
          expect(JSON.parse(entry.overlays.signaturesJson)).toEqual([signature]);
          expect(entry.overlays.floatingTextsJson).toBe('[{"text":"Preview"}]');
        }
      }
      expect(history.canUndo()).toBe(false);
      for (let index = 1; index < states.length; index++) {
        expect((await move('redo'))?.label).toBe(states[index].label);
        expect(await serializeDocument(doc)).toEqual(states[index].bytes);
      }
      expect(history.canRedo()).toBe(false);
    }
    await move('undo');
    const failure = new Error('failed form branch');
    const failed = new SessionDocumentEditor();
    await expect(failed.edit(doc, 'form-value', async staged => {
      setFormFieldValue(staged, detectFormFieldsOnPage(staged, 0)[0], 'Must not publish');
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(deleted);
    expect(history.peek()?.label).toBe('delete-signature');
    expect(history.canRedo()).toBe(true);
    expect((await move('redo'))?.label).toBe('flatten-forms');
    expect(await serializeDocument(doc)).toEqual(flattened);
  });

  it('retains signature redo after failed replacement and retains toolbar position after failed restoration', async () => {
    const { doc, history, capture, move } = await setup();
    const before = await serializeDocument(doc);
    const signature = createVisualSignature({ pageIndex: 0, x: 120, y: 120, appearanceId: 'typed', appearanceType: 'typed' });
    const image = tinyPNG([60, 30, 10, 255]);
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'add-signature', staged => placeVisualSignature(staged, signature, image));
    history.push(capture('add-signature', [signature]), editor);
    const placed = await serializeDocument(doc);
    const failure = new Error('restore failed');
    vi.spyOn(parser, 'parsePDF').mockRejectedValueOnce(failure);
    await expect(history.undo(doc)).rejects.toBe(failure);
    expect(history.peek()?.label).toBe('add-signature');
    expect(await serializeDocument(doc)).toEqual(placed);
    expect(history.canUndo()).toBe(true);
    expect((await move('undo'))?.label).toBe('initial');
    expect(await serializeDocument(doc)).toEqual(before);
    const failed = new SessionDocumentEditor();
    await expect(failed.edit(doc, 'add-signature', async staged => {
      await placeVisualSignature(staged, { ...signature, rotation: 30 }, image);
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(history.canRedo()).toBe(true);
    expect((await move('redo'))?.label).toBe('add-signature');
    expect(await serializeDocument(doc)).toEqual(placed);
    vi.spyOn(parser, 'parsePDF').mockRejectedValueOnce(failure);
    await expect(history.undo(doc)).rejects.toBe(failure);
    expect(history.peek()?.label).toBe('add-signature');
    expect(await serializeDocument(doc)).toEqual(placed);
    await move('undo');
    vi.spyOn(parser, 'parsePDF').mockRejectedValueOnce(failure);
    await expect(history.redo(doc)).rejects.toBe(failure);
    expect(history.peek()?.label).toBe('initial');
    expect(await serializeDocument(doc)).toEqual(before);
    expect((await move('redo'))?.label).toBe('add-signature');
    expect(await serializeDocument(doc)).toEqual(placed);
  });
});
