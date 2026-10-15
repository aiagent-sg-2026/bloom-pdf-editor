import { assetUrl } from './asset-url';
import { UnsupportedGlyphsError } from './unsupported-glyphs';

export type ShapingFontId = 'thai' | 'devanagari' | 'bengali' | 'tamil' | 'telugu' | 'kannada' | 'malayalam' | 'gujarati' | 'gurmukhi';
export type HanFontId = 'sc' | 'tc' | 'jp' | 'kr';
export type ScriptFontId = HanFontId | 'latin' | ShapingFontId;
export const SHAPING_SCRIPTS = {
  thai: 'Thai', devanagari: 'Deva', bengali: 'Beng', tamil: 'Taml', telugu: 'Telu',
  kannada: 'Knda', malayalam: 'Mlym', gujarati: 'Gujr', gurmukhi: 'Guru',
} as const;
export function isShapingFont(id: ScriptFontId): id is ShapingFontId { return id in SHAPING_SCRIPTS; }
export interface ScriptFontOptions { preferredHanFont?: HanFontId }
export interface ScriptFontRun { fontId: ScriptFontId; text: string }

/** Static glyf assets; complex-script sources retain GSUB/GPOS for shaping. */
export const SCRIPT_FONTS = {
  sc: { assetPath: assetUrl('fonts/NotoSansSC-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansSC-OFL.txt'), baseFont: 'NotoSansSC' },
  tc: { assetPath: assetUrl('fonts/NotoSansTC-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansTC-OFL.txt'), baseFont: 'NotoSansTC' },
  jp: { assetPath: assetUrl('fonts/NotoSansJP-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansJP-OFL.txt'), baseFont: 'NotoSansJP' },
  kr: { assetPath: assetUrl('fonts/NotoSansKR-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansKR-OFL.txt'), baseFont: 'NotoSansKR' },
  latin: { assetPath: assetUrl('fonts/NotoSans-Regular.ttf'), licensePath: assetUrl('fonts/NotoSans-OFL.txt'), baseFont: 'NotoSans' },
  thai: { assetPath: assetUrl('fonts/NotoSansThai-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansThai-OFL.txt'), baseFont: 'NotoSansThai' },
  devanagari: { assetPath: assetUrl('fonts/NotoSansDevanagari-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansDevanagari-OFL.txt'), baseFont: 'NotoSansDevanagari' },
  bengali: { assetPath: assetUrl('fonts/NotoSansBengali-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansBengali-OFL.txt'), baseFont: 'NotoSansBengali' },
  tamil: { assetPath: assetUrl('fonts/NotoSansTamil-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansTamil-OFL.txt'), baseFont: 'NotoSansTamil' },
  telugu: { assetPath: assetUrl('fonts/NotoSansTelugu-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansTelugu-OFL.txt'), baseFont: 'NotoSansTelugu' },
  kannada: { assetPath: assetUrl('fonts/NotoSansKannada-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansKannada-OFL.txt'), baseFont: 'NotoSansKannada' },
  malayalam: { assetPath: assetUrl('fonts/NotoSansMalayalam-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansMalayalam-OFL.txt'), baseFont: 'NotoSansMalayalam' },
  gujarati: { assetPath: assetUrl('fonts/NotoSansGujarati-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansGujarati-OFL.txt'), baseFont: 'NotoSansGujarati' },
  gurmukhi: { assetPath: assetUrl('fonts/NotoSansGurmukhi-Regular.ttf'), licensePath: assetUrl('fonts/NotoSansGurmukhi-OFL.txt'), baseFont: 'NotoSansGurmukhi' },
} as const;

const chains: Record<ScriptFontId, readonly ScriptFontId[]> = {
  sc: ['sc', 'tc', 'jp', 'kr'],
  tc: ['tc', 'sc', 'jp', 'kr'],
  jp: ['jp', 'sc', 'tc', 'kr'],
  kr: ['kr', 'sc', 'tc', 'jp'],
  latin: ['latin', 'sc', 'tc', 'jp', 'kr'],
  thai: ['thai'], devanagari: ['devanagari'], bengali: ['bengali'], tamil: ['tamil'],
  telugu: ['telugu'], kannada: ['kannada'], malayalam: ['malayalam'], gujarati: ['gujarati'], gurmukhi: ['gurmukhi'],
};
export function fontFallbackChain(id: ScriptFontId): readonly ScriptFontId[] { return chains[id]; }

export function scriptFontId(baseFont: string): ScriptFontId | undefined {
  if (!/^[A-Z]{6}\+/.test(baseFont)) return undefined;
  for (const id of Object.keys(SCRIPT_FONTS) as ScriptFontId[]) {
    if (baseFont.slice(7) === SCRIPT_FONTS[id].baseFont) return id;
  }
  return undefined;
}

const kana = /[\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70]/u;
const hangul = /\p{Script=Hangul}/u;
const han = /\p{Script=Han}/u;
const cjkPunctuation = /[\u3000-\u303f\uff01-\uff60]/u;
const latin = /\p{Script=Latin}/u;
const combining = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\ufe20-\ufe2f]/u;
const neutral = /[\u0020-\u007e\p{Separator}\u0009-\u000d\u2000-\u206f\u20a0-\u20cf\u2100-\u2bff]/u;
const pictograph = /\p{Extended_Pictographic}/u;
const rtlControl = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const blocks: readonly [number, number, ShapingFontId][] = [
  [0x0e00, 0x0e7f, 'thai'], [0x0900, 0x097f, 'devanagari'], [0x0980, 0x09ff, 'bengali'],
  [0x0b80, 0x0bff, 'tamil'], [0x0c00, 0x0c7f, 'telugu'], [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'], [0x0a80, 0x0aff, 'gujarati'], [0x0a00, 0x0a7f, 'gurmukhi'],
];
const shapingCommon = /[\u200c\u200d\u25cc\u0964\u0965]/u;
function shapingId(ch: string): ShapingFontId | undefined {
  const cp = ch.codePointAt(0)!;
  return blocks.find(([start, end]) => cp >= start && cp <= end)?.[2];
}
/** Pure script selection; an optional cmap predicate resolves coverage without loading assets. */
export function splitScriptRuns(
  text: string,
  options: ScriptFontOptions & { covers?: (id: ScriptFontId, cp: number) => boolean } = {},
): ScriptFontRun[] {
  const characters = Array.from(text);
  const selected: ScriptFontId[] = [];
  const absent: number[] = [];
  for (let i = 0; i < characters.length;) {
    const ch = characters[i];
    const complex = shapingId(ch);
    if (complex && !shapingCommon.test(ch)) {
      selected[i++] = complex;
    } else if (shapingCommon.test(ch)) {
      const prior = selected[i - 1];
      const next = characters.slice(i + 1).find(current => !shapingCommon.test(current));
      const context = prior && isShapingFont(prior) ? prior : (next && shapingId(next)) || complex;
      if (!context) absent.push(ch.codePointAt(0)!);
      selected[i++] = context || 'latin';
    } else if (kana.test(ch) || hangul.test(ch) || han.test(ch) || cjkPunctuation.test(ch)) {
      let end = i, hasKana = false, hasHangul = false;
      while (end < characters.length) {
        const current = characters[end];
        if (!kana.test(current) && !hangul.test(current) && !han.test(current) && !cjkPunctuation.test(current)) break;
        hasKana ||= kana.test(current); hasHangul ||= hangul.test(current); end++;
      }
      const context = hasKana ? 'jp' : hasHangul ? 'kr' : options.preferredHanFont ?? 'sc';
      for (; i < end; i++) selected[i] = kana.test(characters[i]) ? 'jp' : hangul.test(characters[i]) ? 'kr' : context;
    } else {
      if ((!latin.test(ch) && !combining.test(ch) && !neutral.test(ch) && ch !== '\u0000') || pictograph.test(ch) || rtlControl.test(ch)) {
        absent.push(ch.codePointAt(0)!);
      }
      selected[i++] = 'latin';
    }
  }
  const runs: ScriptFontRun[] = [];
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i], cp = ch.codePointAt(0)!;
    const fontId = options.covers
      ? fontFallbackChain(selected[i]).find(id => options.covers!(id, cp))
      : selected[i];
    if (!fontId) { absent.push(cp); continue; }
    const previous = runs[runs.length - 1];
    if (previous?.fontId === fontId) previous.text += ch;
    else runs.push({ fontId, text: ch });
  }
  if (absent.length) {
    const missing = new Set(absent);
    throw new UnsupportedGlyphsError(characters.map(ch => ch.codePointAt(0)!).filter(cp => missing.has(cp)));
  }
  return runs;
}
