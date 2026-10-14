import { describe, expect, it } from 'vitest';
import { fontFallbackChain, splitScriptRuns, type ScriptFontId } from '../fonts/script-fonts';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';

describe('script font selection', () => {
  it('keeps ordered script runs and exact whitespace in mixed text', () => {
    const text = 'Hello 你好 こんにちは 안녕하세요 Xin chào Việt Nam';
    const runs = splitScriptRuns(text);
    expect(runs).toEqual([
      { fontId: 'latin', text: 'Hello ' }, { fontId: 'sc', text: '你好' },
      { fontId: 'latin', text: ' ' }, { fontId: 'jp', text: 'こんにちは' },
      { fontId: 'latin', text: ' ' }, { fontId: 'kr', text: '안녕하세요' },
      { fontId: 'latin', text: ' Xin chào Việt Nam' },
    ]);
    expect(runs.map(run => run.text).join('')).toBe(text);
    expect(splitScriptRuns('')).toEqual([]);
  });

  it('uses kana or hangul context for adjacent Han, not unrelated words', () => {
    expect(splitScriptRuns('世界こんにちはカタカナ')).toEqual([{ fontId: 'jp', text: '世界こんにちはカタカナ' }]);
    expect(splitScriptRuns('韓國한국어')).toEqual([{ fontId: 'kr', text: '韓國한국어' }]);
    expect(splitScriptRuns('漢字 かな')).toEqual([
      { fontId: 'sc', text: '漢字' }, { fontId: 'latin', text: ' ' }, { fontId: 'jp', text: 'かな' },
    ]);
    expect(splitScriptRuns('「世界、こんにちは。」')).toEqual([{ fontId: 'jp', text: '「世界、こんにちは。」' }]);
  });

  it.each(['sc', 'tc', 'jp', 'kr'] as const)('honors preferred Han font %s without overriding kana or hangul', preferredHanFont => {
    expect(splitScriptRuns('電腦科學與工程', { preferredHanFont })).toEqual([{ fontId: preferredHanFont, text: '電腦科學與工程' }]);
    expect(splitScriptRuns('かな한국', { preferredHanFont })).toEqual([
      { fontId: 'jp', text: 'かな' }, { fontId: 'kr', text: '한국' },
    ]);
  });

  it('selects Latin Extended, Vietnamese, decomposed combining marks and ASCII symbols', () => {
    const text = 'Tiếng Việt: Nguyễn Thị Hồng Ánh / Vie\u0323\u0302t + 1 = 2';
    expect(splitScriptRuns(text)).toEqual([{ fontId: 'latin', text }]);
  });

  it('falls through cmap coverage in order and merges the resulting adjacent runs', () => {
    const coverage: Partial<Record<ScriptFontId, ReadonlySet<number>>> = {
      sc: new Set([0x4e00]), tc: new Set([0x4e8c]), jp: new Set([0x4e09]), kr: new Set([0x56db]), latin: new Set([0x41]),
    };
    expect(splitScriptRuns('一二三四A', { covers: (id, cp) => coverage[id]?.has(cp) ?? false })).toEqual([
      { fontId: 'sc', text: '一' }, { fontId: 'tc', text: '二' }, { fontId: 'jp', text: '三' },
      { fontId: 'kr', text: '四' }, { fontId: 'latin', text: 'A' },
    ]);
    expect(fontFallbackChain('sc')).toEqual(['sc', 'tc', 'jp', 'kr']);
    expect(fontFallbackChain('tc')).toEqual(['tc', 'sc', 'jp', 'kr']);
    expect(splitScriptRuns('一二', { covers: id => id === 'jp' })).toEqual([{ fontId: 'jp', text: '一二' }]);
  });

  it('reports only scalars absent from every cmap in original order', () => {
    try {
      splitScriptRuns('一二一三', { covers: (_id, cp) => cp === 0x4e09 });
      throw new Error('Expected missing glyphs');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedGlyphsError);
      expect((error as UnsupportedGlyphsError).characters).toEqual(['一', '二']);
    }
  });

  it.each(['العربية', 'עברית', '😀'])('rejects unsupported scripts regardless of cmap: %s', text => {
    try {
      splitScriptRuns(text, { covers: () => true });
      throw new Error('Expected unsupported script');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedGlyphsError);
      expect((error as UnsupportedGlyphsError).characters).toEqual([...new Set(Array.from(text))]);
    }
  });
});
