import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName as LibPDFName, StandardFonts } from 'pdf-lib';
import {
  explodeTJGaps, getPageContentBytes, interpretPage, parsePDF,
  saveOptimized, saveQuick, updatePageContent,
} from '../browser-core';
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef,
  type PDFDocumentData, type PDFObject, type PDFPageInfo,
} from '../types';
import { serializeDocument } from '../writer/serializer';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const TOLERANCE = 1e-3;
const RANDOM_STREAM_COUNT = 240;
const BASE_SEED = 0x5eed1234;

function pageFixture() {
  const fonts = new PDFDict();
  for (const [name, baseFont] of [['F1', 'Helvetica'], ['F2', 'Courier']]) {
    fonts.set(name, new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
      ['BaseFont', new PDFName(baseFont)], ['Encoding', new PDFName('WinAnsiEncoding')],
    ]));
  }
  const resources = new PDFDict([['Font', fonts]]);
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

interface GlyphSnapshot {
  char: string;
  code: number;
  x: number;
  y: number;
}
type Snapshot = GlyphSnapshot[];

function snapshot(bytes: Uint8Array, page: PDFPageInfo, objects: Map<string, PDFObject>) {
  // Trm includes text-state, text-matrix and CTM transforms: page-space origins.
  return interpretPage(bytes, page, objects).textRuns.flatMap(run => run.glyphs.map(glyph => ({
    char: glyph.unicode, code: glyph.charCode, x: glyph.tRm.e, y: glyph.tRm.f,
  })));
}

function sameGlyphs(before: Snapshot, after: Snapshot) {
  return before.length === after.length && before.every((g, i) => {
    const other = after[i];
    return g.char === other.char && g.code === other.code &&
      Math.abs(g.x - other.x) <= TOLERANCE && Math.abs(g.y - other.y) <= TOLERANCE;
  });
}

function expectSameGlyphs(before: Snapshot, after: Snapshot, replay: string) {
  expect(after.map(g => [g.code, g.char]), replay).toEqual(before.map(g => [g.code, g.char]));
  for (let i = 0; i < before.length; i++) {
    expect(Math.abs(after[i].x - before[i].x), `${replay}\nglyph ${i}: x`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(after[i].y - before[i].y), `${replay}\nglyph ${i}: y`).toBeLessThanOrEqual(TOLERANCE);
  }
}

// Hand-reduced consecutive-show shape. Diagnostics include this stream only if
// it independently reproduces a mismatch; otherwise they retain the full replay.
const CONSECUTIVE_TJ_REPLAY = `BT
/F1 10 Tf
0 600 Td
[(A)-1600(B)] TJ
/F1 10 Tf
[(C)-1600(D)] TJ
0 -12 Td
(E) Tj
ET
`;

function normalizationReplay(content: string, label: string, before: Snapshot, after: Snapshot) {
  let replay = `${label}\nOffending stream:\n${content}`;
  if (!sameGlyphs(before, after)) {
    const f = pageFixture();
    const bytes = encode(CONSECUTIVE_TJ_REPLAY);
    const reducedBefore = snapshot(bytes, f.page, f.objects);
    const reducedAfter = snapshot(explodeTJGaps(bytes, f.page, f.objects), f.page, f.objects);
    if (!sameGlyphs(reducedBefore, reducedAfter)) {
      replay += `\nHand-reduced offending stream (consecutive TJ):\n${CONSECUTIVE_TJ_REPLAY}`;
    }
  }
  return replay;
}

function randomStream(seed: number) {
  // Inline unsigned LCG; each case has its own seed and can be replayed alone.
  let state = seed >>> 0;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const word = () => Array.from({ length: 1 + random(4) }, () => 'ABCDE 012345'[random(12)]).join('');
  const rows: string[] = [];
  let text = '';
  const tj = () => {
    const a = word(), b = word(), c = word();
    const smallGap = random(2699) - 1349;
    const largeGap = (random(2) ? 1 : -1) * (1350 + random(4651));
    rows.push(`[(${a})${smallGap}(${b})${largeGap}(${c})] TJ`);
    text += a + b + c;
  };
  const show = (operator: string, prefix = '') => {
    const value = word();
    rows.push(`${prefix}(${value}) ${operator}`);
    text += value;
  };
  for (let block = 0; block < 2; block++) {
    // Non-singular CTMs include reflection, shear, scale and translation.
    rows.push('q', `${0.5 + random(4) / 2} 0.125 -0.25 ${random(2) ? 1 : -1} ${random(30)} ${random(30)} cm`,
      'BT', `/F1 ${8 + random(9)} Tf`, `${10 + random(12)} TL`,
      `1 0.25 -0.125 1 ${30 + random(80)} ${500 + random(100)} Tm`);
    for (let line = 0; line < 3; line++) {
      tj();
      // Sometimes the font and size stay unchanged: adjacent shows may merge.
      rows.push(`/F${1 + random(2)} ${8 + random(9)} Tf`);
      tj();
      show('Tj');
      switch (block * 3 + line) {
        case 0: rows.push(`${random(15) - 7} -${10 + random(12)} Td`); break;
        case 1: rows.push(`${random(15) - 7} -${10 + random(12)} TD`); break;
        case 2: rows.push(`${10 + random(12)} TL`, 'T*'); break;
        case 3: show("'"); break;
        case 4: show('"', `${random(4)} ${random(3)} `); break;
        case 5: rows.push(`1 -0.125 0.25 1 ${30 + random(80)} ${300 + random(80)} Tm`); break;
      }
    }
    tj();
    show('Tj');
    rows.push('ET', 'Q');
  }
  return { content: `${rows.join('\n')}\n`, text };
}

// Synthetic streams model producer operator shapes, not private documents.
const PRODUCER_STREAMS = [
  {
    name: 'cairo: consecutive TJ and Tf before relative Td',
    text: 'QUOTATION NO.:DQ1157ITEMVALUEQUOTATION DATE:08 NOV 2025FINAL',
    content: `q
1 0 0 -1 0 792 cm
BT
/F1 9 Tf
9 0 0 -9 40 121 Tm
3 9 Td
[(QUOT)75(A)73(TION NO.)-4344(:)] TJ
/F1 9 Tf
[()-501(DQ1)75(157)] TJ
/F1 9 Tf
[(ITEM)-1500(VALUE)] TJ
/F1 9 Tf
0 -1.5 Td
[(QUOT)75(A)73(TION DA)74(TE)-3474(:)] TJ
/F1 9 Tf
[()-501(08 NOV 2025)] TJ
0 -1.5 Td
(FINAL) Tj
ET
Q
`,
  },
  {
    name: 'Chrome/Skia: flipped scaled CTM and hex-string shows',
    text: 'SKIAHEADERBODYTEXTNEXTLINE',
    content: `q
0.75 0 0 -0.75 0 792 cm
q
1 0 0 1 12 24 cm
BT
/F1 16 Tf
1 0 0 -1 40 60 Tm
[<534b4941> -2400 <484541444552>] TJ
/F2 16 Tf
(BODY) Tj
[<54455854> 75 () -1600 <4e455854>] TJ
1 0 0 -1 40 90 Tm
(LINE) Tj
ET
Q
BT
/F1 12 Tf
20 150 Td
ET
Q
`,
  },
  {
    name: 'Word: absolute Tm per line with interleaved font changes',
    text: 'WORDLINEONETWOBOLDFINALROW',
    content: `q
1 0 0 1 5 8 cm
BT
/F1 11 Tf
1 0 0 1 72 720 Tm
[(WORD) 80 (LINE) -1800 (ONE)] TJ
/F2 11 Tf
(TWO) Tj
1 0 0 1 72 704 Tm
/F1 11 Tf
[(BOLD) -2500 (FINAL)] TJ
/F1 11 Tf
1 0 0 1 72 688 Tm
(ROW) Tj
ET
Q
`,
  },
];

async function syntheticPdf(contents: string[], signed = false) {
  const source = await PDFDocument.create();
  const helvetica = await source.embedFont(StandardFonts.Helvetica);
  const courier = await source.embedFont(StandardFonts.Courier);
  for (const content of contents) {
    const page = source.addPage([612, 792]);
    page.node.set(LibPDFName.of('Resources'), source.context.obj({
      Font: { F1: helvetica.ref, F2: courier.ref },
    }));
    page.node.set(LibPDFName.of('Contents'), source.context.register(source.context.stream(encode(content))));
  }
  const bytes = await source.save({ useObjectStreams: false });
  if (!signed) return bytes;
  const doc = await parsePDF(bytes);
  // Same finalized-marker shape as signed-document-edits.test.ts; not a real signature.
  doc.catalog.set('TestSignature', new PDFDict([
    ['ByteRange', new PDFArray([0, 10, 20, 10].map(n => new PDFNumber(n)))],
    ['Contents', new PDFHexString('01020304')],
  ]));
  return serializeDocument(doc);
}

const SAVE_MODES = [
  { name: 'quick', save: (doc: PDFDocumentData) => saveQuick(doc, new Set(), new Map()) },
  { name: 'optimized', save: saveOptimized },
];

describe('no-edit document integrity', () => {
  it.each(Array.from({ length: RANDOM_STREAM_COUNT }, (_, i) => ({
    seed: (BASE_SEED + Math.imul(i, 0x9e3779b9)) >>> 0,
  })))('preserves random stream seed=$seed', ({ seed }) => {
    const { content, text } = randomStream(seed);
    const f = pageFixture();
    const bytes = encode(content);
    const before = snapshot(bytes, f.page, f.objects);
    const label = `seed=${seed} (0x${seed.toString(16)})`;
    expect(before.map(g => g.char).join(''), `${label}\n${content}`).toBe(text);
    const normalized = explodeTJGaps(bytes, f.page, f.objects);
    const after = snapshot(normalized, f.page, f.objects);
    expectSameGlyphs(before, after, normalizationReplay(content, label, before, after));
  });

  it.each(PRODUCER_STREAMS)('preserves $name', ({ name, content, text }) => {
    const f = pageFixture();
    const bytes = encode(content);
    const before = snapshot(bytes, f.page, f.objects);
    expect(before.map(g => g.char).join(''), name).toBe(text);
    const after = snapshot(explodeTJGaps(bytes, f.page, f.objects), f.page, f.objects);
    expectSameGlyphs(before, after, normalizationReplay(content, name, before, after));
  });

  it('preserves a hand-reduced consecutive-TJ replay', () => {
    const f = pageFixture();
    const bytes = encode(CONSECUTIVE_TJ_REPLAY);
    const before = snapshot(bytes, f.page, f.objects);
    expect(before.map(g => g.char).join('')).toBe('ABCDE');
    const after = snapshot(explodeTJGaps(bytes, f.page, f.objects), f.page, f.objects);
    expectSameGlyphs(before, after, `Hand-reduced offending stream:\n${CONSECUTIVE_TJ_REPLAY}`);
  });

  it.each(SAVE_MODES)('retains page count and exact content on a no-edit $name save', async ({ save }) => {
    const contents = PRODUCER_STREAMS.map(f => f.content);
    const doc = await parsePDF(await syntheticPdf(contents));
    expect(doc.pages).toHaveLength(contents.length);
    expect(doc.pages.map(p => decode(getPageContentBytes(p, doc.objects)))).toEqual(contents);
    const reopened = await parsePDF(await save(doc));
    expect(reopened.pages).toHaveLength(contents.length);
    expect(reopened.pages.map(p => decode(getPageContentBytes(p, reopened.objects)))).toEqual(contents);
  });

  it.each(SAVE_MODES)('preserves glyphs through normalize-on-open and $name export', async ({ save }) => {
    const doc = await parsePDF(await syntheticPdf(PRODUCER_STREAMS.map(f => f.content)));
    const before = doc.pages.map(p => snapshot(getPageContentBytes(p, doc.objects), p, doc.objects));
    const normalizedContents: string[] = [];
    for (const page of doc.pages) {
      const original = getPageContentBytes(page, doc.objects);
      const normalized = explodeTJGaps(original, page, doc.objects);
      normalizedContents.push(decode(normalized));
      if (normalized !== original) await updatePageContent(page.contentRefs, normalized, doc.objects);
    }
    const reopened = await parsePDF(await save(doc));
    expect(reopened.pages).toHaveLength(PRODUCER_STREAMS.length);
    expect(reopened.pages.map(p => decode(getPageContentBytes(p, reopened.objects)))).toEqual(normalizedContents);
    reopened.pages.forEach((page, i) => {
      expectSameGlyphs(before[i], snapshot(getPageContentBytes(page, reopened.objects), page, reopened.objects),
        `No-edit export: ${PRODUCER_STREAMS[i].name}\n${PRODUCER_STREAMS[i].content}`);
    });
  });

  it.each(SAVE_MODES)('returns finalized-marker bytes unchanged on a no-edit $name save', async ({ save }) => {
    const contents = PRODUCER_STREAMS.map(f => f.content);
    const bytes = await syntheticPdf(contents, true);
    const doc = await parsePDF(bytes);
    // Populate interpreter/decoded-stream caches as opening a document does.
    doc.pages.forEach(p => snapshot(getPageContentBytes(p, doc.objects), p, doc.objects));
    const saved = await save(doc);
    expect(saved).toEqual(bytes);
    const reopened = await parsePDF(saved);
    expect(reopened.pages).toHaveLength(contents.length);
    expect(reopened.pages.map(p => decode(getPageContentBytes(p, reopened.objects)))).toEqual(contents);
  });
});
