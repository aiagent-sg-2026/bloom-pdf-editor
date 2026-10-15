import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString,
  type PDFObject, type PDFPageInfo,
} from '../types';
import { resolvePageResources, resolveRef } from '../parser/parser';
import { flateEncode } from '../parser/filters';
import { parseTTF, type TTFFont } from './truetype-parser';
import { subsetTrueType } from './ttf-subsetter';
import { UnsupportedGlyphsError } from './unsupported-glyphs';
import { parseCMap } from './cmap-parser';
import {
  SCRIPT_FONTS, splitScriptRuns, fontFallbackChain, isShapingFont, SHAPING_SCRIPTS,
  type ScriptFontId, type ScriptFontOptions, type ScriptFontRun, type ShapingFontId,
} from './script-fonts';

import { prepareShaping, shapeTextSync, type ShapedCluster } from './shaping';
import type { CSInstruction } from '../content/operator-lexer';
export type UnicodeFontSource = Uint8Array | (() => Promise<Uint8Array>);
export type UnicodeFontSources = UnicodeFontSource | Partial<Record<ScriptFontId, UnicodeFontSource>>;

interface EmbeddedFont {
  source: Uint8Array;
  font: TTFFont;
  cids: Map<number, number>;
  glyphCids?: Map<number, number>;
  name: string;
  refs: PDFRef[];
  modifiedKeys: Set<string>;
  program: PDFStream;
  toUnicode: PDFStream;
}
const fonts = new WeakMap<Map<string, PDFObject>, Map<ScriptFontId, EmbeddedFont>>();
const preferences = new WeakMap<Map<string, PDFObject>, ScriptFontOptions>();
const preparations = new WeakMap<Map<string, PDFObject>, Promise<void>>();
const parsedSources = new WeakMap<Uint8Array, TTFFont>();
const loadedSources = new WeakMap<() => Promise<Uint8Array>, Promise<Uint8Array>>();
const bundledFonts: Partial<Record<ScriptFontId, Promise<Uint8Array>>> = {};
let nextSubset = 0;

async function loadSource(id: ScriptFontId, source?: UnicodeFontSources): Promise<{ bytes: Uint8Array; font: TTFFont }> {
  const selected = source instanceof Uint8Array || typeof source === 'function' ? source : source?.[id];
  let bytes: Uint8Array;
  if (selected instanceof Uint8Array) bytes = selected;
  else if (selected) {
    let pending = loadedSources.get(selected);
    if (!pending) {
      pending = selected().catch(error => { loadedSources.delete(selected); throw error; });
      loadedSources.set(selected, pending);
    }
    bytes = await pending;
  } else {
    if (!bundledFonts[id]) {
      bundledFonts[id] = fetch(SCRIPT_FONTS[id].assetPath).then(async response => {
        if (!response.ok) throw new Error(`Font download failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      }).catch(error => { delete bundledFonts[id]; throw error; });
    }
    bytes = await bundledFonts[id]!;
  }
  const font = parsedSources.get(bytes) ?? parseTTF(bytes);
  parsedSources.set(bytes, font);
  return { bytes, font };
}
/** Recover the engine's compact CID graph after save/reopen, without treating its subset as the source font. */
function findEmbeddedFont(objects: Map<string, PDFObject>, source: Uint8Array, font: TTFFont, id: ScriptFontId): EmbeddedFont | undefined {
  // Shaped CIDs identify source GIDs, not scalars. Never reinterpret or rewrite a reopened graph.
  if (isShapingFont(id)) return undefined;
  for (const [key, value] of objects) {
    if (!(value instanceof PDFDict) || value.getName('Subtype') !== 'Type0' ||
        value.getName('Encoding') !== 'Identity-H') continue;
    const name = value.getName('BaseFont');
    if (!name || !/^[A-Z]{6}\+/.test(name) || name.slice(7) !== SCRIPT_FONTS[id].baseFont) continue;
    const descendants = value.get('DescendantFonts');
    const descendantRef = descendants instanceof PDFArray ? descendants.get(0) : undefined;
    const unicodeRef = value.get('ToUnicode');
    if (!(descendantRef instanceof PDFRef) || !(unicodeRef instanceof PDFRef)) continue;
    const descendant = resolveRef(descendantRef, objects), toUnicode = resolveRef(unicodeRef, objects);
    if (!(descendant instanceof PDFDict) || descendant.getName('Subtype') !== 'CIDFontType2' ||
        !(toUnicode instanceof PDFStream)) continue;
    const descriptorRef = descendant.get('FontDescriptor'), cidMapRef = descendant.get('CIDToGIDMap');
    if (!(descriptorRef instanceof PDFRef) || !(cidMapRef instanceof PDFRef)) continue;
    const descriptor = resolveRef(descriptorRef, objects);
    const programRef = descriptor instanceof PDFDict ? descriptor.get('FontFile2') : undefined;
    if (!(programRef instanceof PDFRef)) continue;
    const program = resolveRef(programRef, objects);
    if (!(program instanceof PDFStream) || !(resolveRef(cidMapRef, objects) instanceof PDFStream)) continue;
    const mappings = [...parseCMap(toUnicode.getBytes()).toUnicode].sort(([a], [b]) => a - b);
    const cids = new Map<number, number>();
    if (!mappings.length || mappings.some(([cid, scalar], i) => cid !== i + 1 || Array.from(scalar).length !== 1)) continue;
    for (const [cid, scalar] of mappings) cids.set(scalar.codePointAt(0)!, cid);
    if (cids.size !== mappings.length) continue;
    const parts = key.split('_').map(Number);
    if (parts.length !== 2 || !parts.every(Number.isInteger)) continue;
    return { source, font, cids, name, program, toUnicode, modifiedKeys: new Set<string>(),
      refs: [new PDFRef(parts[0], parts[1]), descendantRef, descriptorRef, programRef, cidMapRef, unicodeRef] };
  }
  return undefined;
}


/** Prepare all required scalars before resource/content mutations. Existing CIDs never change. */
export async function prepareUnicodeFont(
  objects: Map<string, PDFObject>, codePoints: Iterable<number>, source?: UnicodeFontSource, id: ScriptFontId = 'sc',
  shapedTexts: readonly string[] = [],
): Promise<void> {
  const requested = [...new Set(codePoints)];
  if (!requested.length) return;
  const previous = preparations.get(objects) ?? Promise.resolve();
  const preparation = previous.catch(() => {}).then(async () => {
    const cached = fonts.get(objects)?.get(id);
    // History restoration can remove the graph. Preserve source bytes but rebuild that graph.
    const root = cached && objects.get(cached.refs[0].toKey());
    let existing = cached && root instanceof PDFDict && root.getName('BaseFont') === cached.name &&
      cached.refs.every(ref => objects.has(ref.toKey())) ? cached : undefined;
    if (existing && objects.get(existing.refs[3].toKey()) === existing.program &&
        objects.get(existing.refs[5].toKey()) === existing.toUnicode) {
      const { cids } = existing;
      if (!isShapingFont(id) && requested.every(cp => cids.has(cp))) return;
    }
    try {
      const { bytes, font } = cached ? { bytes: cached.source, font: cached.font } : await loadSource(id, source);
      const absent = requested.filter(cp => !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff ||
        (cp >= 0xd800 && cp <= 0xdfff) || (!(font.cmapEntries.get(cp) ?? 0) && !(isShapingFont(id) && (cp === 0x200c || cp === 0x200d))));
      if (absent.length) throw new UnsupportedGlyphsError(absent);
      const os2 = font.tables.get('OS/2');
      if (os2 && os2.length >= 10) {
        const permissions = new DataView(bytes.buffer, bytes.byteOffset + os2.offset, os2.length).getUint16(8);
        if (permissions & (0x0002 | 0x0100 | 0x0200)) throw new Error('Font license forbids outline subsetting/embedding');
      }
      existing ??= findEmbeddedFont(objects, bytes, font, id);
      const cids = new Map(existing?.cids);
      for (const cp of requested) if (!cids.has(cp)) cids.set(cp, cids.size + 1);
      const unavailable = [...cids.keys()].filter(cp => !(font.cmapEntries.get(cp) ?? 0) &&
        !(isShapingFont(id) && (cp === 0x200c || cp === 0x200d)));
      if (unavailable.length) throw new UnsupportedGlyphsError(unavailable);
      let glyphCids: Map<number, number> | undefined;
      if (isShapingFont(id)) {
        await prepareShaping();
        glyphCids = new Map(existing?.glyphCids);
        for (const text of shapedTexts.length ? shapedTexts : [String.fromCodePoint(...requested)]) {
          for (const cluster of shapeTextSync(bytes, text, SHAPING_SCRIPTS[id])) {
            for (const glyph of cluster.glyphs) if (!glyphCids.has(glyph.gid)) glyphCids.set(glyph.gid, glyphCids.size + 1);
          }
        }
      }
      if ((glyphCids?.size ?? cids.size) > 0xffff) throw new Error('Identity-H CID space exhausted');
      let name = existing?.name;
      if (!name) {
        const occupied = new Set<string>();
        for (const value of objects.values()) {
          if (!(value instanceof PDFDict)) continue;
          const fontName = value.getName('BaseFont') ?? value.getName('FontName');
          if (fontName && /^[A-Z]{6}\+/.test(fontName)) occupied.add(fontName.slice(0, 6));
        }
        let tag: string;
        do {
          let sequence = ++nextSubset;
          tag = '';
          for (let i = 0; i < 6; i++) { tag = String.fromCharCode(65 + sequence % 26) + tag; sequence = Math.floor(sequence / 26); }
        } while (occupied.has(tag));
        name = `${tag}+${SCRIPT_FONTS[id].baseFont}`;
      }
      const subset = subsetTrueType(bytes, glyphCids ? [] : cids.keys(), name, font, glyphCids?.keys());
      if (typeof CompressionStream === 'undefined') throw new Error('Flate compression is unavailable');
      const compressed = await flateEncode(subset.data);
      const program = new PDFStream(new PDFDict([
        ['Length', new PDFNumber(compressed.length)], ['Length1', new PDFNumber(subset.data.length)],
        ['Filter', new PDFName('FlateDecode')],
      ]), compressed, subset.data);
      const mapping = new Uint8Array(((glyphCids?.size ?? cids.size) + 1) * 2), mv = new DataView(mapping.buffer);
      const widths: PDFObject[] = [];
      for (const [key, cid] of glyphCids ?? cids) {
        const gid = glyphCids ? key : font.cmapEntries.get(key)!;
        mv.setUint16(cid * 2, subset.glyphIdMap.get(gid)!);
        widths.push(new PDFNumber(font.advanceWidths[gid] * 1000 / font.unitsPerEm));
      }
      // Only nominal 1:1 glyphs get a ToUnicode entry; shaped clusters carry ActualText.
      const entries = glyphCids
        ? [...cids.keys()].flatMap(cp => {
          const cid = glyphCids.get(font.cmapEntries.get(cp)!);
          return cid ? [[cp, cid] as const] : [];
        }).filter((entry, index, all) => all.findIndex(other => other[1] === entry[1]) === index)
        : [...cids];
      const lines = [
        '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
        '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
      ];
      for (let start = 0; start < entries.length; start += 100) {
        const block = entries.slice(start, start + 100);
        lines.push(`${block.length} beginbfchar`);
        for (const [cp, cid] of block) {
          let unicode = '';
          const scalar = String.fromCodePoint(cp);
          for (let i = 0; i < scalar.length; i++) unicode += scalar.charCodeAt(i).toString(16).padStart(4, '0');
          lines.push(`<${cid.toString(16).padStart(4, '0')}> <${unicode}>`);
        }
        lines.push('endbfchar');
      }
      lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
      const unicodeBytes = new TextEncoder().encode(lines.join('\n'));
      const toUnicode = new PDFStream(new PDFDict([['Length', new PDFNumber(unicodeBytes.length)]]), unicodeBytes, unicodeBytes);
      const cidMap = new PDFStream(new PDFDict([['Length', new PDFNumber(mapping.length)]]), mapping, mapping);
      let next = 1;
      if (!existing) for (const key of objects.keys()) next = Math.max(next, Number.parseInt(key.split('_')[0], 10) + 1);
      // Type0, descendant, descriptor, program, CIDToGIDMap, ToUnicode.
      const refs = existing?.refs ?? Array.from({ length: 6 }, (_, i) => new PDFRef(next + i, 0));
      const scale = 1000 / font.unitsPerEm;
      // parseTTF's layout metrics may be overridden by OS/2; PDF descriptors need signed metrics.
      let ascent = font.ascent, descent = font.descent;
      const hhea = font.tables.get('hhea');
      if (hhea && hhea.length >= 8) {
        const v = new DataView(bytes.buffer, bytes.byteOffset + hhea.offset, hhea.length);
        ascent = v.getInt16(4); descent = v.getInt16(6);
      } else if (os2 && os2.length >= 72) {
        const v = new DataView(bytes.buffer, bytes.byteOffset + os2.offset, os2.length);
        ascent = v.getInt16(68); descent = v.getInt16(70);
      }
      ascent = Math.abs(ascent); descent = -Math.abs(descent);
      let italicAngle = 0, capHeight = ascent;
      const post = font.tables.get('post');
      if (post && post.length >= 8) italicAngle = new DataView(bytes.buffer, bytes.byteOffset + post.offset, post.length).getInt32(4) / 65536;
      if (os2 && os2.length >= 90) {
        const v = new DataView(bytes.buffer, bytes.byteOffset + os2.offset, os2.length);
        if (v.getUint16(0) >= 2 && v.getInt16(88) > 0) capHeight = v.getInt16(88);
      }
      const descriptor = new PDFDict([
        ['Type', new PDFName('FontDescriptor')], ['FontName', new PDFName(name)],
        ['Flags', new PDFNumber(4)], ['FontBBox', new PDFArray(font.bbox.map(n => new PDFNumber(n * scale)))],
        ['Ascent', new PDFNumber(ascent * scale)], ['Descent', new PDFNumber(descent * scale)],
        ['CapHeight', new PDFNumber(capHeight * scale)], ['ItalicAngle', new PDFNumber(italicAngle)],
        ['StemV', new PDFNumber(80)], ['FontFile2', refs[3]],
      ]);
      const descendant = new PDFDict([
        ['Type', new PDFName('Font')], ['Subtype', new PDFName('CIDFontType2')], ['BaseFont', new PDFName(name)],
        ['CIDSystemInfo', new PDFDict([['Registry', new PDFString('Adobe')], ['Ordering', new PDFString('Identity')], ['Supplement', new PDFNumber(0)]])],
        ['FontDescriptor', refs[2]], ['CIDToGIDMap', refs[4]], ['DW', new PDFNumber(1000)],
        ['W', new PDFArray([new PDFNumber(1), new PDFArray(widths)])],
      ]);
      const type0 = new PDFDict([
        ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type0')], ['BaseFont', new PDFName(name)],
        ['Encoding', new PDFName('Identity-H')], ['DescendantFonts', new PDFArray([refs[1]])], ['ToUnicode', refs[5]],
      ]);
      const graph = [type0, descendant, descriptor, program, cidMap, toUnicode];
      // No await or fallible parsing after this point: publish the graph and cache together.
      refs.forEach((ref, i) => objects.set(ref.toKey(), graph[i]));
      const modifiedKeys = new Set(existing?.modifiedKeys);
      for (const ref of refs) modifiedKeys.add(ref.toKey());
      let states = fonts.get(objects);
      if (!states) { states = new Map(); fonts.set(objects, states); }
      states.set(id, { source: bytes, font, cids, glyphCids, name, refs, modifiedKeys, program, toUnicode });
    } catch (error) {
      if (error instanceof UnsupportedGlyphsError) throw error;
      throw new UnsupportedGlyphsError(requested);
    }
  });
  preparations.set(objects, preparation);
  try { await preparation; }
  finally { if (preparations.get(objects) === preparation) preparations.delete(objects); }
}

/** Resolve cmap coverage lazily, then publish all font graphs together or none. */
export async function prepareUnicodeText(
  objects: Map<string, PDFObject>,
  runs: readonly { text: string; codePoints: readonly number[]; preferredHanFont?: ScriptFontOptions['preferredHanFont'] }[],
  source?: UnicodeFontSources, options: ScriptFontOptions = {},
): Promise<void> {
  const requested = [...new Set(runs.flatMap(run => run.codePoints))];
  if (!requested.length) return;
  const previous = preparations.get(objects) ?? Promise.resolve();
  const preparation = previous.catch(() => {}).then(async () => {
    const settings = { ...preferences.get(objects), ...options };
    const byFont = new Map<ScriptFontId, Set<number>>();
    const shapeTexts = new Map<ScriptFontId, string[]>();
    const unavailable = new Set<number>();
    try {
      for (const run of runs) {
        const needed = new Set(run.codePoints);
        // Keep CJK neighbours for contextual Han selection, without validating
        // characters already encodable by the original or Standard 14 fonts.
        let context = Array.from(run.text, ch => needed.has(ch.codePointAt(0)!) ||
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) ? ch : ' ').join('');
        const runSettings = { preferredHanFont: run.preferredHanFont, ...settings };
        let parts: ScriptFontRun[];
        try { parts = splitScriptRuns(context, runSettings); }
        catch (error) {
          if (!(error instanceof UnsupportedGlyphsError)) throw error;
          for (const cp of error.codePoints) unavailable.add(cp);
          context = Array.from(context, ch => unavailable.has(ch.codePointAt(0)!) ? ' ' : ch).join('');
          parts = splitScriptRuns(context, runSettings);
        }
        for (const part of parts) {
          if (isShapingFont(part.fontId)) {
            const texts = shapeTexts.get(part.fontId) ?? [];
            texts.push(part.text); shapeTexts.set(part.fontId, texts);
          }
          for (const ch of part.text) {
            const cp = ch.codePointAt(0)!;
            if (!needed.has(cp)) continue;
            let selected: ScriptFontId | undefined;
            for (const id of fontFallbackChain(part.fontId)) {
              const cached = fonts.get(objects)?.get(id);
              const font = cached?.font ?? (await loadSource(id, source)).font;
              if (font.cmapEntries.get(cp) || (isShapingFont(id) && (cp === 0x200c || cp === 0x200d))) { selected = id; break; }
            }
            if (!selected) { unavailable.add(cp); continue; }
            let points = byFont.get(selected);
            if (!points) { points = new Set(); byFont.set(selected, points); }
            points.add(cp);
          }
        }
      }
      if (unavailable.size) throw new UnsupportedGlyphsError(requested.filter(cp => unavailable.has(cp)));
      const staged = new Map(objects);
      fonts.set(staged, new Map(fonts.get(objects)));
      for (const [id, points] of byFont) {
        const cached = fonts.get(objects)?.get(id);
        const bytes = cached?.source ?? (await loadSource(id, source)).bytes;
        await prepareUnicodeFont(staged, points, bytes, id, shapeTexts.get(id));
      }
      const states = fonts.get(staged)!;
      for (const state of states.values()) {
        for (const ref of state.refs) {
          const object = staged.get(ref.toKey());
          if (object) objects.set(ref.toKey(), object);
        }
      }
      fonts.set(objects, states);
      preferences.set(objects, settings);
    } catch (error) {
      if (error instanceof UnsupportedGlyphsError) throw error;
      throw new UnsupportedGlyphsError(requested);
    }
  });
  preparations.set(objects, preparation);
  try { await preparation; }
  finally { if (preparations.get(objects) === preparation) preparations.delete(objects); }
}

export function hasUnicodeGlyph(objects: Map<string, PDFObject>, cp: number, id?: ScriptFontId): boolean {
  const states = fonts.get(objects);
  const candidates = id ? [states?.get(id)] : states?.values() ?? [];
  for (const state of candidates) {
    if (state && objects.get(state.refs[3].toKey()) === state.program &&
        objects.get(state.refs[5].toKey()) === state.toUnicode && state.cids.has(cp)) return true;
  }
  return false;
}

/** Resolve context first, then only already-prepared cmap fallbacks; never performs I/O. */
export function unicodeTextRuns(
  objects: Map<string, PDFObject>, text: string, needed?: ReadonlySet<number>, originalFont?: ScriptFontId,
): ScriptFontRun[] {
  const characters = Array.from(text);
  const context = needed ? characters.map(ch => needed.has(ch.codePointAt(0)!) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) ? ch : ' ').join('') : text;
  let index = 0;
  const settings = { preferredHanFont: originalFont && ['sc', 'tc', 'jp', 'kr'].includes(originalFont)
    ? originalFont as ScriptFontOptions['preferredHanFont'] : undefined, ...preferences.get(objects) };
  return splitScriptRuns(context, settings).flatMap(run => {
    const result: ScriptFontRun[] = [];
    for (const _ of run.text) {
      const ch = characters[index++], cp = ch.codePointAt(0)!;
      const fontId = fontFallbackChain(run.fontId).find(id => hasUnicodeGlyph(objects, cp, id)) ?? run.fontId;
      const previous = result[result.length - 1];
      if (previous?.fontId === fontId) previous.text += ch;
      else result.push({ fontId, text: ch });
    }
    return result;
  });
}

export function unicodeGlyphWidth(objects: Map<string, PDFObject>, cp: number, id?: ScriptFontId): number {
  id ??= unicodeTextRuns(objects, String.fromCodePoint(cp))[0]?.fontId;
  if (id && isShapingFont(id)) throw new Error('Complex-script widths require shapedTextWidth, not scalar metrics');
  const state = id && fonts.get(objects)?.get(id);
  if (!state || !hasUnicodeGlyph(objects, cp, id)) throw new UnsupportedGlyphsError([cp]);
  return state.font.advanceWidths[state.font.cmapEntries.get(cp)!] * 1000 / state.font.unitsPerEm;
}

export function encodeUnicodeText(objects: Map<string, PDFObject>, text: string, id: ScriptFontId = 'sc'): PDFHexString {
  if (isShapingFont(id)) throw new Error('Complex-script text requires positioned shaped glyphs, not scalar encoding');
  const state = fonts.get(objects)?.get(id);
  let hex = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!state || !hasUnicodeGlyph(objects, cp, id)) throw new UnsupportedGlyphsError([cp]);
    hex += state.cids.get(cp)!.toString(16).padStart(4, '0');
  }
  return new PDFHexString(hex);
}

/** Synchronous layout/export after preparation; rejects glyphs absent from the staged subset. */
export function preparedShapedClusters(objects: Map<string, PDFObject>, text: string, id: ShapingFontId): ShapedCluster[] {
  const state = fonts.get(objects)?.get(id);
  if (!state?.glyphCids || objects.get(state.refs[3].toKey()) !== state.program) {
    throw new UnsupportedGlyphsError(Array.from(text, ch => ch.codePointAt(0)!));
  }
  const clusters = shapeTextSync(state.source, text, SHAPING_SCRIPTS[id]);
  if (clusters.some(cluster => cluster.glyphs.some(glyph => !state.glyphCids!.has(glyph.gid)))) {
    throw new UnsupportedGlyphsError(Array.from(text, ch => ch.codePointAt(0)!));
  }
  return clusters;
}

export function shapedTextWidth(objects: Map<string, PDFObject>, text: string, id: ShapingFontId): number {
  const clusters = preparedShapedClusters(objects, text, id);
  const scale = 1000 / fonts.get(objects)!.get(id)!.font.unitsPerEm;
  return clusters.reduce((width, cluster) => width + cluster.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0), 0) * scale;
}

export function emitShapedText(objects: Map<string, PDFObject>, text: string, id: ShapingFontId, fontSize: number, rise = 0): CSInstruction[] {
  const clusters = preparedShapedClusters(objects, text, id), state = fonts.get(objects)!.get(id)!;
  const scale = 1000 / state.font.unitsPerEm, ops: CSInstruction[] = [];
  for (const cluster of clusters) {
    let actual = 'feff';
    for (let i = 0; i < cluster.text.length; i++) actual += cluster.text.charCodeAt(i).toString(16).padStart(4, '0');
    ops.push({ operator: 'BDC', operands: [new PDFName('Span'), new PDFDict([['ActualText', new PDFHexString(actual)]])], offset: 0 });
    for (const glyph of cluster.glyphs) {
      const cid = state.glyphCids!.get(glyph.gid)!;
      // TJ begins at the pen, moves to the offset, then restores the shaped advance.
      const before = -glyph.xOffset * scale;
      const after = (state.font.advanceWidths[glyph.gid] + glyph.xOffset - glyph.advance) * scale;
      ops.push({ operator: 'Ts', operands: [new PDFNumber(rise + glyph.yOffset * fontSize / state.font.unitsPerEm)], offset: 0 },
        { operator: 'TJ', operands: [new PDFArray([new PDFNumber(before), new PDFHexString(cid.toString(16).padStart(4, '0')), new PDFNumber(after)])], offset: 0 });
    }
    ops.push({ operator: 'Ts', operands: [new PDFNumber(rise)], offset: 0 }, { operator: 'EMC', operands: [], offset: 0 });
  }
  return ops;
}

/** Copy effective resources before adding membership; never change inherited/sibling dictionaries. */
export function ensureUnicodeFont(page: PDFPageInfo, objects: Map<string, PDFObject>, id: ScriptFontId = 'sc'): string {
  const state = fonts.get(objects)?.get(id);
  if (!state || !objects.has(state.refs[0].toKey())) throw new Error('Unicode font was not prepared');
  state.modifiedKeys.add(page.ref.toKey());
  for (const ref of page.contentRefs) state.modifiedKeys.add(ref.toKey());
  const effective = resolvePageResources(page.dict, objects);
  const oldFonts = effective.get('Font');
  const resolvedFonts = oldFonts ? resolveRef(oldFonts, objects) : undefined;
  if (resolvedFonts instanceof PDFDict) {
    for (const [key, value] of resolvedFonts.entries()) {
      if (value instanceof PDFRef && value.toKey() === state.refs[0].toKey()) return key;
    }
  }
  const resources = new PDFDict([...effective.entries()]);
  const category = new PDFDict(resolvedFonts instanceof PDFDict ? [...resolvedFonts.entries()] : []);
  let key = 'UnicodeAug', index = 1;
  while (category.has(key)) key = `UnicodeAug${index++}`;
  category.set(key, state.refs[0]); resources.set('Font', category);
  page.dict.set('Resources', resources); page.resources = resources;
  return key;
}

/** Font graph/resource changes must join explicitly incremental quick saves. */
export function unicodeFontModifiedKeys(objects: Map<string, PDFObject>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const state of fonts.get(objects)?.values() ?? []) for (const key of state.modifiedKeys) keys.add(key);
  return keys;
}
