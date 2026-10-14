import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { explodeTJGaps } from '../content/tj-normalizer';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef,
  type PDFObject, type PDFPageInfo,
} from '../types';

function fixture() {
  const font = new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
    ['BaseFont', new PDFName('Helvetica')], ['Encoding', new PDFName('WinAnsiEncoding')],
  ]);
  const resources = new PDFDict([['Font', new PDFDict([['F1', font]])]]);
  const dict = new PDFDict([
    ['Resources', resources],
    ['MediaBox', new PDFArray([0, 0, 612, 792].map(n => new PDFNumber(n)))],
  ]);
  const page: PDFPageInfo = {
    index: 0, dict, resources, ref: new PDFRef(1, 0), contentRefs: [new PDFRef(2, 0)],
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0,
  };
  return { page, objects: new Map<string, PDFObject>() };
}

function expectPreserved(content: string, text: string) {
  const { page, objects } = fixture();
  const bytes = new TextEncoder().encode(content);
  const snapshot = (stream: Uint8Array) => interpretPage(stream, page, objects).textRuns
    .flatMap(run => run.glyphs.map(glyph => ({
      char: glyph.unicode, code: glyph.charCode, x: glyph.tRm.e, y: glyph.tRm.f,
    })));
  const before = snapshot(bytes);
  expect(before.map(g => g.char).join('')).toBe(text);
  const after = snapshot(explodeTJGaps(bytes, page, objects));
  expect(after.map(g => [g.code, g.char])).toEqual(before.map(g => [g.code, g.char]));
  for (let i = 0; i < before.length; i++) {
    expect(Math.abs(after[i].x - before[i].x), `glyph ${i}: x`).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(after[i].y - before[i].y), `glyph ${i}: y`).toBeLessThanOrEqual(1e-3);
  }
}

const minimal = `BT
/F1 10 Tf
50 600 Td
[(AAAA)-1600(BBBB)] TJ
/F1 10 Tf
[(CCCC)-1600(DDDD)] TJ
0 -12 Td
(EEEE) Tj
ET
`;

describe('consecutive TJ shows', () => {
  it('preserves the continuing text matrix across Tf and restores it for Td', () => {
    expectPreserved(minimal, 'AAAABBBBCCCCDDDDEEEE');
  });

  it('preserves consecutive shows with character and word spacing', () => {
    expectPreserved(`BT
/F1 10 Tf
0.1 Tc
0.2 Tw
50 600 Td
[(AA AA)-1600(BB BB)] TJ
/F1 10 Tf
[(CC CC)-1600(DD DD)] TJ
0 -12 Td
(EE EE) Tj
ET
`, 'AA AABB BBCC CCDD DDEE EE');
  });

  it('preserves three consecutive shows and restores the original line before T*', () => {
    expectPreserved(`BT
/F1 10 Tf
12 TL
50 600 Td
[(AAAA)-1600(BBBB)] TJ
/F1 10 Tf
[(CCCC)-1600(DDDD)] TJ
/F1 10 Tf
[()(EEEE)-1600()(FFFF)] TJ
T*
(GGGG) Tj
ET
`, 'AAAABBBBCCCCDDDDEEEEFFFFGGGG');
  });
});
