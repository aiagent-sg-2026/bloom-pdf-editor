/**
 * Checkbox / radio / choice appearance regeneration and calculation order.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
} from '../types';
import { resolveRef } from '../parser/parser';
import { setFormFieldValue } from './apply-field';
import type { AcroFormWidget } from './types';
import { formText } from './text-appearance';
import { getNextObjNum } from '../writer/serializer';

function buildCheckAppearance(on: boolean, w: number, h: number): PDFStream {
  const content = on
    ? `q 0 0 0 rg 1 w 0 0 ${w} ${h} re S ${w * 0.2} ${h * 0.5} m ${w * 0.45} ${h * 0.2} l ${w * 0.8} ${h * 0.8} l S Q`
    : `q 0 0 0 rg 1 w 0 0 ${w} ${h} re S Q`;
  const bytes = new TextEncoder().encode(content);
  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Form'));
  dict.set('BBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(w), new PDFNumber(h),
  ]));
  dict.set('Length', new PDFNumber(bytes.length));
  return new PDFStream(dict, bytes, bytes);
}

/** Set checkbox/radio value and regenerate /AP On/Off appearances. */
export function setButtonFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  checked: boolean,
  onName = 'Yes',
): void {
  setFormFieldValue(doc, widget, checked);

  const w = widget.rect?.width ?? 12;
  const h = widget.rect?.height ?? 12;
  const onStream = buildCheckAppearance(true, w, h);
  const offStream = buildCheckAppearance(false, w, h);

  const onRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(onRef.toKey(), onStream);
  const offRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(offRef.toKey(), offStream);

  const nDict = new PDFDict();
  nDict.set(onName, onRef);
  nDict.set('Off', offRef);

  const ap = new PDFDict();
  ap.set('N', nDict);
  widget.dict.set('AP', ap);
  widget.dict.set('AS', new PDFName(checked ? onName : 'Off'));
  widget.dict.set('V', new PDFName(checked ? onName : 'Off'));
}

/** Set a choice (dropdown/list) field value. */
export function setChoiceFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  value: string,
): void {
  setFormFieldValue(doc, widget, value);
}

/** Mark NeedAppearances so viewers regenerate widget appearances. */
export function regenerateNeedAppearances(doc: PDFDocumentData, value = true): void {
  const catalog = doc.catalog;
  let acro = catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
  if (!(acro instanceof PDFDict)) {
    acro = new PDFDict();
    acro.set('Fields', new PDFArray([]));
    catalog.set('AcroForm', acro);
  }
  acro.set('NeedAppearances', new PDFBoolean(value));
}

/**
 * Basic /CO calculation: sum or product of sibling numeric field values.
 */
export function runCalculationOrder(
  doc: PDFDocumentData,
  widgets: AcroFormWidget[],
): void {
  const byName = new Map<string, AcroFormWidget>();
  for (const w of widgets) {
    if (w.fieldName) byName.set(w.fieldName, w);
  }

  let acro = doc.catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
  if (!(acro instanceof PDFDict)) return;
  const co = acro.get('CO');

  if (!(co instanceof PDFArray)) {
    for (const w of widgets) {
      const name = w.fieldName ?? '';
      if (/^(total|sum)/i.test(name)) {
        let sum = 0;
        for (const other of widgets) {
          if (other === w) continue;
          const v = other.value;
          const n = typeof v === 'string' ? parseFloat(v) : NaN;
          if (!Number.isNaN(n)) sum += n;
        }
        setFormFieldValue(doc, w, String(sum));
      }
    }
    return;
  }

  for (let i = 0; i < co.length; i++) {
    const ref = co.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const dict = resolveRef(ref, doc.objects);
    if (!(dict instanceof PDFDict)) continue;
    const name = formText(dict.get('T'));
    const target = byName.get(name);
    if (!target) continue;

    let sum = 0;
    let product = 1;
    let hasProduct = false;
    for (const other of widgets) {
      if (other.fieldName === name) continue;
      const v = other.value;
      const n = typeof v === 'string' ? parseFloat(v) : NaN;
      if (Number.isNaN(n)) continue;
      sum += n;
      product *= n;
      hasProduct = true;
    }
    const useProduct = /prod|multiply/i.test(name);
    setFormFieldValue(doc, target, String(useProduct && hasProduct ? product : sum));
  }
}
