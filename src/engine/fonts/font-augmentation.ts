/**
 * Font augmentation — subset-embed a fallback Standard14 font
 * when the user types glyphs missing from the page font.
 */

import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
  type PDFPageInfo,
  type PDFObject,
} from '../types';
import { resolveRef } from '../parser/parser';
import { getNextObjNum } from '../writer/serializer';

const FALLBACK_FONT = 'HelvAug';
const FALLBACK_FONT_BOLD = 'HelvAugBold';
const FALLBACK_FONT_OBLIQUE = 'HelvAugOblique';
const FALLBACK_FONT_BOLD_OBLIQUE = 'HelvAugBoldOblique';
const registeredFonts = new WeakMap<Map<string, PDFObject>, Set<string>>();

/** Newly indirect fonts must join explicitly incremental saves, including worker saves. */
export function registeredFontKeys(objects: Map<string, PDFObject>): ReadonlySet<string> {
  return registeredFonts.get(objects) ?? new Set<string>();
}

/** Store a font outside resource dictionaries so readers can identify its xref entry. */
export function registerFontObject(
  objects: Map<string, PDFObject>, font: PDFDict, minimumObjectNumber = 1,
): PDFRef {
  let next = minimumObjectNumber;
  for (const key of objects.keys()) next = Math.max(next, Number.parseInt(key.split('_')[0], 10) + 1);
  const ref = new PDFRef(next, 0);
  objects.set(ref.toKey(), font);
  let keys = registeredFonts.get(objects);
  if (!keys) registeredFonts.set(objects, keys = new Set<string>());
  keys.add(ref.toKey());
  return ref;
}

/**
 * Ensure a Helvetica Type1 fallback font exists in page Resources.
 * Preserves bold/italic of the source run so mid-line edits don't drop weight.
 * Returns the resource font name to use for missing glyphs.
 */
export function ensureFallbackFont(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  style?: { bold?: boolean; italic?: boolean },
): string {
  const wantBold = !!style?.bold;
  const wantItalic = !!style?.italic;
  let resourceName = FALLBACK_FONT;
  let baseFont = 'Helvetica';
  if (wantBold && wantItalic) {
    resourceName = FALLBACK_FONT_BOLD_OBLIQUE;
    baseFont = 'Helvetica-BoldOblique';
  } else if (wantBold) {
    resourceName = FALLBACK_FONT_BOLD;
    baseFont = 'Helvetica-Bold';
  } else if (wantItalic) {
    resourceName = FALLBACK_FONT_OBLIQUE;
    baseFont = 'Helvetica-Oblique';
  }

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

  if (!fontDict.has(resourceName)) {
    const helvetica = new PDFDict();
    helvetica.set('Type', new PDFName('Font'));
    helvetica.set('Subtype', new PDFName('Type1'));
    helvetica.set('BaseFont', new PDFName(baseFont));
    helvetica.set('Encoding', new PDFName('WinAnsiEncoding'));
    fontDict.set(resourceName, registerFontObject(objects, helvetica));
  }

  return resourceName;
}

/**
 * Build a minimal ToUnicode CMap stream for WinAnsi-ish single-byte codes.
 */
export function buildSimpleToUnicodeCMap(
  doc: PDFDocumentData,
  mapping: Map<number, string>,
): PDFRef {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
  ];

  const entries = Array.from(mapping.entries());
  if (entries.length > 0) {
    lines.push(`${entries.length} beginbfchar`);
    for (const [code, ch] of entries) {
      const hex = code.toString(16).padStart(2, '0').toUpperCase();
      const cp = ch.codePointAt(0) ?? 0x3f;
      const uhex = cp.toString(16).padStart(4, '0').toUpperCase();
      lines.push(`<${hex}> <${uhex}>`);
    }
    lines.push('endbfchar');
  }

  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');

  const content = lines.join('\n');
  const bytes = new TextEncoder().encode(content);
  const dict = new PDFDict();
  dict.set('Length', new PDFNumber(bytes.length));
  const stream = new PDFStream(dict, bytes, bytes);
  const ref = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), stream);
  return ref;
}

/**
 * After a text edit reports missing char codes, attach fallback font to the page.
 */
export function augmentFontsForMissingGlyphs(
  doc: PDFDocumentData,
  pageIndex: number,
  missingChars: string,
): string {
  const page = doc.pages[pageIndex];
  const fontName = ensureFallbackFont(page, doc.objects);

  const mapping = new Map<number, string>();
  for (const ch of missingChars) {
    const code = ch.charCodeAt(0);
    if (code < 256) mapping.set(code, ch);
  }

  if (mapping.size > 0) {
    try {
      buildSimpleToUnicodeCMap(doc, mapping);
    } catch {
      // Non-fatal
    }
  }

  return fontName;
}
