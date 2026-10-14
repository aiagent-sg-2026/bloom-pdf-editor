import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { subsetTrueType } from '../fonts/ttf-subsetter';
import { parseTTF, getGlyphOutline } from '../fonts/truetype-parser';
import { syntheticUnicodeFont } from './unicode-font-fixtures';

/** Independent of the engine parser/subsetter: sfnt directory, sums, locations, component IDs. */
function inspectSfnt(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  let end = 12 + count * 16;
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(p, p + 4));
    const offset = v.getUint32(p + 8), length = v.getUint32(p + 12);
    expect(offset % 4).toBe(0); expect(offset).toBeGreaterThanOrEqual(end);
    expect(offset + length).toBeLessThanOrEqual(bytes.length);
    let sum = 0;
    for (let j = 0; j < length; j += 4) {
      let word = 0;
      for (let k = 0; k < 4; k++) word = (word << 8) | (j + k < length ? bytes[offset + j + k] : 0);
      // The head directory checksum treats checkSumAdjustment as zero.
      if (tag === 'head' && j === 8) word = 0;
      sum = (sum + (word >>> 0)) >>> 0;
    }
    expect(sum, tag).toBe(v.getUint32(p + 4));
    tables.set(tag, { offset, length }); end = offset + ((length + 3) & ~3);
  }
  let globalSum = 0;
  for (let p = 0; p < bytes.length; p += 4) globalSum = (globalSum + v.getUint32(p)) >>> 0;
  expect(globalSum).toBe(0xb1b0afba);
  const head = tables.get('head')!, maxp = tables.get('maxp')!, hhea = tables.get('hhea')!;
  const glyphCount = v.getUint16(maxp.offset + 4), metricsCount = v.getUint16(hhea.offset + 34);
  expect(metricsCount).toBe(glyphCount);
  expect(tables.get('hmtx')!.length).toBe(metricsCount * 4);
  const format = v.getInt16(head.offset + 50), loca = tables.get('loca')!, glyf = tables.get('glyf')!;
  expect([0, 1]).toContain(format);
  expect(loca.length).toBe((glyphCount + 1) * (format === 0 ? 2 : 4));
  const offsets = Array.from({ length: glyphCount + 1 }, (_, i) => format === 0
    ? v.getUint16(loca.offset + i * 2) * 2 : v.getUint32(loca.offset + i * 4));
  expect(offsets[0]).toBe(0); expect(offsets.at(-1)).toBe(glyf.length);
  const composites = new Map<number, number[]>();
  for (let gid = 0; gid < glyphCount; gid++) {
    const start = offsets[gid], finish = offsets[gid + 1];
    expect(start).toBeLessThanOrEqual(finish); expect(finish).toBeLessThanOrEqual(glyf.length);
    if (start === finish || v.getInt16(glyf.offset + start) >= 0) continue;
    let p = glyf.offset + start + 10, flags: number;
    const components: number[] = [];
    do {
      expect(p + 4).toBeLessThanOrEqual(glyf.offset + finish);
      flags = v.getUint16(p);
      const component = v.getUint16(p + 2);
      expect(component).toBeLessThan(glyphCount); components.push(component);
      p += 4 + ((flags & 1) ? 4 : 2) + ((flags & 8) ? 2 : (flags & 64) ? 4 : (flags & 128) ? 8 : 0);
    } while (flags & 32);
    if (flags & 256) p += 2 + v.getUint16(p);
    expect(p).toBeLessThanOrEqual(glyf.offset + finish);
    composites.set(gid, components);
  }
  return { tables, glyphCount, composites };
}

const scalarPoints = (text: string) => Array.from(text, ch => ch.codePointAt(0)!);

describe('dense static TrueType subsets', () => {
  it.each([4, 12, 'both'] as const)('reads cmap %s and preserves nested composite closure', format => {
    const source = syntheticUnicodeFont(format, format === 12);
    const subset = subsetTrueType(source, [0x8ba1]);
    const independent = inspectSfnt(subset.data), parsed = parseTTF(subset.data);
    expect([...subset.glyphIdMap]).toEqual([[0, 0], [1, 1], [3, 2], [8, 3], [9, 4]]);
    expect(independent.glyphCount).toBe(5);
    expect([...independent.composites]).toEqual([[2, [1, 3]], [3, [4]]]);
    expect([...parsed.cmapEntries]).toEqual([[0x8ba1, 2]]);
    expect([...parsed.advanceWidths]).toEqual([1000, 1200, 2000, 2000, 2000]);
    expect([...parsed.leftSideBearings]).toEqual([0, 10, 30, 80, 90]);
    expect(parsed.fullName).toBe('ABCDEF+NotoSansSC');
    expect(getGlyphOutline(parsed, 2)?.commands).toEqual(getGlyphOutline(parseTTF(source), 3)?.commands);
    for (const tag of ['cvt ', 'fpgm', 'prep']) {
      const table = independent.tables.get(tag)!;
      const original = parseTTF(source).tables.get(tag)!;
      expect(subset.data.subarray(table.offset, table.offset + table.length)).toEqual(source.subarray(original.offset, original.offset + original.length));
    }
  });

  it('keeps supplementary mappings and empty space glyphs with their real widths', () => {
    const subset = subsetTrueType(syntheticUnicodeFont(), [0x20000, 0x20]);
    inspectSfnt(subset.data);
    const parsed = parseTTF(subset.data);
    expect(parsed.numGlyphs).toBe(3);
    expect(parsed.cmapEntries.get(0x20000)).toBe(2);
    expect(parsed.cmapEntries.get(0x20)).toBe(1);
    expect(parsed.advanceWidths[1]).toBe(500); expect(parsed.advanceWidths[2]).toBe(2000);
    expect(getGlyphOutline(parsed, 1)?.commands).toEqual([]);
  });

  it('uses long loca when retained glyph data exceeds the short-loca limit', () => {
    const subset = subsetTrueType(syntheticUnicodeFont('both', true, 70000), [0x20000]);
    inspectSfnt(subset.data);
    const parsed = parseTTF(subset.data);
    expect(parsed.indexToLocFormat).toBe(1);
    expect(parsed.numGlyphs).toBe(2);
    expect(parsed.cmapEntries.get(0x20000)).toBe(1);
    expect(getGlyphOutline(parsed, 1)?.commands).toEqual(getGlyphOutline(parseTTF(syntheticUnicodeFont()), 10)?.commands);
  });


  it('emits a checksummed real bundled-font subset with the same Chinese outlines', () => {
    const source = new Uint8Array(readFileSync(new URL('../../../public/fonts/NotoSansSC-Regular.ttf', import.meta.url)));
    const subset = subsetTrueType(source, scalarPoints('计算机科学'));
    const inspected = inspectSfnt(subset.data), original = parseTTF(source), parsed = parseTTF(subset.data);
    expect(inspected.glyphCount).toBe(subset.glyphIdMap.size);
    expect([...parsed.cmapEntries.keys()].sort()).toEqual(scalarPoints('计算机科学').sort());
    for (const cp of scalarPoints('计算机科学')) {
      const gid = original.cmapEntries.get(cp)!, newGid = parsed.cmapEntries.get(cp)!;
      expect(parsed.advanceWidths[newGid]).toBe(original.advanceWidths[gid]);
      expect(getGlyphOutline(parsed, newGid)?.commands).toEqual(getGlyphOutline(original, gid)?.commands);
    }
  });

  it('rejects absent glyphs and out-of-bounds locations rather than emitting .notdef', () => {
    expect(() => subsetTrueType(syntheticUnicodeFont(), [0x1f600])).toThrow('Missing glyph');
    const source = syntheticUnicodeFont(), parsed = parseTTF(source), broken = source.slice();
    new DataView(broken.buffer).setUint16(parsed.tables.get('loca')!.offset + 2, 0xffff);
    expect(() => subsetTrueType(broken, [0x8ba1])).toThrow('Invalid glyph locations');
  });
});
