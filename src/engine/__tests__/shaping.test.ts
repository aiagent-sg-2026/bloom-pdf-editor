import { describe, expect, it } from 'vitest';
import { shapeText, shapeTextSync } from '../fonts/shaping';
import { SHAPING_SCRIPTS, splitScriptRuns } from '../fonts/script-fonts';
import { parseTTF } from '../fonts/truetype-parser';
import { shapingCases, shapingFontBytes } from './shaping-fixtures';

describe('LTR complex-script shaping', () => {
  it.each(shapingCases)('retains original $id cluster text and usable glyph metrics', async ({ id, text }) => {
    const bytes = shapingFontBytes(id), font = parseTTF(bytes);
    const clusters = await shapeText(bytes, text, SHAPING_SCRIPTS[id]);
    expect(clusters.map(cluster => cluster.text).join('')).toBe(text);
    for (const cluster of clusters) {
      for (const glyph of cluster.glyphs) {
        expect(glyph.gid).toBeGreaterThan(0);
        expect(glyph.gid).toBeLessThan(font.numGlyphs);
        expect([glyph.advance, glyph.xOffset, glyph.yOffset].every(Number.isFinite)).toBe(true);
      }
    }
    expect(shapeTextSync(bytes, text, SHAPING_SCRIPTS[id])).toEqual(clusters);
  });

  it('forms Devanagari conjuncts and places the i-matra before the consonant without reordering extraction', async () => {
    const bytes = shapingFontBytes('devanagari'), font = parseTTF(bytes);
    const conjunct = await shapeText(bytes, 'क्ष', 'Deva');
    expect(conjunct.map(cluster => cluster.text).join('')).toBe('क्ष');
    expect(conjunct.flatMap(cluster => cluster.glyphs).length).toBeLessThan(Array.from('क्ष').length);
    const reordered = await shapeText(bytes, 'कि', 'Deva');
    expect(reordered.map(cluster => cluster.text).join('')).toBe('कि');
    expect(reordered).toHaveLength(1);
    expect(reordered[0].glyphs[0].gid).not.toBe(font.cmapEntries.get('क'.codePointAt(0)!));
  });

  it('positions Thai above/below marks instead of adding ordinary character advances', async () => {
    const clusters = await shapeText(shapingFontBytes('thai'), 'กุ กู กิ กี ก่ สวัสดีครับ', 'Thai');
    const glyphs = clusters.flatMap(cluster => cluster.glyphs);
    expect(clusters.map(cluster => cluster.text).join('')).toBe('กุ กู กิ กี ก่ สวัสดีครับ');
    expect(glyphs.some(glyph => glyph.advance === 0)).toBe(true);
    expect(glyphs.some(glyph => glyph.xOffset !== 0 || glyph.yOffset !== 0)).toBe(true);
  });

  it.each(['क्\u200dष', 'क्\u200cष'])('preserves joiner controls in the shaped cluster text: %s', async text => {
    const clusters = await shapeText(shapingFontBytes('devanagari'), text, 'Deva');
    expect(clusters.map(cluster => cluster.text).join('')).toBe(text);
  });

  it('keeps complex spans apart from part-1 fonts and associates common shaping controls', () => {
    expect(splitScriptRuns('Hello สวัสดี नमस्ते 你好')).toEqual([
      { fontId: 'latin', text: 'Hello ' }, { fontId: 'thai', text: 'สวัสดี' },
      { fontId: 'latin', text: ' ' }, { fontId: 'devanagari', text: 'नमस्ते' },
      { fontId: 'latin', text: ' ' }, { fontId: 'sc', text: '你好' },
    ]);
    expect(splitScriptRuns('ক্\u200dষ।')).toEqual([{ fontId: 'bengali', text: 'ক্\u200dষ।' }]);
  });
});
