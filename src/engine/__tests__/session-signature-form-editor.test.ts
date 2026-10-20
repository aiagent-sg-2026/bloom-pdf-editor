import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { detectFormFieldsOnPage, parseAcroFormCatalog } from '../forms/detect-fields';
import { flattenFormFieldsOnPage, setFormFieldValue } from '../forms/apply-field';
import { setButtonFieldValue, setChoiceFieldValue } from '../forms/widget-appearances';
import { decodeImage } from '../render/image-decoder';
import { SessionDocumentEditor } from '../session/document-edit';
import { findVisualSignatureRefs, placeVisualSignature, removeVisualSignature } from '../session/signature-edit';
import { applySignatureFieldAppearance } from '../signatures/fields/appearance-stream';
import { createSignatureFieldAtPoint } from '../signatures/fields/signature-field';
import { createVisualSignature } from '../signatures/visual/signature-model';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, PDFString, type PDFDocumentData } from '../types';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { installPNGEnvironment, rawPDF, tinyJPEG, tinyPNG } from './audit-p1-fixtures';

function fixture(indirect: boolean): Uint8Array {
  return rawPDF([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm ${indirect ? '5 0 R' : '<< /Fields [8 0 R 9 0 R 10 0 R] >>'} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> /Contents 4 0 R /Annots ${indirect ? '7 0 R' : '[8 0 R 9 0 R 10 0 R]'} >>`,
    '<< /Length 0 >>\nstream\nendstream',
    '<< /Fields 6 0 R >>',
    '[8 0 R 9 0 R 10 0 R]',
    '[8 0 R 9 0 R 10 0 R]',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [10 10 100 30] /V (Before) /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (Check) /Rect [10 40 30 60] /V /Off /AS /Off /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Ch /T (Choice) /Rect [10 70 100 90] /Opt [(A) (B)] /V (A) /P 3 0 R >>',
  ]);
}

function array(doc: PDFDocumentData, entry: unknown): PDFArray {
  const value = entry instanceof PDFRef ? doc.objects.get(entry.toKey()) : entry;
  if (!(value instanceof PDFArray)) throw new Error('Expected PDF array');
  return value;
}

beforeEach(installPNGEnvironment);
afterEach(() => vi.unstubAllGlobals());

describe('signature and AcroForm session boundaries', () => {
  it.each([
    { appearanceType: 'drawn' as const, rotation: 0, opacity: 1, indirect: false, jpeg: false,
      pixels: [20, 40, 80, 255], rect: [90, 135, 150, 165] },
    { appearanceType: 'typed' as const, rotation: 90, opacity: 0.4, indirect: true, jpeg: false,
      pixels: [20, 40, 80, 128, 0, 0, 0, 0], rect: [105, 120, 135, 180] },
    { appearanceType: 'uploaded' as const, rotation: 0, opacity: 0.7, indirect: true, jpeg: true,
      pixels: [], rect: [90, 135, 150, 165] },
  ])('round-trips $appearanceType signature placement, geometry, pixels, and removal', async ({ appearanceType, rotation, opacity, indirect, jpeg, pixels, rect: expectedRect }) => {
    if (jpeg) {
      vi.stubGlobal('Image', class {
        naturalWidth = 1;
        naturalHeight = 1;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_url: string) { this.onload?.(); }
      });
    }
    const doc = await parsePDF(fixture(indirect));
    const original = await serializeDocument(doc);
    const upload = doc.rawBytes;
    const signature = createVisualSignature({
      pageIndex: 0, x: 120, y: 150, width: 60, height: 30,
      appearanceId: 'library', appearanceType, rotation, opacity,
    });
    const image = jpeg ? `data:image/jpeg;base64,${Buffer.from(tinyJPEG()).toString('base64')}` : tinyPNG(pixels);
    const editor = new SessionDocumentEditor();
    const failure = new Error('signature staging failed');
    await expect(editor.edit(doc, 'add-signature', async staged => {
      await placeVisualSignature(staged, signature, image);
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(original);
    expect(editor.canUndo).toBe(false);
    await editor.edit(doc, 'add-signature', staged => placeVisualSignature(staged, signature, image));
    const placed = await serializeDocument(doc);
    const inspect = async (target: PDFDocumentData) => {
      const ref = findVisualSignatureRefs(target, new Set([signature.id])).get(signature.id)!;
      const stamp = target.objects.get(ref.toKey()) as PDFDict;
      expect(stamp.getName('Subtype')).toBe('Stamp');
      const rect = stamp.getArray('Rect')!.asNumbers();
      for (const [index, expected] of expectedRect.entries()) expect(rect[index]).toBeCloseTo(expected);
      const appearance = target.objects.get(stamp.getDict('AP')!.getRef('N')!.toKey()) as PDFStream;
      expect(appearance.dict.getName('Subtype')).toBe('Form');
      const resources = appearance.dict.getDict('Resources')!;
      const page = { ...target.pages[0], resources };
      const imageItem = interpretPage(appearance.getBytes(), page, target.objects).displayList.find(item => item.type === 'image');
      if (!imageItem || imageItem.type !== 'image') throw new Error('Signature image missing');
      expect(imageItem.fillAlpha).toBe(opacity);
      const imageRef = resources.getDict('XObject')!.getRef('Im1')!;
      const imageStream = target.objects.get(imageRef.toKey()) as PDFStream;
      if (jpeg) {
        expect(imageStream.dict.getName('Filter')).toBe('DCTDecode');
        expect(imageStream.rawBytes).toEqual(tinyJPEG());
      } else {
        expect(Array.from((await decodeImage(imageStream, target.objects))!.data)).toEqual(pixels);
        expect(imageStream.dict.has('SMask')).toBe(pixels.some((value, index) => index % 4 === 3 && value < 255));
      }
      expect(parseAcroFormCatalog(target)!.fields.map(field => field.fullName)).toEqual(['Name', 'Check', 'Choice']);
    };
    await inspect(doc);
    await inspect(await parsePDF(placed));
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await editor.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(original);
      expect(await editor.redo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(placed);
    }
    const removal = new SessionDocumentEditor();
    await expect(removal.edit(doc, 'delete-signature', async staged => {
      removeVisualSignature(staged, signature.id);
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(placed);
    await removal.edit(doc, 'delete-signature', async staged => { removeVisualSignature(staged, signature.id); });
    const removed = await serializeDocument(doc);
    const reopened = await parsePDF(removed);
    expect(array(reopened, reopened.pages[0].dict.get('Annots')).items).toEqual([new PDFRef(8, 0), new PDFRef(9, 0), new PDFRef(10, 0)]);
    expect([...reopened.objects.values()].filter(object => object instanceof PDFStream && object.dict.getName('Subtype') === 'Image')).toEqual([]);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await removal.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(placed);
      expect(await removal.redo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(removed);
    }
    expect(doc.rawBytes).toBe(upload);
  });

  it('replaces only the selected signature and rolls back a failed replacement', async () => {
    const doc = await parsePDF(fixture(true));
    const signature = createVisualSignature({ pageIndex: 0, x: 80, y: 160, appearanceId: 'first', appearanceType: 'drawn' });
    const sibling = createVisualSignature({ pageIndex: 0, x: 180, y: 160, appearanceId: 'second', appearanceType: 'typed' });
    const firstImage = tinyPNG([10, 20, 30, 255]);
    await placeVisualSignature(doc, signature, firstImage);
    await placeVisualSignature(doc, sibling, tinyPNG([40, 50, 60, 255]));
    const ids = new Set([signature.id, sibling.id]);
    const siblingRef = findVisualSignatureRefs(doc, ids).get(sibling.id)!;
    const before = await serializeDocument(doc);
    const replacement = new SessionDocumentEditor();
    const changed = { ...signature, x: signature.x + 10, opacity: 0.5 };
    const apply = async (staged: PDFDocumentData) => {
      await placeVisualSignature(staged, changed, tinyPNG([200, 100, 50, 128]));
    };
    const failure = new Error('replacement failed');
    await expect(replacement.edit(doc, 'move-signature', async staged => { await apply(staged); throw failure; })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(before);
    await replacement.edit(doc, 'move-signature', apply);
    const after = await serializeDocument(doc);
    const refs = findVisualSignatureRefs(doc, ids);
    expect(refs.get(sibling.id)).toEqual(siblingRef);
    const annots = array(doc, doc.pages[0].dict.get('Annots'));
    expect(annots.items.filter(ref => {
      const annotation = ref instanceof PDFRef ? doc.objects.get(ref.toKey()) : undefined;
      const id = annotation instanceof PDFDict ? annotation.get('NM') : undefined;
      return id instanceof PDFString && id.value === signature.id;
    })).toEqual([refs.get(signature.id)]);
    for (let cycle = 0; cycle < 2; cycle++) {
      await replacement.undo(doc);
      expect(await serializeDocument(doc)).toEqual(before);
      await replacement.redo(doc);
      expect(await serializeDocument(doc)).toEqual(after);
    }
  });

  it.each([false, true])('appends and removes fields without losing siblings with indirect arrays=%s', async indirect => {
    const doc = await parsePDF(fixture(indirect));
    const before = await serializeDocument(doc);
    const creation = new SessionDocumentEditor();
    const create = async (staged: PDFDocumentData) => {
      createSignatureFieldAtPoint(staged, 0, 140, 160, { fieldName: 'Approval' });
    };
    const failure = new Error('field creation failed');
    await expect(creation.edit(doc, 'create-form-field', async staged => { await create(staged); throw failure; })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(creation.canUndo).toBe(false);
    await creation.edit(doc, 'create-form-field', create);
    const created = await serializeDocument(doc);
    const reopened = await parsePDF(created);
    expect(detectFormFieldsOnPage(reopened, 0).map(field => field.fieldName)).toEqual(['Name', 'Check', 'Choice', 'Approval']);
    if (indirect) {
      expect(parseAcroFormCatalog(reopened)!.dict.get('Fields')).toEqual(new PDFRef(6, 0));
      expect(reopened.pages[0].dict.get('Annots')).toEqual(new PDFRef(7, 0));
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await creation.undo(doc);
      expect(await serializeDocument(doc)).toEqual(before);
      await creation.redo(doc);
      expect(await serializeDocument(doc)).toEqual(created);
    }
    const removal = new SessionDocumentEditor();
    const flatten = async (staged: PDFDocumentData) => {
      const widget = detectFormFieldsOnPage(staged, 0).find(field => field.fieldName === 'Name')!;
      await flattenFormFieldsOnPage(staged, 0, [widget]);
    };
    await expect(removal.edit(doc, 'flatten-forms', async staged => { await flatten(staged); throw failure; })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(created);
    await removal.edit(doc, 'flatten-forms', flatten);
    const removed = await serializeDocument(doc);
    const flattened = await parsePDF(removed);
    expect(detectFormFieldsOnPage(flattened, 0).map(field => field.fieldName)).toEqual(['Check', 'Choice', 'Approval']);
    expect(array(flattened, flattened.pages[0].dict.get('Annots')).items).not.toContainEqual(new PDFRef(8, 0));
    expect(new TextDecoder().decode(getPageContentBytes(flattened.pages[0], flattened.objects))).toContain('(Before)');
    for (let cycle = 0; cycle < 2; cycle++) {
      await removal.undo(doc);
      expect(await serializeDocument(doc)).toEqual(created);
      await removal.redo(doc);
      expect(await serializeDocument(doc)).toEqual(removed);
    }
  });

  it.each(['Tx', 'Btn', 'Ch'] as const)('isolates %s value failures and restores exact value/appearance bytes', async fieldType => {
    const doc = await parsePDF(fixture(true));
    const before = await serializeDocument(doc);
    const originalWidget = detectFormFieldsOnPage(doc, 0).find(field => field.fieldType === fieldType)!;
    const originalDict = originalWidget.dict;
    const editor = new SessionDocumentEditor();
    const apply = async (staged: PDFDocumentData) => {
      const widget = detectFormFieldsOnPage(staged, 0).find(field => field.ref.toKey() === originalWidget.ref.toKey())!;
      expect(widget.dict).not.toBe(originalDict);
      if (fieldType === 'Btn') setButtonFieldValue(staged, widget, true);
      else if (fieldType === 'Ch') setChoiceFieldValue(staged, widget, 'B');
      else setFormFieldValue(staged, widget, 'After');
    };
    const failure = new Error('value staging failed');
    await expect(editor.edit(doc, 'form-value', async staged => { await apply(staged); throw failure; })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(editor.canUndo).toBe(false);
    await editor.edit(doc, 'form-value', apply);
    const after = await serializeDocument(doc);
    expect(detectFormFieldsOnPage(await parsePDF(after), 0).find(field => field.fieldType === fieldType)!.value)
      .toBe(fieldType === 'Btn' ? 'Yes' : fieldType === 'Ch' ? 'B' : 'After');
    for (let cycle = 0; cycle < 2; cycle++) {
      await editor.undo(doc);
      expect(await serializeDocument(doc)).toEqual(before);
      await editor.redo(doc);
      expect(await serializeDocument(doc)).toEqual(after);
    }
  });

  it('removes a placed field appearance without removing its field or cryptographic value', async () => {
    const doc = await parsePDF(fixture(true));
    const field = createSignatureFieldAtPoint(doc, 0, 120, 160);
    const valueRef = new PDFRef(getNextObjNum(doc), 0);
    doc.objects.set(valueRef.toKey(), new PDFDict([['Type', new PDFName('Sig')]]));
    (doc.objects.get(field.ref.toKey()) as PDFDict).set('V', valueRef);
    const before = await serializeDocument(doc);
    const appearance = new SessionDocumentEditor();
    const apply = async (staged: PDFDocumentData) => {
      applySignatureFieldAppearance(staged, field.ref, { width: 160, height: 60, typedName: 'Signer' });
      const dict = staged.objects.get(field.ref.toKey()) as PDFDict;
      dict.set('PaperloomSignatureId', new PDFString('visual-field'));
    };
    const failure = new Error('appearance failed');
    await expect(appearance.edit(doc, 'place-in-field', async staged => { await apply(staged); throw failure; })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(appearance.canUndo).toBe(false);
    await appearance.edit(doc, 'place-in-field', apply);
    const placed = await serializeDocument(doc);
    const removal = new SessionDocumentEditor();
    await removal.edit(doc, 'delete-signature', async staged => { removeVisualSignature(staged, 'visual-field'); });
    const removed = await serializeDocument(doc);
    expect((doc.objects.get(field.ref.toKey()) as PDFDict).has('AP')).toBe(false);
    expect((doc.objects.get(field.ref.toKey()) as PDFDict).getRef('V')).toEqual(valueRef);
    expect(detectFormFieldsOnPage(doc, 0).some(widget => widget.ref.toKey() === field.ref.toKey())).toBe(true);
    await removal.undo(doc);
    expect(await serializeDocument(doc)).toEqual(placed);
    await removal.redo(doc);
    expect(await serializeDocument(doc)).toEqual(removed);
    await removal.undo(doc);
    await appearance.undo(doc);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('restores the absence of AcroForm after undoing first-field creation', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> /Contents 4 0 R >>',
      '<< /Length 0 >>\nstream\nendstream',
    ]));
    const before = await serializeDocument(doc);
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'create-form-field', async staged => {
      createSignatureFieldAtPoint(staged, 0, 120, 180);
    });
    const after = await serializeDocument(doc);
    expect(detectFormFieldsOnPage(await parsePDF(after), 0).map(widget => widget.fieldType)).toEqual(['Sig']);
    for (let cycle = 0; cycle < 2; cycle++) {
      await editor.undo(doc);
      expect(doc.catalog.has('AcroForm')).toBe(false);
      expect(doc.pages[0].dict.has('Annots')).toBe(false);
      expect(await serializeDocument(doc)).toEqual(before);
      await editor.redo(doc);
      expect(await serializeDocument(doc)).toEqual(after);
    }
  });

  it('prunes indirect Kids only when the last widget in a field branch is removed', async () => {
    const doc = await parsePDF(fixture(true));
    const parentRef = new PDFRef(11, 0);
    const kidsRef = new PDFRef(12, 0);
    doc.objects.set(parentRef.toKey(), new PDFDict([
      ['T', new PDFString('Group')], ['Kids', kidsRef],
    ]));
    doc.objects.set(kidsRef.toKey(), new PDFArray([new PDFRef(8, 0), new PDFRef(9, 0)]));
    doc.objects.set('6_0', new PDFArray([parentRef, new PDFRef(10, 0)]));
    const before = await serializeDocument(doc);
    const first = new SessionDocumentEditor();
    await first.edit(doc, 'flatten-forms', staged => flattenFormFieldsOnPage(
      staged, 0, detectFormFieldsOnPage(staged, 0).filter(widget => widget.ref.toKey() === '8_0'),
    ));
    const oneRemoved = await serializeDocument(doc);
    expect(array(doc, (doc.objects.get(parentRef.toKey()) as PDFDict).get('Kids')).items).toEqual([new PDFRef(9, 0)]);
    expect(parseAcroFormCatalog(doc)!.fields.map(field => field.fullName)).toEqual(['Group', 'Choice']);
    const last = new SessionDocumentEditor();
    await last.edit(doc, 'flatten-forms', staged => flattenFormFieldsOnPage(
      staged, 0, detectFormFieldsOnPage(staged, 0).filter(widget => widget.ref.toKey() === '9_0'),
    ));
    const branchRemoved = await serializeDocument(doc);
    expect(parseAcroFormCatalog(await parsePDF(branchRemoved))!.fields.map(field => field.fullName)).toEqual(['Choice']);
    expect(array(doc, doc.pages[0].dict.get('Annots')).items).toEqual([new PDFRef(10, 0)]);
    await last.undo(doc);
    expect(await serializeDocument(doc)).toEqual(oneRemoved);
    await first.undo(doc);
    expect(await serializeDocument(doc)).toEqual(before);
    await first.redo(doc);
    expect(await serializeDocument(doc)).toEqual(oneRemoved);
    await last.redo(doc);
    expect(await serializeDocument(doc)).toEqual(branchRemoved);
  });
});
