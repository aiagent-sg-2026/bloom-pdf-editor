/**
 * Link annotation helpers — Acrobat-style URI links on text selections.
 */

import {
  PDFRef,
  type PDFDocumentData,
  type PDFRectangle,
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFString,
} from '../types';
import {
  createAnnotationDict,
  addAnnotationToPage,
  removeAnnotationFromPage,
  type LinkAnnotation,
} from './annotation-engine';
import { getNextObjNum } from '../writer/serializer';
import type { TextLine } from '../flow/types';
import {
  lineSelectionToQuadPoints,
  quadPointsToRect,
} from '../flow/selection-quads';
import { resolveRef } from '../parser/parser';

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Create a URI link annotation covering a character range on a line. */
export function addLinkFromLineSelection(
  doc: PDFDocumentData,
  pageIndex: number,
  line: TextLine,
  start: number,
  end: number,
  url: string,
): PDFRef | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const quadPoints = lineSelectionToQuadPoints(line, start, end);
  if (quadPoints.length === 0) return null;

  const bounds = quadPointsToRect(quadPoints);
  const page = doc.pages[pageIndex];
  const pageW = page.mediaBox.width || 612;
  const pageH = page.mediaBox.height || 792;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    bounds.width > pageW * 1.2 ||
    bounds.height > pageH * 0.25
  ) {
    return null;
  }

  const rect: PDFRectangle = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  const annot: LinkAnnotation = {
    type: 'Link',
    rect,
    color: [0.1, 0.35, 0.85],
    opacity: 1,
    url: normalized,
  };

  const objNum = getNextObjNum(doc);
  const { dict } = createAnnotationDict(annot, objNum, doc.objects);

  // Visible thin blue border so links are discoverable (Acrobat-like)
  dict.set('Border', new PDFArray([
    new PDFNumber(0),
    new PDFNumber(0),
    new PDFNumber(1),
  ]));
  dict.set('C', new PDFArray([
    new PDFNumber(0.1),
    new PDFNumber(0.35),
    new PDFNumber(0.85),
  ]));

  const ref = new PDFRef(objNum, 0);
  addAnnotationToPage(page.dict, dict, ref, doc.objects);
  return ref;
}

export interface PageLinkInfo {
  ref: PDFRef;
  url: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** List URI Link annotations on a page. */
export function listPageLinks(
  doc: PDFDocumentData,
  pageIndex: number,
): PageLinkInfo[] {
  const page = doc.pages[pageIndex];
  const annots = page.dict.get('Annots');
  let arr: PDFArray | null = null;
  if (annots instanceof PDFArray) arr = annots;
  else if (annots instanceof PDFRef) {
    const resolved = resolveRef(annots, doc.objects);
    if (resolved instanceof PDFArray) arr = resolved;
  }
  if (!arr) return [];

  const out: PageLinkInfo[] = [];
  for (const item of arr.items) {
    if (!(item instanceof PDFRef)) continue;
    const dict = resolveRef(item, doc.objects);
    if (!(dict instanceof PDFDict)) continue;
    const subtype = dict.get('Subtype');
    if (!(subtype instanceof PDFName) || subtype.name !== 'Link') continue;

    const rectObj = dict.get('Rect');
    if (!(rectObj instanceof PDFArray) || rectObj.items.length < 4) continue;
    const x0 = (rectObj.items[0] as PDFNumber).value;
    const y0 = (rectObj.items[1] as PDFNumber).value;
    const x1 = (rectObj.items[2] as PDFNumber).value;
    const y1 = (rectObj.items[3] as PDFNumber).value;

    let url = '';
    const action = dict.get('A');
    let actionDict = action;
    if (action instanceof PDFRef) actionDict = resolveRef(action, doc.objects);
    if (actionDict instanceof PDFDict) {
      const uri = actionDict.get('URI');
      if (uri instanceof PDFString) url = uri.value;
    }

    out.push({
      ref: item,
      url,
      rect: {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      },
    });
  }
  return out;
}

/** Hit-test page links at a PDF point. */
export function hitTestPageLink(
  doc: PDFDocumentData,
  pageIndex: number,
  pdfX: number,
  pdfY: number,
): PageLinkInfo | null {
  const links = listPageLinks(doc, pageIndex);
  for (let i = links.length - 1; i >= 0; i--) {
    const L = links[i];
    if (
      pdfX >= L.rect.x &&
      pdfX <= L.rect.x + L.rect.width &&
      pdfY >= L.rect.y &&
      pdfY <= L.rect.y + L.rect.height
    ) {
      return L;
    }
  }
  return null;
}

export function removePageLink(
  doc: PDFDocumentData,
  pageIndex: number,
  ref: PDFRef,
): void {
  const page = doc.pages[pageIndex];
  removeAnnotationFromPage(page.dict, ref, doc.objects);
}

/** Replace a link's URL in place (same rect). Returns the new ref, or null if removed. */
export function updatePageLinkUrl(
  doc: PDFDocumentData,
  pageIndex: number,
  link: PageLinkInfo,
  newUrl: string,
): PDFRef | null {
  removePageLink(doc, pageIndex, link.ref);
  const normalized = normalizeUrl(newUrl);
  if (!normalized) return null;

  const page = doc.pages[pageIndex];
  const annot: LinkAnnotation = {
    type: 'Link',
    rect: { ...link.rect },
    color: [0.1, 0.35, 0.85],
    opacity: 1,
    url: normalized,
  };
  const objNum = getNextObjNum(doc);
  const { dict } = createAnnotationDict(annot, objNum, doc.objects);
  dict.set('Border', new PDFArray([
    new PDFNumber(0),
    new PDFNumber(0),
    new PDFNumber(1),
  ]));
  dict.set('C', new PDFArray([
    new PDFNumber(0.1),
    new PDFNumber(0.35),
    new PDFNumber(0.85),
  ]));
  const ref = new PDFRef(objNum, 0);
  addAnnotationToPage(page.dict, dict, ref, doc.objects);
  return ref;
}

export { normalizeUrl };
