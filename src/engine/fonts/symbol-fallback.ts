import { PDFDict, PDFName, PDFRef, type PDFObject, type PDFPageInfo } from '../types';
import { resolveRef } from '../parser/parser';
import { SYMBOL_TO_UNICODE, ZAPF_DINGBATS_TO_UNICODE } from './dingbat-encodings';
import { registerFontObject } from './font-augmentation';

export type BuiltInFallbackKind = 'Symbol' | 'ZapfDingbats';
export interface BuiltInFallbackGlyph { fontKind: BuiltInFallbackKind; code: number }

const reverse = new Map<string, BuiltInFallbackGlyph>();
for (const [code, unicode] of Object.entries(SYMBOL_TO_UNICODE)) {
  if (!reverse.has(unicode)) reverse.set(unicode, { fontKind: 'Symbol', code: Number(code) });
}
for (const [code, unicode] of Object.entries(ZAPF_DINGBATS_TO_UNICODE)) {
  if (!reverse.has(unicode)) reverse.set(unicode, { fontKind: 'ZapfDingbats', code: Number(code) });
}

/**
 * Glyph in the built-in Symbol / ZapfDingbats fonts for a character the text
 * font cannot show. Latin-1 characters (including ASCII digits, space, '±')
 * stay in the normal font so widths and look do not change.
 */
export function getBuiltInFallbackGlyph(char: string): BuiltInFallbackGlyph | null {
  const cp = char.codePointAt(0) ?? 0;
  if (cp <= 0xff) return null;
  return reverse.get(char) ?? null;
}

function fontDictFor(page: PDFPageInfo, objects: Map<string, PDFObject>): PDFDict {
  let resources = page.dict.get('Resources');
  if (resources instanceof PDFRef) resources = resolveRef(resources, objects);
  if (!(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  let fonts = resources.get('Font');
  if (fonts instanceof PDFRef) fonts = resolveRef(fonts, objects);
  if (!(fonts instanceof PDFDict)) {
    fonts = new PDFDict();
    resources.set('Font', fonts);
  }
  return fonts;
}

/** Install the non-embedded Standard 14 Symbol/ZapfDingbats Type1 face. */
export function ensureBuiltInFallbackFont(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  kind: BuiltInFallbackKind,
): string {
  const resourceName = kind === 'Symbol' ? 'SymAug' : 'DingAug';
  const fonts = fontDictFor(page, objects);
  if (!fonts.has(resourceName)) {
    const font = new PDFDict();
    font.set('Type', new PDFName('Font'));
    font.set('Subtype', new PDFName('Type1'));
    font.set('BaseFont', new PDFName(kind));
    // Built-in SymbolEncoding/ZapfDingbatsEncoding is selected by omission.
    fonts.set(resourceName, registerFontObject(objects, font));
  }
  return resourceName;
}

export function specialFallbackFontName(kind: BuiltInFallbackKind): string {
  return kind === 'Symbol' ? 'SymAug' : 'DingAug';
}
