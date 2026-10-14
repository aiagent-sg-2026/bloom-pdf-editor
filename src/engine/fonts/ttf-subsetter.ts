import { parseTTF, type TTFFont } from './truetype-parser';

export interface TrueTypeSubset {
  data: Uint8Array;
  /** Original GID -> dense subset GID (including composite components). */
  glyphIdMap: Map<number, number>;
  /** Source metrics/cmap, not the subset's renumbered cmap. */
  font: TTFFont;
}

const aligned = (n: number) => (n + 3) & ~3;
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word = ((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

function buildSfnt(tables: Map<string, Uint8Array>): Uint8Array {
  const entries = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const count = entries.length;
  const power = 2 ** Math.floor(Math.log2(count));
  let offset = 12 + count * 16;
  const data = new Uint8Array(offset + entries.reduce((n, [, bytes]) => n + aligned(bytes.length), 0));
  const v = view(data);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, count);
  v.setUint16(6, power * 16);
  v.setUint16(8, Math.log2(power));
  v.setUint16(10, count * 16 - power * 16);
  let headOffset = 0;
  entries.forEach(([tag, bytes], i) => {
    const p = 12 + i * 16;
    for (let j = 0; j < 4; j++) data[p + j] = tag.charCodeAt(j);
    v.setUint32(p + 4, checksum(bytes));
    v.setUint32(p + 8, offset);
    v.setUint32(p + 12, bytes.length);
    data.set(bytes, offset);
    if (tag === 'head') headOffset = offset;
    offset += aligned(bytes.length);
  });
  v.setUint32(headOffset + 8, (0xb1b0afba - checksum(data)) >>> 0);
  return data;
}

function buildCmap(mapping: Map<number, number>): Uint8Array {
  const entries = [...mapping].sort(([a], [b]) => a - b);
  const groups: { start: number; end: number; gid: number }[] = [];
  for (const [cp, gid] of entries) {
    const prev = groups[groups.length - 1];
    if (prev && cp === prev.end + 1 && gid === prev.gid + cp - prev.start) prev.end = cp;
    else groups.push({ start: cp, end: cp, gid });
  }
  const full = new Uint8Array(16 + groups.length * 12);
  const f = view(full);
  f.setUint16(0, 12); f.setUint32(4, full.length); f.setUint32(12, groups.length);
  groups.forEach((g, i) => {
    f.setUint32(16 + i * 12, g.start); f.setUint32(20 + i * 12, g.end); f.setUint32(24 + i * 12, g.gid);
  });
  const bmp = groups.filter(g => g.start < 0xffff).map(g => ({ ...g, end: Math.min(g.end, 0xfffe) }));
  bmp.push({ start: 0xffff, end: 0xffff, gid: 0 });
  // A format 4 subtable has a uint16 length; format 12 alone covers larger sets.
  const hasBMP = 16 + bmp.length * 8 <= 0xffff;
  const short = new Uint8Array(hasBMP ? 16 + bmp.length * 8 : 0);
  if (hasBMP) {
    const b = view(short), n = bmp.length, power = 2 ** Math.floor(Math.log2(n));
    b.setUint16(0, 4); b.setUint16(2, short.length); b.setUint16(6, n * 2);
    b.setUint16(8, power * 2); b.setUint16(10, Math.log2(power)); b.setUint16(12, n * 2 - power * 2);
    bmp.forEach((g, i) => {
      b.setUint16(14 + i * 2, g.end);
      b.setUint16(16 + n * 2 + i * 2, g.start);
      b.setUint16(16 + n * 4 + i * 2, (g.gid - g.start) & 0xffff);
    });
  }
  const header = hasBMP ? 20 : 12;
  const result = new Uint8Array(header + short.length + full.length), r = view(result);
  r.setUint16(2, hasBMP ? 2 : 1);
  if (hasBMP) { r.setUint16(4, 3); r.setUint16(6, 1); r.setUint32(8, header); }
  const p = hasBMP ? 12 : 4;
  r.setUint16(p, 3); r.setUint16(p + 2, 10); r.setUint32(p + 4, header + short.length);
  result.set(short, header); result.set(full, header + short.length);
  return result;
}

function buildName(name: string, original?: Uint8Array): Uint8Array {
  const records: { platform: number; encoding: number; language: number; id: number; bytes: Uint8Array }[] = [];
  if (original && original.length >= 6) {
    const v = view(original), count = v.getUint16(2), strings = v.getUint16(4);
    if (6 + count * 12 > original.length) throw new Error('Truncated name records');
    for (let i = 0; i < count; i++) {
      const p = 6 + i * 12, id = v.getUint16(p + 6);
      // Retain copyright, attribution, and license metadata, not stale family/style names.
      if (![0, 7, 8, 9, 11, 12, 13, 14].includes(id)) continue;
      const length = v.getUint16(p + 8), at = strings + v.getUint16(p + 10);
      if (at + length > original.length) throw new Error('Truncated name string');
      records.push({ platform: v.getUint16(p), encoding: v.getUint16(p + 2), language: v.getUint16(p + 4),
        id, bytes: original.subarray(at, at + length) });
    }
  }
  for (const [id, label] of [[1, name], [2, 'Regular'], [4, name], [6, name]] as const) {
    const bytes = new Uint8Array(label.length * 2), v = view(bytes);
    for (let i = 0; i < label.length; i++) v.setUint16(i * 2, label.charCodeAt(i));
    records.push({ platform: 3, encoding: 1, language: 0x409, id, bytes });
  }
  records.sort((a, b) => a.platform - b.platform || a.encoding - b.encoding || a.language - b.language || a.id - b.id);
  const start = 6 + records.length * 12;
  const bytes = new Uint8Array(start + records.reduce((n, record) => n + record.bytes.length, 0)), v = view(bytes);
  if (bytes.length > 0xffff) throw new Error('Subset name table exceeds uint16 offsets');
  v.setUint16(2, records.length); v.setUint16(4, start);
  let offset = 0;
  records.forEach((record, i) => {
    const p = 6 + i * 12;
    v.setUint16(p, record.platform); v.setUint16(p + 2, record.encoding); v.setUint16(p + 4, record.language);
    v.setUint16(p + 6, record.id); v.setUint16(p + 8, record.bytes.length); v.setUint16(p + 10, offset);
    bytes.set(record.bytes, start + offset); offset += record.bytes.length;
  });
  return bytes;
}

/** Static TrueType outlines; shaping happens before subsetting, so layout tables are omitted. */
export function subsetTrueType(
  data: Uint8Array,
  codePoints: Iterable<number>,
  subsetName = 'ABCDEF+NotoSansSC',
  /** Reuse parsed metrics for repeated subsets of the same immutable source bytes. */
  parsedFont?: TTFFont,
  /** Additional source GIDs produced by shaping, independent of the Unicode cmap. */
  glyphIds: Iterable<number> = [],
): TrueTypeSubset {
  const source = view(data);
  if (data.length < 12 || ![0x00010000, 0x74727565].includes(source.getUint32(0))) {
    throw new Error('A static glyf TrueType font is required');
  }
  const count = source.getUint16(4);
  if (12 + count * 16 > data.length) throw new Error('Truncated sfnt directory');
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, offset = source.getUint32(p + 8), length = source.getUint32(p + 12);
    if (offset > data.length || length > data.length - offset) throw new Error('Truncated sfnt table');
  }
  if (parsedFont && parsedFont.rawData !== data) throw new Error('Parsed font does not match source bytes');
  const font = parsedFont ?? parseTTF(data);
  if (font.tables.has('fvar')) throw new Error('Variable fonts require a static instance');
  const table = (tag: string, minLength = 0): Uint8Array => {
    const t = font.tables.get(tag);
    if (!t || t.length < minLength) throw new Error(`Missing or truncated ${tag} table`);
    return data.subarray(t.offset, t.offset + t.length);
  };
  const head = table('head', 54).slice(), hhea = table('hhea', 36).slice(), maxp = table('maxp', 32).slice();
  const glyphs = table('glyf'), locations = view(table('loca'));
  table('cmap', 4);
  const nMetrics = view(hhea).getUint16(34);
  if (!font.numGlyphs || !font.unitsPerEm || nMetrics < 1 || nMetrics > font.numGlyphs) throw new Error('Invalid TrueType metrics');
  table('hmtx', nMetrics * 4 + (font.numGlyphs - nMetrics) * 2);
  if (font.indexToLocFormat !== 0 && font.indexToLocFormat !== 1) throw new Error('Invalid loca format');
  const long = font.indexToLocFormat === 1;
  if (locations.byteLength < (font.numGlyphs + 1) * (long ? 4 : 2)) throw new Error('Truncated loca table');
  const offsets = new Uint32Array(font.numGlyphs + 1);
  for (let i = 0; i <= font.numGlyphs; i++) {
    offsets[i] = long ? locations.getUint32(i * 4) : locations.getUint16(i * 2) * 2;
    if (offsets[i] > glyphs.length || (i > 0 && offsets[i] < offsets[i - 1])) throw new Error('Invalid glyph locations');
  }
  const used = new Set<number>([0]);
  const mapping = new Map<number, number>();
  for (const cp of codePoints) {
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('Invalid Unicode scalar');
    const gid = font.cmapEntries.get(cp) ?? 0;
    if (!gid || gid >= font.numGlyphs) throw new Error(`Missing glyph for U+${cp.toString(16)}`);
    mapping.set(cp, gid); used.add(gid);
  }
  for (const gid of glyphIds) {
    if (!Number.isInteger(gid) || gid < 0 || gid >= font.numGlyphs) throw new Error('Invalid glyph ID');
    used.add(gid);
  }
  const components = (gid: number, visit: (gid: number, offset: number) => void) => {
    const bytes = glyphs.subarray(offsets[gid], offsets[gid + 1]);
    if (!bytes.length) return;
    if (bytes.length < 10) throw new Error('Truncated glyph');
    const v = view(bytes);
    if (v.getInt16(0) >= 0) return;
    let p = 10, flags: number;
    do {
      if (p + 4 > bytes.length) throw new Error('Truncated composite glyph');
      flags = v.getUint16(p);
      const component = v.getUint16(p + 2);
      if (component >= font.numGlyphs) throw new Error('Invalid composite component');
      visit(component, p + 2);
      p += 4 + ((flags & 1) ? 4 : 2) + ((flags & 8) ? 2 : (flags & 64) ? 4 : (flags & 128) ? 8 : 0);
      if (p > bytes.length) throw new Error('Truncated composite transform');
    } while (flags & 32);
    if (flags & 256) {
      if (p + 2 > bytes.length || p + 2 + v.getUint16(p) > bytes.length) throw new Error('Truncated composite instructions');
    }
  };
  // Set iteration visits newly appended components, including nested composites.
  for (const gid of used) components(gid, component => { used.add(component); });
  const ids = [...used].sort((a, b) => a - b);
  const glyphIdMap = new Map(ids.map((gid, i) => [gid, i]));
  const total = ids.reduce((n, gid) => n + aligned(offsets[gid + 1] - offsets[gid]), 0);
  const glyf = new Uint8Array(total);
  const shortLoca = total <= 0x1fffe;
  const loca = new Uint8Array((ids.length + 1) * (shortLoca ? 2 : 4)), lv = view(loca);
  const hmtx = new Uint8Array(ids.length * 4), hv = view(hmtx);
  let cursor = 0, advanceMax = 0, minLSB = 32767, minRSB = 32767, maxExtent = -32768;
  ids.forEach((gid, index) => {
    if (shortLoca) lv.setUint16(index * 2, cursor / 2); else lv.setUint32(index * 4, cursor);
    const bytes = glyphs.subarray(offsets[gid], offsets[gid + 1]);
    glyf.set(bytes, cursor);
    components(gid, (component, at) => view(glyf).setUint16(cursor + at, glyphIdMap.get(component)!));
    const width = font.advanceWidths[gid], lsb = font.leftSideBearings[gid];
    const extent = bytes.length ? view(bytes).getInt16(6) - view(bytes).getInt16(2) : 0;
    advanceMax = Math.max(advanceMax, width); minLSB = Math.min(minLSB, lsb);
    minRSB = Math.min(minRSB, width - lsb - extent); maxExtent = Math.max(maxExtent, lsb + extent);
    hv.setUint16(index * 4, width); hv.setInt16(index * 4 + 2, lsb);
    cursor += aligned(bytes.length);
  });
  if (shortLoca) lv.setUint16(ids.length * 2, cursor / 2); else lv.setUint32(ids.length * 4, cursor);
  const hd = view(head), hh = view(hhea);
  hd.setUint32(8, 0); hd.setInt16(50, shortLoca ? 0 : 1);
  hh.setUint16(10, advanceMax); hh.setInt16(12, minLSB); hh.setInt16(14, minRSB); hh.setInt16(16, maxExtent);
  hh.setUint16(34, ids.length); view(maxp).setUint16(4, ids.length);
  const tables = new Map<string, Uint8Array>([
    ['head', head], ['hhea', hhea], ['maxp', maxp], ['hmtx', hmtx], ['loca', loca], ['glyf', glyf],
    ['cmap', buildCmap(new Map([...mapping].map(([cp, gid]) => [cp, glyphIdMap.get(gid)!])))],
    ['name', buildName(subsetName, font.tables.has('name') ? table('name') : undefined)],
  ]);
  for (const tag of ['cvt ', 'fpgm', 'prep', 'gasp', 'OS/2']) {
    if (font.tables.has(tag)) tables.set(tag, table(tag));
  }
  const post = new Uint8Array(32);
  if (font.tables.has('post')) post.set(table('post').subarray(0, 32));
  view(post).setUint32(0, 0x00030000); tables.set('post', post);
  return { data: buildSfnt(tables), glyphIdMap, font };
}
