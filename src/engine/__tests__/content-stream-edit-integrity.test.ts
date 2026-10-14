import { describe, expect, it } from 'vitest';
import { parseContentStream } from '../content/operator-lexer';
import { prettyPrint, roundTripTest } from '../content/parser';
import { interpretPage } from '../content/interpreter';
import { explodeTJGaps } from '../content/tj-normalizer';
import { applyTextEdits, compileInstructions } from '../editor/text-editor';
import { serializeToString } from '../editor/stream-compiler';
import {
  PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, PDFString, type PDFPageInfo,
} from '../types';

const ascii = (text: string) => new TextEncoder().encode(text);

interface StreamFixture {
  bytes: Uint8Array;
  page: PDFPageInfo;
  objects: Map<string, PDFObject>;
}

interface InlineImageFixture extends StreamFixture {
  image: Uint8Array;
  payload: Uint8Array;
}

interface GlyphSnapshot {
  text: string;
  x: number;
  y: number;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function fixture(bytes: Uint8Array): StreamFixture {
  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  const fonts = new PDFDict(); fonts.set('F1', font);
  const resources = new PDFDict(); resources.set('Font', fonts);
  const dict = new PDFDict(); dict.set('Resources', resources);
  const page: PDFPageInfo = {
    index: 0, dict, resources, ref: new PDFRef(1, 0), contentRefs: [new PDFRef(2, 0)],
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0,
  };
  return { bytes, page, objects: new Map<string, PDFObject>() };
}

function imageFixture(payload: Uint8Array, text = '(old) Tj'): InlineImageFixture {
  const image = concat(
    ascii(`BI\n/W ${payload.length} /H 1 /BPC 8 /CS /G /I false\nID `),
    payload,
    ascii('\nEI'),
  );
  const f = fixture(concat(
    ascii(`BT /F1 12 Tf 1 0 0 1 40 700 Tm ${text} ET\nq\n`),
    image,
    ascii('\nQ\nBT /F1 12 Tf 1 0 0 1 40 650 Tm (tail) Tj ET\n'),
  ));
  return { ...f, image, payload };
}

function expectImageUnchanged(bytes: Uint8Array, f: InlineImageFixture) {
  const instructions = parseContentStream(bytes);
  const images = instructions.filter(inst => inst.operator === 'BI');
  expect(images).toHaveLength(1);
  const image = images[0];
  expect(bytes.subarray(image.offset, image.offset + f.image.length)).toEqual(f.image);
  const dict = image.operands[0] as PDFDict;
  expect(Array.from(dict.entries())
    .filter(([key]) => !key.startsWith('__'))
    .map(([key, value]) => [key, serializeToString(value)]))
    .toEqual([
      ['Width', String(f.payload.length)], ['Height', '1'], ['BitsPerComponent', '8'],
      ['ColorSpace', '/DeviceGray'], ['Interpolate', 'false'],
    ]);
  const start = (dict.get('__imageDataOffset') as PDFNumber).value;
  const length = (dict.get('__imageDataLength') as PDFNumber).value;
  // The existing metadata includes the whitespace separator before EI.
  expect(bytes.subarray(start, start + length)).toEqual(concat(f.payload, ascii('\n')));
  const after = interpretPage(bytes, f.page, f.objects);
  expect(after.textRuns.at(-1)!.text).toBe('tail');
}

function glyphs(bytes: Uint8Array, f: StreamFixture): GlyphSnapshot[] {
  return interpretPage(bytes, f.page, f.objects).textRuns.flatMap(run =>
    run.glyphs.map(glyph => ({ text: glyph.unicode, x: glyph.tRm.e, y: glyph.tRm.f })));
}

function expectSameGlyphs(actual: GlyphSnapshot[], expected: GlyphSnapshot[]) {
  expect(actual.map(glyph => glyph.text)).toEqual(expected.map(glyph => glyph.text));
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].x).toBeCloseTo(expected[i].x, 4);
    expect(actual[i].y).toBeCloseTo(expected[i].y, 4);
  }
}

describe('inline-image content recompilation', () => {
  const payload = new Uint8Array([0x00, 0xff, 0x45, 0x49, 0x01, 0x80, 0x28, 0x5c]);

  it('preserves the dictionary and binary payload through a real text edit and reparse', () => {
    const f = imageFixture(payload);
    const targetRun = interpretPage(f.bytes, f.page, f.objects).textRuns[0];
    const edited = applyTextEdits(f.bytes, f.page, f.objects, [{ targetRun, newText: 'edited text' }]);
    expectImageUnchanged(edited.newContentBytes, f);
    expect(interpretPage(edited.newContentBytes, f.page, f.objects).textRuns[0].text).toBe('edited text');
  });

  it.each([
    ['editor compiler', compileInstructions],
    ['pretty printer', prettyPrint],
  ] as const)('preserves inline images in a no-op round trip through the %s', (_name, compile) => {
    const f = imageFixture(payload);
    const output = compile(parseContentStream(f.bytes));
    expectImageUnchanged(output, f);
    expectSameGlyphs(glyphs(output, f), glyphs(f.bytes, f));
    expect(roundTripTest(f.bytes).success).toBe(true);
  });

  it('does not mistake delimited EI bytes inside unfiltered samples for the terminator', () => {
    const f = imageFixture(new Uint8Array([0xff, 0x20, 0x45, 0x49, 0x20, 0x00, 0x80]));
    expectImageUnchanged(f.bytes, f);
    expectImageUnchanged(compileInstructions(parseContentStream(f.bytes)), f);
  });

  it('does not mistake EI followed by a non-delimiter for a filtered image terminator', () => {
    const bytes = concat(
      ascii('BI /W 8 /H 1 /BPC 8 /CS /G /F /RL ID '),
      new Uint8Array([7]), ascii('00 EIX00'), new Uint8Array([128]),
      ascii('\nEI\nQ\n'),
    );
    const parsed = parseContentStream(bytes);
    expect(parsed.map(inst => inst.operator)).toEqual(['BI', 'Q']);
    const output = prettyPrint(parsed);
    expect(output.subarray(0, bytes.length - 3)).toEqual(bytes.subarray(0, bytes.length - 3));
  });

  it('keeps inline images when the TJ normalizer actually recompiles the stream', () => {
    const f = imageFixture(payload, '[(old)-3000(cell)] TJ');
    const output = explodeTJGaps(f.bytes, f.page, f.objects);
    expect(parseContentStream(output).filter(inst => inst.operator === 'TJ')).toHaveLength(0);
    expectImageUnchanged(output, f);
    expectSameGlyphs(glyphs(output, f), glyphs(f.bytes, f));
  });
});

describe('quote-operator text edits', () => {
  const start = 'BT /F1 12 Tf 18 TL 1 0 0 1 40 700 Tm ';
  const end = ' 40 0 Td (tail) Tj T* (next) Tj ET\n';

  it.each(["'", '"'] as const)('keeps %s line movement and spacing for string-only replacements', operator => {
    for (const newText of ['new', 'new words']) {
      const spacing = operator === '"' ? '7 2 ' : '';
      const f = fixture(ascii(`${start}${spacing}(old) ${operator}${end}`));
      const targetRun = interpretPage(f.bytes, f.page, f.objects).textRuns[0];
      const edited = applyTextEdits(f.bytes, f.page, f.objects, [{ targetRun, newText }]);
      const instructions = parseContentStream(edited.newContentBytes);
      expect(instructions.map(inst => inst.operator)).toEqual(parseContentStream(f.bytes).map(inst => inst.operator));
      const showing = instructions.find(inst => inst.operator === operator)!;
      expect(showing.operands.map(serializeToString)).toEqual(
        operator === '"' ? ['7', '2', `(${newText})`] : [`(${newText})`],
      );
      const expected = ascii(`${start}${spacing}(${newText}) ${operator}${end}`);
      expectSameGlyphs(glyphs(edited.newContentBytes, f), glyphs(expected, f));
      expect(glyphs(edited.newContentBytes, f)[0].y).toBe(682);
    }
  });

  it('retains spacing and line movement when emptying a grouped double-quote sibling', () => {
    const f = fixture(ascii(`${start}(old) ' 7 2 (part) "${end}`));
    const runs = interpretPage(f.bytes, f.page, f.objects).textRuns;
    const instructions = parseContentStream(f.bytes);
    const sourceInstructionIndices = instructions.flatMap((inst, index) =>
      inst.operator === "'" || inst.operator === '"' ? [index] : []);
    const targetRun = { ...runs[0], text: 'oldpart', sourceInstructionIndices };
    const edited = applyTextEdits(f.bytes, f.page, f.objects, [{ targetRun, newText: 'new words' }]);
    const output = parseContentStream(edited.newContentBytes);
    const sibling = output.find(inst => inst.operator === '"')!;
    expect(sibling.operands.map(serializeToString)).toEqual(['7', '2', '()']);
    const expected = ascii(`${start}(new words) ' 7 2 () "${end}`);
    expectSameGlyphs(glyphs(edited.newContentBytes, f), glyphs(expected, f));
  });

  it.each(["'", '"'] as const)('preserves %s state when symbol fallback splits the show', operator => {
    const spacing = operator === '"' ? '7 2 ' : '';
    const f = fixture(ascii(`${start}${spacing}(old) ${operator}${end}`));
    const before = interpretPage(f.bytes, f.page, f.objects).textRuns;
    const edited = applyTextEdits(f.bytes, f.page, f.objects, [
      { targetRun: before[0], newText: 'new •' },
      { targetRun: before.at(-1)!, newText: 'changed' },
    ]);
    const instructions = parseContentStream(edited.newContentBytes);
    const leadingIndex = instructions.findIndex(inst => inst.operator === 'TL');
    const prefix = instructions.slice(leadingIndex + 2, leadingIndex + (operator === '"' ? 5 : 3));
    expect(prefix.map(inst => inst.operator)).toEqual(operator === '"' ? ['Tw', 'Tc', 'T*'] : ['T*']);
    if (operator === '"') expect(prefix.slice(0, 2).map(inst => (inst.operands[0] as PDFNumber).value)).toEqual([7, 2]);
    const text = interpretPage(edited.newContentBytes, f.page, f.objects).textRuns;
    expect(text.map(run => run.text).join('')).toBe('new •tailchanged');
    expect(text[0].glyphs[0].tRm.e).toBe(40);
    expect(text[0].glyphs[0].tRm.f).toBe(682);
    expect(text.at(-1)!.glyphs[0].tRm.f).toBe(664);
    const tail = instructions.find(inst => inst.operands[0] instanceof PDFString && inst.operands[0].value === 'tail')!;
    expect(tail.operator).toBe('Tj');
  });
});
