import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData, type PDFObject } from '../types';

/** A complete static outline font, made in memory; hmtx uses trailing shared advances. */
export function syntheticUnicodeFont(format: 4 | 12 | 'both' = 'both', longLoca = false, glyphPadding = 0, extraScalars = 0): Uint8Array {
  const triangle = new Uint8Array(32 + glyphPadding), t = new DataView(triangle.buffer);
  t.setInt16(0, 1); t.setInt16(6, 1000); t.setInt16(8, 1000);
  t.setUint16(10, 2); // three points, no instructions
  triangle.set([1, 1, 1], 14);
  t.setInt16(17, 0); t.setInt16(19, 1000); t.setInt16(21, -1000);
  t.setInt16(23, 0); t.setInt16(25, 0); t.setInt16(27, 1000);
  const composite = new Uint8Array(28), c = new DataView(composite.buffer);
  c.setInt16(0, -1); c.setInt16(6, 1000); c.setInt16(8, 1000);
  c.setUint16(10, 35); c.setUint16(12, 1); // word XY args, more components
  c.setUint16(18, 3); c.setUint16(20, 8);
  const nested = new Uint8Array(24), n = new DataView(nested.buffer);
  n.setInt16(0, -1); n.setInt16(6, 1000); n.setInt16(8, 1000);
  n.setUint16(10, 3 | 8 | 256); n.setUint16(12, 9); n.setInt16(18, 0x4000);
  n.setUint16(20, 1); nested[22] = 0;
  const glyphs = [triangle, triangle, new Uint8Array(), composite, triangle, triangle, triangle, triangle, nested, triangle, triangle];
  const glyf = new Uint8Array(glyphs.reduce((size, glyph) => size + glyph.length, 0));
  const loca = new Uint8Array((glyphs.length + 1) * (longLoca ? 4 : 2)), l = new DataView(loca.buffer);
  let cursor = 0;
  glyphs.forEach((glyph, gid) => {
    if (longLoca) l.setUint32(gid * 4, cursor); else l.setUint16(gid * 2, cursor / 2);
    glyf.set(glyph, cursor); cursor += glyph.length;
  });
  if (longLoca) l.setUint32(glyphs.length * 4, cursor); else l.setUint16(glyphs.length * 2, cursor / 2);
  const head = new Uint8Array(54), h = new DataView(head.buffer);
  h.setUint32(0, 0x10000); h.setUint32(4, 0x10000); h.setUint32(12, 0x5f0f3cf5);
  h.setUint16(18, 2000); h.setInt16(40, 1000); h.setInt16(42, 1000); h.setInt16(50, longLoca ? 1 : 0);
  const hhea = new Uint8Array(36), hh = new DataView(hhea.buffer);
  hh.setUint32(0, 0x10000); hh.setInt16(4, 1600); hh.setInt16(6, -400);
  hh.setUint16(10, 2200); hh.setInt16(18, 1); hh.setUint16(34, 8);
  const maxp = new Uint8Array(32), m = new DataView(maxp.buffer);
  m.setUint32(0, 0x10000); m.setUint16(4, glyphs.length); m.setUint16(6, 3); m.setUint16(8, 1);
  m.setUint16(10, 6); m.setUint16(12, 2); m.setUint16(14, 2); m.setUint16(26, 1); m.setUint16(28, 2); m.setUint16(30, 2);
  const advances = [1000, 1200, 500, 2000, 1800, 2200, 1600, 2000];
  const hmtx = new Uint8Array(8 * 4 + 3 * 2), hm = new DataView(hmtx.buffer);
  advances.forEach((width, i) => { hm.setUint16(i * 4, width); hm.setInt16(i * 4 + 2, i * 10); });
  for (let i = 8; i < glyphs.length; i++) hm.setInt16(32 + (i - 8) * 2, i * 10);
  const entries = [[0x20, 2], [0x41, 1], [0x5b66, 7], [0x673a, 5], [0x79d1, 6], [0x7b97, 4], [0x8ba1, 3]];
  const segs = [...entries, [0xffff, 0]];
  const bmp = new Uint8Array(16 + segs.length * 8), b = new DataView(bmp.buffer);
  b.setUint16(0, 4); b.setUint16(2, bmp.length); b.setUint16(6, segs.length * 2);
  b.setUint16(8, 16); b.setUint16(10, 3);
  segs.forEach(([cp, gid], i) => {
    b.setUint16(14 + i * 2, cp); b.setUint16(16 + segs.length * 2 + i * 2, cp);
    b.setUint16(16 + segs.length * 4 + i * 2, (gid - cp) & 0xffff);
  });
  const fullEntries = [...entries, [0x20000, 10]];
  for (let i = 0; i < extraScalars; i++) fullEntries.push([0x20001 + i, 10]);
  const full = new Uint8Array(16 + fullEntries.length * 12), f = new DataView(full.buffer);
  f.setUint16(0, 12); f.setUint32(4, full.length); f.setUint32(12, fullEntries.length);
  fullEntries.forEach(([cp, gid], i) => { f.setUint32(16 + i * 12, cp); f.setUint32(20 + i * 12, cp); f.setUint32(24 + i * 12, gid); });
  const subtables = format === 4 ? [[1, bmp] as const] : format === 12 ? [[10, full] as const] : [[1, bmp] as const, [10, full] as const];
  const cmapStart = 4 + subtables.length * 8;
  const cmap = new Uint8Array(cmapStart + subtables.reduce((size, [, bytes]) => size + bytes.length, 0)), cm = new DataView(cmap.buffer);
  cm.setUint16(2, subtables.length); cursor = cmapStart;
  subtables.forEach(([encoding, bytes], i) => {
    cm.setUint16(4 + i * 8, 3); cm.setUint16(6 + i * 8, encoding); cm.setUint32(8 + i * 8, cursor);
    cmap.set(bytes, cursor); cursor += bytes.length;
  });
  const post = new Uint8Array(32); new DataView(post.buffer).setUint32(0, 0x30000);
  const tables = [
    ['head', head], ['hhea', hhea], ['maxp', maxp], ['hmtx', hmtx], ['loca', loca], ['glyf', glyf], ['cmap', cmap],
    ['post', post], ['cvt ', new Uint8Array([0, 42])], ['fpgm', new Uint8Array([0])], ['prep', new Uint8Array([0])],
  ] as const;
  const ordered = [...tables].sort(([a], [b]) => a < b ? -1 : 1);
  const start = 12 + ordered.length * 16;
  const data = new Uint8Array(start + ordered.reduce((size, [, bytes]) => size + ((bytes.length + 3) & ~3), 0)), v = new DataView(data.buffer);
  v.setUint32(0, 0x10000); v.setUint16(4, ordered.length); v.setUint16(6, 128); v.setUint16(8, 3); v.setUint16(10, ordered.length * 16 - 128);
  cursor = start; let headOffset = 0;
  ordered.forEach(([tag, bytes], i) => {
    const at = 12 + i * 16;
    for (let j = 0; j < 4; j++) data[at + j] = tag.charCodeAt(j);
    let sum = 0;
    for (let j = 0; j < bytes.length; j += 4) sum = (sum + ((((bytes[j] ?? 0) << 24) | ((bytes[j + 1] ?? 0) << 16) | ((bytes[j + 2] ?? 0) << 8) | (bytes[j + 3] ?? 0)) >>> 0)) >>> 0;
    v.setUint32(at + 4, sum); v.setUint32(at + 8, cursor); v.setUint32(at + 12, bytes.length);
    data.set(bytes, cursor); if (tag === 'head') headOffset = cursor;
    cursor += (bytes.length + 3) & ~3;
  });
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  v.setUint32(headOffset + 8, (0xb1b0afba - sum) >>> 0);
  return data;
}

export function unicodeDocument(content = ''): PDFDocumentData {
  const catalogRef = new PDFRef(1, 0), pagesRef = new PDFRef(2, 0), pageRef = new PDFRef(3, 0), contentRef = new PDFRef(4, 0);
  const font = new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')], ['Encoding', new PDFName('WinAnsiEncoding')]]);
  const resources = new PDFDict([['Font', new PDFDict([['F1', font]])]]);
  const catalog = new PDFDict([['Type', new PDFName('Catalog')], ['Pages', pagesRef]]);
  const pages = new PDFDict([['Type', new PDFName('Pages')], ['Count', new PDFNumber(1)], ['Kids', new PDFArray([pageRef])]]);
  const box = { x: 0, y: 0, width: 612, height: 792 };
  const page = new PDFDict([['Type', new PDFName('Page')], ['Parent', pagesRef], ['Contents', contentRef], ['Resources', resources], ['MediaBox', new PDFArray([0, 0, 612, 792].map(n => new PDFNumber(n)))]]);
  const bytes = new TextEncoder().encode(content);
  const objects = new Map<string, PDFObject>([[catalogRef.toKey(), catalog], [pagesRef.toKey(), pages], [pageRef.toKey(), page], [contentRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes)]]);
  return {
    version: '1.7', objects, catalog, info: {}, rawBytes: new Uint8Array(),
    xref: { entries: new Map(), trailerDict: new PDFDict([['Root', catalogRef]]) },
    pages: [{ index: 0, ref: pageRef, dict: page, resources, contentRefs: [contentRef], mediaBox: box, cropBox: box, rotate: 0 }],
  };
}
