import { addAnnotationToPage } from '../editor/annotation-engine';
import { insertImageRun } from '../editor/image-editor';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData } from '../types';
import type { VisualSignature } from '../signatures/visual/visual-types';
import { getNextObjNum } from '../writer/serializer';
import { removeMarkupReferences } from './document-edit';

/** Native visual signatures are stamps, not cryptographic signature fields. */
export function findVisualSignatureRefs(doc: PDFDocumentData, ids: ReadonlySet<string>): Map<string, PDFRef> {
  const found = new Map<string, PDFRef>();
  for (const page of doc.pages) {
    const entry = page.dict.get('Annots');
    const annots = entry instanceof PDFRef ? doc.objects.get(entry.toKey()) : entry;
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.items) {
      if (!(ref instanceof PDFRef)) continue;
      const dict = doc.objects.get(ref.toKey());
      if (!(dict instanceof PDFDict)) continue;
      const id = dict.get(dict.getName('Subtype') === 'Stamp' ? 'NM' : 'PaperloomSignatureId');
      if (id instanceof PDFString && ids.has(id.value)) found.set(id.value, ref);
    }
  }
  return found;
}

/** Remove the visual appearance only; never alter a field's cryptographic /V. */
export function removeVisualSignature(doc: PDFDocumentData, id: string): void {
  const ref = findVisualSignatureRefs(doc, new Set([id])).get(id);
  if (!ref) return;
  const dict = doc.objects.get(ref.toKey()) as PDFDict;
  if (dict.getName('Subtype') === 'Widget') {
    dict.delete('AP');
    dict.delete('PaperloomSignatureId');
    return;
  }
  for (let index = 0; index < doc.pages.length; index++) removeMarkupReferences(doc, index, [ref]);
}

/** Call only on a transaction draft. Image resources belong to the appearance,
 * so deletion cannot leave signature pixels reachable through page resources.
 */
export async function placeVisualSignature(
  doc: PDFDocumentData,
  signature: VisualSignature,
  imageDataUrl: string,
): Promise<void> {
  const page = doc.pages[signature.pageIndex];
  const resources = new PDFDict();
  const dict = new PDFDict();
  dict.set('Resources', resources);
  const appearancePage = { ...page, dict, resources, contentRefs: [] };
  const angle = signature.rotation * Math.PI / 180;
  const width = Math.abs(signature.width * Math.cos(angle)) + Math.abs(signature.height * Math.sin(angle));
  const height = Math.abs(signature.width * Math.sin(angle)) + Math.abs(signature.height * Math.cos(angle));
  const dx = (width - signature.width) / 2;
  const dy = (height - signature.height) / 2;
  // Image and soft-mask refs are reserved before either object is inserted.
  let nextObjNum = getNextObjNum(doc);
  const { newContentBytes } = await insertImageRun(
    new Uint8Array(), appearancePage, doc.objects, imageDataUrl,
    dx, dy + signature.height, signature.width, signature.height,
    () => nextObjNum++, { rotationDegrees: signature.rotation, opacity: signature.opacity },
  );
  const appearanceDict = new PDFDict();
  appearanceDict.set('Type', new PDFName('XObject'));
  appearanceDict.set('Subtype', new PDFName('Form'));
  appearanceDict.set('BBox', new PDFArray([0, 0, width, height].map(value => new PDFNumber(value))));
  appearanceDict.set('Resources', appearancePage.resources);
  appearanceDict.set('Length', new PDFNumber(newContentBytes.length));
  const appearanceRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(appearanceRef.toKey(), new PDFStream(appearanceDict, newContentBytes, newContentBytes));
  removeVisualSignature(doc, signature.id);
  const annotation = new PDFDict();
  annotation.set('Type', new PDFName('Annot'));
  annotation.set('Subtype', new PDFName('Stamp'));
  annotation.set('NM', new PDFString(signature.id));
  annotation.set('F', new PDFNumber(4));
  annotation.set('Rect', new PDFArray([
    signature.x - dx, signature.y - dy,
    signature.x - dx + width, signature.y - dy + height,
  ].map(value => new PDFNumber(value))));
  const ap = new PDFDict();
  ap.set('N', appearanceRef);
  annotation.set('AP', ap);
  const ref = new PDFRef(getNextObjNum(doc), 0);
  addAnnotationToPage(page.dict, annotation, ref, doc.objects);
}
