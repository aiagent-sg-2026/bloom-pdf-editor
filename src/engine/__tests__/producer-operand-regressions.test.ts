import { describe, expect, it } from 'vitest';
import { parseContentStream } from '../content/operator-lexer';
import { interpretPage } from '../content/interpreter';
import { applyTextEdits, compileInstructions } from '../editor/text-editor';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { PDFNumber } from '../types';
import { encode, rawProducerPdf } from './producer-integrity.helpers';

const resources = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >> >> >>';

describe('producer operand regressions', () => {
  it.each([
    { source: '1e-3', value: 0.001 },
    { source: '-5E-1', value: -0.5 },
    { source: '+5e-1', value: 0.5 },
    { source: '1.2345e+2', value: 123.45 },
    { source: '.5', value: 0.5 },
    { source: '-.5', value: -0.5 },
    { source: '.0001', value: 0.0001 },
  ])('decodes $source as one numeric operand and emits legal decimal notation', ({ source, value }) => {
    // Exponents are non-standard PDF syntax, tolerated for producer robustness.
    const instructions = parseContentStream(encode(`q\r\n% fictional invoice\r\n${source} w\r\nQ\r\n`));
    expect(instructions.map(i => i.operator)).toEqual(['q', 'w', 'Q']);
    expect(instructions[1].operands).toEqual([new PDFNumber(value)]);
    const output = compileInstructions(instructions);
    expect(new TextDecoder().decode(output)).not.toMatch(/[eE][+-]?\d/);
    expect(parseContentStream(output).map(i => [i.operator, i.operands])).toEqual(instructions.map(i => [i.operator, i.operands]));
  });

  it('decodes exponent operands inside a TJ array without losing text or kerning', async () => {
    const content = 'BT /F1 12 Tf 40 700 Td [(Mira) 1e-3 (Vale)] TJ ET\r\n';
    const doc = await parsePDF(rawProducerPdf(content, resources));
    const page = doc.pages[0];
    const instructions = parseContentStream(getPageContentBytes(page, doc.objects));
    expect(instructions.map(i => i.operator)).toEqual(['BT', 'Tf', 'Td', 'TJ', 'ET']);
    const output = compileInstructions(instructions);
    const runs = interpretPage(output, page, doc.objects).textRuns;
    expect(runs.map(r => r.text)).toEqual(['MiraVale']);
    expect(runs[0].glyphs[4].tRm.e).toBeCloseTo(40 + 4 * 7.2 - 0.001 * 12 / 1000, 8);
    expect(runs[0].glyphs[4].tRm.f).toBe(700);
  });

  it.each([
    { name: 'negative gap crossed by a longer name', gap: -10000, replacement: 'Mira Frost of fictional North Harbor' },
    { name: 'positive gap with a longer name', gap: 5000, replacement: 'Mira Frost' },
    { name: 'positive gap with a shorter name', gap: 5000, replacement: 'Mi' },
  ])('keeps the untouched suffix origin for $name', async ({ gap, replacement }) => {
    const content = `BT /F1 12 Tf 40 700 Td [(Mira) ${gap} (Vale)] TJ 0 -18 Td (Total 42.50) Tj ET\r\n`;
    const doc = await parsePDF(rawProducerPdf(content, resources));
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    const before = interpretPage(bytes, page, doc.objects).textRuns;
    expect(before.map(r => r.text)).toEqual(['MiraVale', 'Total 42.50']);
    const edited = applyTextEdits(bytes, page, doc.objects, [{ targetRun: before[0], newText: `${replacement}Vale` }]);
    const after = interpretPage(edited.newContentBytes, page, doc.objects).textRuns;
    expect(after.map(r => r.text)).toEqual([`${replacement}Vale`, 'Total 42.50']);
    // Base-14 Courier has a 600/1000-em advance, independent of engine metrics.
    const suffixX = 40 + 4 * 0.6 * 12 - gap * 12 / 1000;
    for (const [index, glyph] of after[0].glyphs.slice(-4).entries()) {
      expect(glyph.tRm.e, `suffix glyph ${index}`).toBeCloseTo(suffixX + index * 7.2, 5);
      expect(glyph.tRm.f).toBe(700);
    }
    expect(after[1].glyphs.map(g => [g.unicode, g.tRm.e, g.tRm.f]))
      .toEqual(before[1].glyphs.map(g => [g.unicode, g.tRm.e, g.tRm.f]));
  });
});
