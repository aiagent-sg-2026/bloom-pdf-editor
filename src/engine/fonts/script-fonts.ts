import { UnsupportedGlyphsError } from './unsupported-glyphs';

export type ScriptFontId = 'sc' | 'tc' | 'jp' | 'kr' | 'latin';
export type HanFontId = Exclude<ScriptFontId, 'latin'>;
export interface ScriptFontOptions { preferredHanFont?: HanFontId }
export interface ScriptFontRun { fontId: ScriptFontId; text: string }

/** Static glyf assets; no layout/shaping tables are required by this export path. */
export const SCRIPT_FONTS = {
  sc: { assetPath: '/fonts/NotoSansSC-Regular.ttf', licensePath: '/fonts/NotoSansSC-OFL.txt', baseFont: 'NotoSansSC' },
  tc: { assetPath: '/fonts/NotoSansTC-Regular.ttf', licensePath: '/fonts/NotoSansTC-OFL.txt', baseFont: 'NotoSansTC' },
  jp: { assetPath: '/fonts/NotoSansJP-Regular.ttf', licensePath: '/fonts/NotoSansJP-OFL.txt', baseFont: 'NotoSansJP' },
  kr: { assetPath: '/fonts/NotoSansKR-Regular.ttf', licensePath: '/fonts/NotoSansKR-OFL.txt', baseFont: 'NotoSansKR' },
  latin: { assetPath: '/fonts/NotoSans-Regular.ttf', licensePath: '/fonts/NotoSans-OFL.txt', baseFont: 'NotoSans' },
} as const;

const chains: Record<ScriptFontId, readonly ScriptFontId[]> = {
  sc: ['sc', 'tc', 'jp', 'kr'],
  tc: ['tc', 'sc', 'jp', 'kr'],
  jp: ['jp', 'sc', 'tc', 'kr'],
  kr: ['kr', 'sc', 'tc', 'jp'],
  latin: ['latin', 'sc', 'tc', 'jp', 'kr'],
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
    if (kana.test(ch) || hangul.test(ch) || han.test(ch) || cjkPunctuation.test(ch)) {
      let end = i, hasKana = false, hasHangul = false;
      while (end < characters.length) {
        const current = characters[end];
        if (!kana.test(current) && !hangul.test(current) && !han.test(current) && !cjkPunctuation.test(current)) break;
        hasKana ||= kana.test(current); hasHangul ||= hangul.test(current); end++;
      }
      const context = hasKana ? 'jp' : hasHangul ? 'kr' : options.preferredHanFont ?? 'sc';
      for (; i < end; i++) selected[i] = kana.test(characters[i]) ? 'jp' : hangul.test(characters[i]) ? 'kr' : context;
    } else {
      if ((!latin.test(ch) && !combining.test(ch) && !neutral.test(ch) && ch !== '\u0000') || pictograph.test(ch)) {
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
