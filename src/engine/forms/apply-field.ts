/**
 * Apply and flatten AcroForm field values on document pages.
 */

import { getPageContentBytes, resolveRef } from '../parser/parser';
import { updatePageContent, concatBytes } from '../editor/stream-compiler';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFObject,
  PDFRef,
  PDFString,
  type PDFDocumentData,
} from '../types';
import type { AcroFormWidget } from './types';
import { flattenWidgets } from './flatten-field';
import { setTextFieldValue } from './text-appearance';

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

/** Set a field value and regenerate text/choice widgets on the same draft. */
export function setFormFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  value: string | boolean,
): void {
  const dict = widget.dict;
  if (typeof value === 'boolean') {
    dict.set('V', new PDFName(value ? 'Yes' : 'Off'));
    dict.set('AS', new PDFName(value ? 'Yes' : 'Off'));
  } else if (widget.fieldType === 'Tx' || widget.fieldType === 'Ch') {
    setTextFieldValue(doc, widget, value);
    return;
  } else {
    dict.set('V', new PDFString(value));
  }
  widget.value = value;
}

/** Remove widget annotation refs from a page /Annots array. */
export function removeWidgetAnnots(
  pageDict: PDFDict,
  removedRefs: PDFRef[],
  objects: Map<string, PDFObject>,
): void {
  const annotsRef = pageDict.get('Annots');
  if (!annotsRef) return;

  const annots = annotsRef instanceof PDFRef ? resolveRef(annotsRef, objects) : annotsRef;
  if (!(annots instanceof PDFArray)) return;

  const removeKeys = new Set(removedRefs.map(r => r.toKey()));
  const kept: PDFObject[] = [];
  for (let i = 0; i < annots.length; i++) {
    const ref = annots.get(i);
    if (ref instanceof PDFRef && removeKeys.has(ref.toKey())) continue;
    kept.push(ref!);
  }

  if (annotsRef instanceof PDFRef) {
    objects.set(annotsRef.toKey(), new PDFArray(kept));
  } else if (kept.length === 0) {
    pageDict.delete('Annots');
  } else {
    pageDict.set('Annots', new PDFArray(kept));
  }
}

/**
 * Flatten widgets on a page: bake appearances into content stream,
 * remove widget annotations.
 */
export async function flattenFormFieldsOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
  widgets: AcroFormWidget[],
): Promise<void> {
  if (widgets.length === 0) return;

  const page = doc.pages[pageIndex];
  const { content, removedRefs } = flattenWidgets(widgets);
  const existing = getPageContentBytes(page, doc.objects);
  const merged = concatBytes(existing, stringToBytes(`\n${content}`));
  await updatePageContent(page.contentRefs, merged, doc.objects);
  removeWidgetAnnots(page.dict, removedRefs, doc.objects);
  removeFields(doc, removedRefs);
}

/** Prune removed widgets and empty ancestors, preserving surviving field branches. */
function removeFields(doc: PDFDocumentData, removedRefs: PDFRef[]): void {
  const acroEntry = doc.catalog.get('AcroForm');
  const acro = acroEntry ? resolveRef(acroEntry, doc.objects) : undefined;
  if (!(acro instanceof PDFDict)) return;
  const removed = new Set(removedRefs.map(ref => ref.toKey()));
  const visited = new Set<string>();
  function prune(owner: PDFDict, key: string): void {
    const entry = owner.get(key);
    const array = entry ? resolveRef(entry, doc.objects) : undefined;
    if (!(array instanceof PDFArray)) return;
    const kept = array.items.filter(item => {
      if (!(item instanceof PDFRef)) return true;
      if (removed.has(item.toKey())) return false;
      const field = doc.objects.get(item.toKey());
      if (!(field instanceof PDFDict) || visited.has(item.toKey())) return true;
      visited.add(item.toKey());
      const hadKids = field.has('Kids');
      prune(field, 'Kids');
      const kidsEntry = field.get('Kids');
      const kids = kidsEntry ? resolveRef(kidsEntry, doc.objects) : undefined;
      return !hadKids || !(kids instanceof PDFArray) || kids.length > 0;
    });
    if (entry instanceof PDFRef) doc.objects.set(entry.toKey(), new PDFArray(kept));
    else owner.set(key, new PDFArray(kept));
  }
  prune(acro, 'Fields');
}
