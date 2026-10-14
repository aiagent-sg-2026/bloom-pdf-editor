import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { prepareUnicodeFont, ensureUnicodeFont, encodeUnicodeText, unicodeGlyphWidth, hasUnicodeGlyph } from '../fonts/unicode-font-embed';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';
import { parseCMap } from '../fonts/cmap-parser';
import { loadFont } from '../fonts/font-parser';
import { parseTTF } from '../fonts/truetype-parser';
import { applyFilters } from '../parser/filters';
import { resolveRef } from '../parser/parser';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, type PDFObject, type PDFDocumentData } from '../types';
import { serializeDocument } from '../writer/serializer';
import { syntheticUnicodeFont, unicodeDocument } from './unicode-font-fixtures';

function fontGraph(doc: PDFDocumentData) {
  const key = ensureUnicodeFont(doc.pages[0], doc.objects);
  const fontRef = (doc.pages[0].resources.get('Font') as PDFDict).get(key) as PDFRef;
  const type0 = resolveRef(fontRef, doc.objects) as PDFDict;
  const descendant = resolveRef((type0.get('DescendantFonts') as PDFArray).get(0)!, doc.objects) as PDFDict;
  const descriptor = resolveRef(descendant.get('FontDescriptor')!, doc.objects) as PDFDict;
  const program = resolveRef(descriptor.get('FontFile2')!, doc.objects) as PDFStream;
  const toUnicode = resolveRef(type0.get('ToUnicode')!, doc.objects) as PDFStream;
  const cidMap = resolveRef(descendant.get('CIDToGIDMap')!, doc.objects) as PDFStream;
  return { fontRef, type0, descendant, descriptor, program, toUnicode, cidMap };
}

describe('on-demand Unicode PDF font graph', () => {
  it('embeds Type0/CIDFontType2, scaled widths, and supplementary UTF-16BE mappings', async () => {
    const doc = unicodeDocument(), text = '计机𠀀';
    await prepareUnicodeFont(doc.objects, Array.from(text, ch => ch.codePointAt(0)!), syntheticUnicodeFont());
    const graph = fontGraph(doc), cmap = parseCMap(graph.toUnicode.getBytes());
    expect(graph.type0.getName('Subtype')).toBe('Type0');
    expect(graph.type0.getName('Encoding')).toBe('Identity-H');
    expect(graph.type0.getName('BaseFont')).toMatch(/^[A-Z]{6}\+NotoSansSC$/);
    expect(graph.descendant.getName('Subtype')).toBe('CIDFontType2');
    expect(graph.descendant.getName('BaseFont')).toBe(graph.type0.getName('BaseFont'));
    expect(graph.descriptor.getName('FontName')).toBe(graph.type0.getName('BaseFont'));
    expect(graph.descriptor.getNumber('Flags')).toBe(4);
    expect(graph.descriptor.getNumber('Ascent')).toBe(800); expect(graph.descriptor.getNumber('Descent')).toBe(-200);
    expect((graph.descriptor.get('FontBBox') as PDFArray).items.map(obj => (obj as PDFNumber).value)).toEqual([0, 0, 500, 500]);
    expect(graph.program.dict.getName('Filter')).toBe('FlateDecode');
    const decoded = await applyFilters(graph.program.rawBytes, ['FlateDecode'], [null]);
    expect(decoded.length).toBe(graph.program.dict.getNumber('Length1'));
    expect(decoded).toEqual(graph.program.getBytes());
    const subset = parseTTF(decoded), font = loadFont('UnicodeAug', graph.type0, doc.objects);
    expect(cmap.codeSpaceRanges).toEqual([{ low: 0, high: 65535, bytes: 2 }]);
    const codes = encodeUnicodeText(doc.objects, text).toBytes();
    let recovered = '';
    for (let i = 0; i < codes.length; i += 2) {
      const cid = (codes[i] << 8) | codes[i + 1];
      const scalar = cmap.toUnicode.get(cid)!;
      recovered += scalar;
      const gid = new DataView(graph.cidMap.getBytes().buffer, graph.cidMap.getBytes().byteOffset).getUint16(cid * 2);
      expect(subset.cmapEntries.get(scalar.codePointAt(0)!)).toBe(gid);
      expect(font.widths.get(cid)).toBe(unicodeGlyphWidth(doc.objects, scalar.codePointAt(0)!));
    }
    expect(recovered).toBe(text);
    expect((graph.descendant.get('W') as PDFArray).items.map(obj => obj instanceof PDFArray ? obj.items.map(n => (n as PDFNumber).value) : (obj as PDFNumber).value)).toEqual([1, [1000, 1100, 1000]]);
    expect(new TextDecoder().decode(graph.toUnicode.getBytes())).toContain('<d840dc00>');
  });

  it('uses signed hhea metrics and head bounds in 1000-unit PDF descriptors', async () => {
    const noto = new Uint8Array(readFileSync(new URL('../../../public/fonts/NotoSansSC-Regular.ttf', import.meta.url)));
    for (const source of [syntheticUnicodeFont(), noto]) {
      const parsed = parseTTF(source), hhea = parsed.tables.get('hhea')!, head = parsed.tables.get('head')!;
      const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
      const scale = 1000 / parsed.unitsPerEm, doc = unicodeDocument();
      await prepareUnicodeFont(doc.objects, [0x8ba1], source);
      const { descriptor } = fontGraph(doc);
      expect(descriptor.getNumber('Ascent')).toBeGreaterThan(0);
      expect(descriptor.getNumber('Descent')).toBeLessThanOrEqual(0);
      expect(descriptor.getNumber('Ascent')).toBe(view.getInt16(hhea.offset + 4) * scale);
      expect(descriptor.getNumber('Descent')).toBe(view.getInt16(hhea.offset + 6) * scale);
      expect((descriptor.get('FontBBox') as PDFArray).items.map(obj => (obj as PDFNumber).value))
        .toEqual([36, 38, 40, 42].map(offset => view.getInt16(head.offset + offset) * scale));
    }
  });

  it('extends one graph across edits and concurrent preparations without changing old CIDs', async () => {
    const doc = unicodeDocument(), loader = vi.fn(async () => syntheticUnicodeFont());
    await prepareUnicodeFont(doc.objects, [0x8ba1], loader);
    const before = fontGraph(doc), firstCode = encodeUnicodeText(doc.objects, '计').hex;
    await Promise.all([prepareUnicodeFont(doc.objects, [0x673a], loader), prepareUnicodeFont(doc.objects, [0x20000], loader)]);
    const after = fontGraph(doc);
    expect(after.fontRef.toKey()).toBe(before.fontRef.toKey());
    expect(after.type0.getName('BaseFont')).toBe(before.type0.getName('BaseFont'));
    expect(encodeUnicodeText(doc.objects, '计').hex).toBe(firstCode);
    expect([...parseCMap(after.toUnicode.getBytes()).toUnicode.values()]).toEqual(['计', '机', '𠀀']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect([...doc.objects.values()].filter(obj => obj instanceof PDFDict && obj.getName('Subtype') === 'Type0')).toHaveLength(1);
  });

  it('leaves the document and an existing subset intact on missing glyph or loader failure', async () => {
    const doc = unicodeDocument(), source = syntheticUnicodeFont();
    const beforeLoad = await serializeDocument(doc);
    await expect(prepareUnicodeFont(doc.objects, [0x8ba1], async () => { throw new Error('offline'); })).rejects.toBeInstanceOf(UnsupportedGlyphsError);
    expect(await serializeDocument(doc)).toEqual(beforeLoad);
    await prepareUnicodeFont(doc.objects, [0x8ba1], source);
    const beforeMissing = await serializeDocument(doc);
    await expect(prepareUnicodeFont(doc.objects, [0x673a, 0x1f600], source)).rejects.toMatchObject({ characters: ['😀'] });
    expect(await serializeDocument(doc)).toEqual(beforeMissing);
    expect(hasUnicodeGlyph(doc.objects, 0x673a)).toBe(false);
    expect(encodeUnicodeText(doc.objects, '计').hex).toBe('0001');
  });

  it('invalidates restored subsets and rebuilds from source without reusing stale coverage', async () => {
    const doc = unicodeDocument(), source = syntheticUnicodeFont();
    await prepareUnicodeFont(doc.objects, [0x8ba1], source);
    fontGraph(doc);
    const snapshot = new Map(doc.objects);
    await prepareUnicodeFont(doc.objects, [0x673a], source);
    doc.objects.clear(); for (const [key, value] of snapshot) doc.objects.set(key, value);
    expect(hasUnicodeGlyph(doc.objects, 0x673a)).toBe(false);
    await prepareUnicodeFont(doc.objects, [0x673a], source);
    expect([...parseCMap(fontGraph(doc).toUnicode.getBytes()).toUnicode.values()]).toEqual(['计', '机']);
  });

  it('materializes inherited resources without installing Unicode on a sibling page', async () => {
    const doc = unicodeDocument(), page = doc.pages[0];
    const parent = doc.objects.get('2_0') as PDFDict;
    const inherited = page.resources, sibling = new PDFDict([['Parent', new PDFRef(2, 0)]]);
    parent.set('Resources', inherited); page.dict.delete('Resources');
    doc.objects.set('5_0', sibling);
    const beforeFonts = (inherited.get('Font') as PDFDict).size;
    await prepareUnicodeFont(doc.objects, [0x8ba1], syntheticUnicodeFont());
    const key = ensureUnicodeFont(page, doc.objects);
    expect((inherited.get('Font') as PDFDict).size).toBe(beforeFonts);
    expect(sibling.get('Resources')).toBeUndefined();
    expect((page.resources.get('Font') as PDFDict).get(key)).toBeInstanceOf(PDFRef);
    expect((page.resources.get('Font') as PDFDict).get('F1')).toBe((inherited.get('Font') as PDFDict).get('F1'));
  });

  it('fails closed on a malformed font without publishing PDF objects', async () => {
    const doc = unicodeDocument();
    // Parser failures retain all pending document state.
    const before = new Map<string, PDFObject>(doc.objects);
    await expect(prepareUnicodeFont(doc.objects, [0x8ba1], new Uint8Array([0, 1, 0, 0]))).rejects.toBeInstanceOf(UnsupportedGlyphsError);
    expect(doc.objects).toEqual(before);
  });
});
