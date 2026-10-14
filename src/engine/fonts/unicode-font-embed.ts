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

export type UnicodeFontSource = Uint8Array | (() => Promise<Uint8Array>);

interface EmbeddedFont {
  source: Uint8Array;
  font: TTFFont;
  cids: Map<number, number>;
  name: string;
  refs: PDFRef[];
  modifiedKeys: Set<string>;
  program: PDFStream;
  toUnicode: PDFStream;
}
const fonts = new WeakMap<Map<string, PDFObject>, EmbeddedFont>();
const preparations = new WeakMap<Map<string, PDFObject>, Promise<void>>();
const parsedSources = new WeakMap<Uint8Array, TTFFont>();
let bundledFont: Promise<Uint8Array> | undefined;
let nextSubset = 0;

async function loadBundledFont(): Promise<Uint8Array> {
  if (!bundledFont) {
    // Next replaces this constant with the configured basePath, including static exports.
    const basePath = process.env.__NEXT_ROUTER_BASEPATH ?? '';
    bundledFont = fetch(`${basePath}/fonts/NotoSansSC-Regular.ttf`).then(async response => {
      if (!response.ok) throw new Error(`Font download failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    }).catch(error => { bundledFont = undefined; throw error; });
  }
  return bundledFont;
}
/** Recover the engine's compact CID graph after save/reopen, without treating its subset as the source font. */
function findEmbeddedFont(objects: Map<string, PDFObject>, source: Uint8Array, font: TTFFont): EmbeddedFont | undefined {
  for (const [key, value] of objects) {
    if (!(value instanceof PDFDict) || value.getName('Subtype') !== 'Type0' ||
        value.getName('Encoding') !== 'Identity-H') continue;
    const name = value.getName('BaseFont');
    if (!name || !/^[A-Z]{6}\+NotoSansSC$/.test(name)) continue;
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
  objects: Map<string, PDFObject>, codePoints: Iterable<number>, source?: UnicodeFontSource,
): Promise<void> {
  const requested = [...new Set(codePoints)];
  if (!requested.length) return;
  const previous = preparations.get(objects) ?? Promise.resolve();
  const preparation = previous.catch(() => {}).then(async () => {
    const cached = fonts.get(objects);
    // History restoration can remove the graph. Preserve source bytes but rebuild that graph.
    const root = cached && objects.get(cached.refs[0].toKey());
    let existing = cached && root instanceof PDFDict && root.getName('BaseFont') === cached.name &&
      cached.refs.every(ref => objects.has(ref.toKey())) ? cached : undefined;
    if (existing && objects.get(existing.refs[3].toKey()) === existing.program &&
        objects.get(existing.refs[5].toKey()) === existing.toUnicode) {
      const { cids } = existing;
      if (requested.every(cp => cids.has(cp))) return;
    }
    try {
      const bytes = cached?.source ?? (source instanceof Uint8Array ? source : await (source ?? loadBundledFont)());
      const font = cached?.font ?? parsedSources.get(bytes) ?? parseTTF(bytes);
      parsedSources.set(bytes, font);
      const absent = requested.filter(cp => !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff ||
        (cp >= 0xd800 && cp <= 0xdfff) || !(font.cmapEntries.get(cp) ?? 0));
      if (absent.length) throw new UnsupportedGlyphsError(absent);
      const os2 = font.tables.get('OS/2');
      if (os2 && os2.length >= 10) {
        const permissions = new DataView(bytes.buffer, bytes.byteOffset + os2.offset, os2.length).getUint16(8);
        if (permissions & (0x0002 | 0x0100 | 0x0200)) throw new Error('Font license forbids outline subsetting/embedding');
      }
      existing ??= findEmbeddedFont(objects, bytes, font);
      const cids = new Map(existing?.cids);
      for (const cp of requested) if (!cids.has(cp)) cids.set(cp, cids.size + 1);
      const unavailable = [...cids.keys()].filter(cp => !(font.cmapEntries.get(cp) ?? 0));
      if (unavailable.length) throw new UnsupportedGlyphsError(unavailable);
      if (cids.size > 0xffff) throw new Error('Identity-H CID space exhausted');
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
        name = `${tag}+NotoSansSC`;
      }
      const subset = subsetTrueType(bytes, cids.keys(), name, font);
      if (typeof CompressionStream === 'undefined') throw new Error('Flate compression is unavailable');
      const compressed = await flateEncode(subset.data);
      const program = new PDFStream(new PDFDict([
        ['Length', new PDFNumber(compressed.length)], ['Length1', new PDFNumber(subset.data.length)],
        ['Filter', new PDFName('FlateDecode')],
      ]), compressed, subset.data);
      const mapping = new Uint8Array((cids.size + 1) * 2), mv = new DataView(mapping.buffer);
      const widths: PDFObject[] = [];
      const entries = [...cids];
      for (const [cp, cid] of entries) {
        const gid = font.cmapEntries.get(cp)!;
        mv.setUint16(cid * 2, subset.glyphIdMap.get(gid)!);
        widths.push(new PDFNumber(font.advanceWidths[gid] * 1000 / font.unitsPerEm));
      }
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
      fonts.set(objects, { source: bytes, font, cids, name, refs, modifiedKeys, program, toUnicode });
    } catch (error) {
      if (error instanceof UnsupportedGlyphsError) throw error;
      throw new UnsupportedGlyphsError(requested);
    }
  });
  preparations.set(objects, preparation);
  try { await preparation; }
  finally { if (preparations.get(objects) === preparation) preparations.delete(objects); }
}

export function hasUnicodeGlyph(objects: Map<string, PDFObject>, cp: number): boolean {
  const font = fonts.get(objects);
  return !!font && objects.get(font.refs[3].toKey()) === font.program &&
    objects.get(font.refs[5].toKey()) === font.toUnicode && font.cids.has(cp);
}

export function unicodeGlyphWidth(objects: Map<string, PDFObject>, cp: number): number {
  const state = fonts.get(objects);
  if (!state || !hasUnicodeGlyph(objects, cp)) throw new UnsupportedGlyphsError([cp]);
  return state.font.advanceWidths[state.font.cmapEntries.get(cp)!] * 1000 / state.font.unitsPerEm;
}

export function encodeUnicodeText(objects: Map<string, PDFObject>, text: string): PDFHexString {
  const state = fonts.get(objects);
  let hex = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!state || !hasUnicodeGlyph(objects, cp)) throw new UnsupportedGlyphsError([cp]);
    hex += state.cids.get(cp)!.toString(16).padStart(4, '0');
  }
  return new PDFHexString(hex);
}

/** Copy effective resources before adding membership; never change inherited/sibling dictionaries. */
export function ensureUnicodeFont(page: PDFPageInfo, objects: Map<string, PDFObject>): string {
  const state = fonts.get(objects);
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
  return fonts.get(objects)?.modifiedKeys ?? new Set<string>();
}
