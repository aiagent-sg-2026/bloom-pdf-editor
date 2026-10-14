import { describe, expect, it } from 'vitest';
import { explodeTJGaps } from '../content/tj-normalizer';
import { interpretPage } from '../content/interpreter';
import { buildDocumentFlow } from '../flow/index';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, type PDFPageInfo } from '../types';

function fixture(content: string) {
  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  const fonts = new PDFDict(); fonts.set('F1', font);
  const resources = new PDFDict(); resources.set('Font', fonts);
  const dict = new PDFDict();
  dict.set('Resources', resources);
  dict.set('MediaBox', new PDFArray([0, 0, 612, 792].map(n => new PDFNumber(n))));
  const page: PDFPageInfo = {
    index: 0, dict, resources, ref: new PDFRef(1, 0), contentRefs: [new PDFRef(2, 0)],
    mediaBox: { x: 0, y: 0, width: 612, height: 792 }, cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0,
  };
  return { bytes: new TextEncoder().encode(content), page, objects: new Map<string, PDFObject>() };
}

describe('explodeTJGaps', () => {
  function glyphSnapshot(bytes: Uint8Array, f: ReturnType<typeof fixture>) {
    return interpretPage(bytes, f.page, f.objects).textRuns.flatMap(r =>
      r.glyphs.map(g => ({ text: g.unicode, x: g.tRm.e, y: g.tRm.f })));
  }

  function expectSameGlyphs(before: ReturnType<typeof glyphSnapshot>, after: ReturnType<typeof glyphSnapshot>) {
    expect(after.map(g => g.text)).toEqual(before.map(g => g.text));
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].x).toBeCloseTo(before[i].x, 3);
      expect(after[i].y).toBeCloseTo(before[i].y, 3);
    }
  }

  it('preserves every run in a shared-BT Firefox/cairo-style relative layout', () => {
    const f = fixture(`1 0 0 -1 0 792 cm
BT
/F1 9 Tf
9 0 0 -9 454.5 121 Tm
33.333333 9 Td
[(QUOT)75(A)73(TION NO.)-4344(:)]TJ
/F1 9 Tf
[()-501(DQ1)75(157)]TJ
/F1 9 Tf
0 -1.5 Td
[(QUOT)75(A)73(TION DA)74(TE)-3474(:)]TJ
/F1 9 Tf
[()-501(08 NOV 2025)]TJ
0 -1.5 Td
[(QUOT)75(A)73(TION DA)74(TE)-3474(:)]TJ
/F1 9 Tf
[()-501(09 NOV 2025)]TJ
0 -1.5 Td
(FINAL) Tj
ET
`);
    const before = glyphSnapshot(f.bytes, f);
    const normalized = explodeTJGaps(f.bytes, f.page, f.objects);
    expectSameGlyphs(before, glyphSnapshot(normalized, f));
  });

  it('restores line state for mixed line-moving operators and text state', () => {
    const f = fixture(`BT
/F1 10 Tf 1 0.35 -0.2 1 40 700 Tm
3 Tc 2 Tw 80 Tz
[(A)-3000(B)] TJ (C) Tj
12 -18 TD
[(D)-3000(E)] TJ
T*
(F) '
20 1 (G) "
[(H)-3000(I)] TJ
ET
BT
/F1 10 Tf 1 0 0 1 200 500 Tm
[(J)-3000(K)] TJ
ET
`);
    const before = glyphSnapshot(f.bytes, f);
    const normalized = explodeTJGaps(f.bytes, f.page, f.objects);
    expectSameGlyphs(before, glyphSnapshot(normalized, f));
    expect(explodeTJGaps(normalized, f.page, f.objects)).toEqual(normalized);
  });

  it('keeps a no-gap stream byte-identical', () => {
    const f = fixture('BT /F1 10 Tf 1 0 0 1 40 700 Tm [(A)-400(B) 300(C)] TJ ET\n');
    expect(explodeTJGaps(f.bytes, f.page, f.objects)).toBe(f.bytes);
  });

  it('preserves seeded random streams and remains idempotent', () => {
    let seed = 0x5eed1234;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const moves = ['0 -12 Td', 'T*', "(x) '", '20 1 (x) "'];
    for (let caseNo = 0; caseNo < 200; caseNo++) {
      const rows: string[] = ['BT', '/F1 10 Tf', `${random(2) ? '1 0.2 -0.1 1' : '1 0 0 1'} ${40 + random(120)} ${700 - random(100)} Tm`];
      for (let row = 0; row < 3 + random(4); row++) {
        rows.push(`${random(5)} Tc ${random(4)} Tw ${60 + random(60)} Tz`);
        rows.push(random(2) ? `[(A)-${1400 + random(3000)}(B)] TJ` : `[(A)-${1400 + random(3000)}(B)] TJ (C) Tj`);
        rows.push(moves[random(moves.length)]);
      }
      rows.push('[(Z)-3000(Q)] TJ', 'ET');
      const f = fixture(`${rows.join('\n')}\n`);
      const before = glyphSnapshot(f.bytes, f);
      const once = explodeTJGaps(f.bytes, f.page, f.objects);
      expectSameGlyphs(before, glyphSnapshot(once, f));
      expect(explodeTJGaps(once, f.page, f.objects)).toEqual(once);
    }
  });

  it('preserves glyph order and positions while splitting gutter cells', () => {
    const f = fixture('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(DESC)-3000(UNIT)-3000(PRICE)] TJ\nET\n');
    const before = interpretPage(f.bytes, f.page, f.objects);
    const normalized = explodeTJGaps(f.bytes, f.page, f.objects);
    const after = interpretPage(normalized, f.page, f.objects);
    expect(after.textRuns.map(r => r.text).join('')).toBe(before.textRuns.map(r => r.text).join(''));
    expect(after.textRuns.length).toBe(3);
    const bg = before.textRuns.flatMap(r => r.glyphs);
    const ag = after.textRuns.flatMap(r => r.glyphs);
    expect(ag.map(g => [g.tRm.e, g.tRm.f])).toEqual(bg.map(g => [expect.closeTo(g.tRm.e, 0.01), expect.closeTo(g.tRm.f, 0.01)]));
  });

  it('does not split kerning/word-spacing gaps and is idempotent', () => {
    const f = fixture('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(AV)-80(ATE) 400(NEXT)] TJ\nET\n');
    const once = explodeTJGaps(f.bytes, f.page, f.objects);
    expect(once).toBe(f.bytes);
    expect(explodeTJGaps(once, f.page, f.objects)).toBe(once);
  });

  it('keeps following shared-BT relative lines in place', () => {
    const f = fixture('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(A)-3000(B)] TJ\n0 -20 Td\n(C) Tj\nET\n');
    const before = interpretPage(f.bytes, f.page, f.objects).textRuns;
    const after = interpretPage(explodeTJGaps(f.bytes, f.page, f.objects), f.page, f.objects).textRuns;
    expect(after.find(r => r.text === 'C')!.y).toBeCloseTo(before.find(r => r.text === 'C')!.y, 2);
    expect(buildDocumentFlow(after).lines.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps non-ASCII string bytes intact when it rewrites the stream', () => {
    // 0xB1 is a single WinAnsi byte; a UTF-8 re-encode would turn it into C2 B1.
    const f = fixture('');
    f.bytes = Uint8Array.from(Array.from('BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(A)-3000(B)] TJ\n0 -20 Td\n(X\xb1Y) Tj\nET\n').map(c => c.charCodeAt(0)));
    const out = explodeTJGaps(f.bytes, f.page, f.objects);
    expect(out).not.toBe(f.bytes);
    const text = Array.from(out).map(b => String.fromCharCode(b)).join('');
    expect(text).toMatch(/X(\\261|\xb1)Y/);
    expect(Array.from(out)).not.toContain(0xc2);
  });
  it('keeps narrow-gutter cells (1.4-1.5 em at 10 pt) as separate editable lines', () => {
    for (const gap of [1400, 1500]) {
      const f = fixture(`1 0 0 -1 0 792 cm\nBT /F1 10 Tf 1 0 0 1 30 80 Tm\n[(ONLY)-${gap}(12345)-${gap}(67890)] TJ ET\n`);
      const runs = interpretPage(explodeTJGaps(f.bytes, f.page, f.objects), f.page, f.objects).textRuns;
      const lines = buildDocumentFlow(runs).lines;
      expect(lines.map(l => l.text)).toEqual(['ONLY', '12345', '67890']);
    }
  });
  it('keeps the next Td-relative line in place when a Tf sits between the row and the Td', () => {
    const f = fixture('BT\n/F1 10 Tf\n1 0 0 1 40 700 Tm\n[(A)-3000(B)] TJ /F1 10 Tf\n0 -20 Td\n[(C)-3000(D)] TJ\nET\n');
    const before = interpretPage(f.bytes, f.page, f.objects).textRuns;
    const after = interpretPage(explodeTJGaps(f.bytes, f.page, f.objects), f.page, f.objects).textRuns;
    for (const t of ['A', 'B', 'C', 'D']) {
      const b = before.flatMap(r => r.glyphs).find(g => g.unicode === t)!;
      const a = after.flatMap(r => r.glyphs).find(g => g.unicode === t)!;
      expect(a.tRm.e).toBeCloseTo(b.tRm.e, 2);
      expect(a.tRm.f).toBeCloseTo(b.tRm.f, 2);
    }
  });
});
