/**
 * Editing a table row that cairo/Firefox stores as ONE TJ with huge negative
 * numbers as column gaps must keep the other columns where they were.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentFlow } from '../flow/index';
import { applyLineTextEdit } from '../flow/flow-editor';
import { patchTJPreservingGaps } from '../editor/text-editor';
import { interpretPage } from '../content/interpreter';
import {
  PDFDict, PDFName, PDFNumber, PDFRef, PDFArray, PDFString,
  type PDFPageInfo, type PDFObject,
} from '../types';

const arr = (...items: (string | number)[]) =>
  new PDFArray(items.map((i) => (typeof i === 'string' ? new PDFString(i) : new PDFNumber(i))));

describe('patchTJPreservingGaps', () => {
  const old = arr('Desc text', -20000, '24 UNIT', -9000, '267.75');
  const oldText = 'Desc text24 UNIT267.75';

  it('keeps every gap when text is appended inside the first cell', () => {
    const out = patchTJPreservingGaps(old, oldText, 'Desc text ABC24 UNIT267.75', null)!;
    expect(out.asNumbers().filter((n) => !Number.isNaN(n))).toEqual(
      expect.arrayContaining([-20000, -9000]),
    );
    const strings = out.items.filter((i): i is PDFString => i instanceof PDFString).map((s) => s.value).join('');
    expect(strings.replace(/\s/g, '')).toBe('DesctextABC24UNIT267.75');
  });

  it('drops only adjustments that fall inside the replaced span', () => {
    const out = patchTJPreservingGaps(old, oldText, 'Desc X267.75', null)!;
    const nums = out.asNumbers().filter((n) => !Number.isNaN(n));
    expect(nums).not.toContain(-20000);
    expect(nums).toContain(-9000);
  });

  it('keeps kerning; declines when text does not line up', () => {
    // small kerning is preserved too (re-encoding would drop it and shift the line ~1pt)
    const kerned = patchTJPreservingGaps(arr('AV', 74, 'ATE'), 'AVATE', 'AVATEX', null)!;
    expect(kerned.items.some((x) => x instanceof PDFNumber && x.value === 74)).toBe(true);
    expect(patchTJPreservingGaps(old, 'something else', 'x', null)).toBeNull();
  });
});

describe('label : value rows with modest gaps', () => {
  // Real cairo row: "PAYMENT TERMS : 30 DAYS" with -703 / -555 gaps (no space glyphs).
  const row = arr('P', 74, 'A', 74, 'YMENT TERMS', -703, ':', -555, '30 DA', 75, 'YS');
  const rowText = 'PAYMENT TERMS:30 DAYS';

  it('keeps the colon and value in place when the value is edited', () => {
    const out = patchTJPreservingGaps(row, rowText, 'PAYMENT TERMS:30 DA888888YS', null)!;
    expect(out).not.toBeNull();
    const nums = out.asNumbers().filter((n) => !Number.isNaN(n));
    expect(nums).toContain(-703);
    expect(nums).toContain(-555);
  });
});

describe('applyLineTextEdit on a one-TJ table row', () => {
  it('does not move the other columns when the first cell grows', () => {
    const content =
      'BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n[(Desc text)-20000(24 UNIT)-9000(267.75)] TJ\nET\n';
    const bytes = new TextEncoder().encode(content);
    const fontDict = new PDFDict();
    const helv = new PDFDict();
    helv.set('Type', new PDFName('Font'));
    helv.set('Subtype', new PDFName('Type1'));
    helv.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('F1', helv);
    const resources = new PDFDict();
    resources.set('Font', fontDict);
    const pageDict = new PDFDict();
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([
      new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
    ]));
    const page: PDFPageInfo = {
      index: 0, dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0, ref: new PDFRef(1, 0), resources, contentRefs: [new PDFRef(2, 0)],
    };
    const objects = new Map<string, PDFObject>();
    objects.set('1 0', pageDict);

    const before = interpretPage(bytes, page, objects);
    const flow = buildDocumentFlow(before.textRuns);
    const line = flow.lines[0];
    const posOf = (runs: typeof before.textRuns, needle: string) => {
      for (const r of runs) {
        const i = r.text.indexOf(needle);
        if (i >= 0) return r.glyphs[i].tRm.e;
      }
      return NaN;
    };
    const x24 = posOf(before.textRuns, '24');
    const x267 = posOf(before.textRuns, '267');
    expect(Number.isFinite(x24)).toBe(true);

    const edit = applyLineTextEdit(bytes, page, objects, line, line.text.replace('Desc text', 'Desc text text'), flow, {
      oldText: line.text,
    });
    const after = interpretPage(edit.newContentBytes, page, objects);
    expect(posOf(after.textRuns, '24')).toBeCloseTo(x24, 0);
    expect(posOf(after.textRuns, '267')).toBeCloseTo(x267, 0);
  });
});
