/**
 * Invisible text layer — insert OCR words as Tr 3 (invisible) text for search/select.
 */

import {
  PDFDict,
  PDFName,
  PDFRef,
  PDFString,
  type PDFDocumentData,
} from '../types';
import { getPageContentBytes, resolveRef } from '../parser/parser';
import { updatePageContent, concatBytes } from './stream-compiler';
import { serializeToString } from './stream-compiler';
import { registerFontObject } from '../fonts/font-augmentation';

export interface InvisibleWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence?: number;
}

function ensureHelv(page: PDFDocumentData['pages'][0], objects: PDFDocumentData['objects']): void {
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  let fontDict = resources.get('Font');
  if (fontDict instanceof PDFRef) fontDict = resolveRef(fontDict, objects);
  if (!(fontDict instanceof PDFDict)) {
    fontDict = new PDFDict();
    resources.set('Font', fontDict);
  }
  if (!fontDict.has('Helv')) {
    const helvetica = new PDFDict();
    helvetica.set('Type', new PDFName('Font'));
    helvetica.set('Subtype', new PDFName('Type1'));
    helvetica.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('Helv', registerFontObject(objects, helvetica));
  }
}

/**
 * Insert an invisible text layer (render mode 3) aligned to word boxes.
 */
export async function insertInvisibleTextLayer(
  doc: PDFDocumentData,
  pageIndex: number,
  words: InvisibleWord[],
): Promise<void> {
  if (words.length === 0) return;
  const page = doc.pages[pageIndex];
  ensureHelv(page, doc.objects);

  const parts: string[] = ['\nq', 'BT', '3 Tr']; // Tr 3 = invisible
  for (const w of words) {
    if (!w.text.trim()) continue;
    const fontSize = Math.max(4, Math.min(72, w.bbox.height * 0.9));
    const escaped = serializeToString(new PDFString(w.text.slice(0, 200)));
    parts.push(`/Helv ${fontSize.toFixed(2)} Tf`);
    parts.push(`1 0 0 1 ${w.bbox.x.toFixed(2)} ${w.bbox.y.toFixed(2)} Tm`);
    parts.push(`${escaped} Tj`);
  }
  parts.push('ET', 'Q\n');

  const existing = getPageContentBytes(page, doc.objects);
  const injection = new TextEncoder().encode(parts.join('\n'));
  const merged = concatBytes(existing, injection);
  await updatePageContent(page.contentRefs, merged, doc.objects);
}
