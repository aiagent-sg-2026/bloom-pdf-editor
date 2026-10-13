import { describe, it, expect } from 'vitest';
import { encodeTextForFont } from '../editor/text-editor';
import type { FontData } from '../fonts/font-parser';

function subsetFont(baseFont: string): FontData {
  return {
    name: 'f-0-0', baseFont, subtype: 'TrueType', isComposite: false, encoding: 'WinAnsiEncoding',
    differences: new Map(), toUnicode: new Map([[0x4d, 'M'], [0x61, 'a'], [0x74, 't']]),
    widths: new Map(), defaultWidth: 500,
  } as unknown as FontData;
}

describe('subset font glyph availability', () => {
  it('flags characters absent from an embedded subset as missing', () => {
    const enc = encodeTextForFont('MatQ', subsetFont('ABCDEF+ArialMT'));
    expect(enc.missing).toEqual(['Q'.codePointAt(0)]);
  });
  it('keeps the identity ASCII guess for non-subset fonts', () => {
    const enc = encodeTextForFont('MatQ', subsetFont('ArialMT'));
    expect(enc.missing).toEqual([]);
  });
  it('never treats a space as missing', () => {
    expect(encodeTextForFont('M a', subsetFont('ABCDEF+ArialMT')).missing).toEqual([]);
  });
});
