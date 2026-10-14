import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes, resolveRef } from '../parser/parser';
import { interpretPage, type TextRun } from '../content/interpreter';
import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { applyTextEdits, compileInstructions } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { saveQuick, saveOptimized } from '../writer/save-pipeline';
import { deletePage, insertBlankPage } from '../writer/page-operations';
import {
  PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber,
  PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject,
} from '../types';

export const encode = (text: string) => new TextEncoder().encode(text);
export const unusualPrefix = 'q\r\n% Fictional producer operand probe\r\n1e-3 w\r\n.5 -.5 m\r\nn\r\nQ\r\n';
export const unusualOperators = ['q', 'w', 'm', 'n', 'Q'];
export const graphicsProbe = 'q\r\n1.2345 w\r\n.2 .3 .4 rg\r\n.4 .3 .2 RG\r\n30 40 400 600 re W n\r\n40 50 80 20 re B\r\nQ\r\n40 30 80 10 re S\r\n';
export const graphicsOperators = ['q', 'w', 'rg', 'RG', 're', 'W', 'n', 're', 'B', 'Q', 're', 'S'];

export interface ProducerFixture {
  name: string;
  bytes: Uint8Array;
  content: string;
  runs: ReadonlyArray<{ text: string; x: number; y: number; fontSize: number }>;
  targetIndex: number;
  replacement: string;
  operators: readonly string[];
}

export function rawStream(data: string, entries = ''): string {
  return `<< /Length ${encode(data).length} ${entries} >>\r\nstream\r\n${data}\r\nendstream`;
}

// The writer is independent of all engine serializers. All payloads are ASCII;
// multilingual text is represented by generated CID/ToUnicode hex mappings.
export function rawProducerPdf(
  content: string, resources: string,
  extraObjects: ReadonlyArray<readonly [number, string]> = [],
): Uint8Array {
  const dest = (page: number) => `[${page} 0 R /XYZ 40 700 null]`;
  const objects = new Map<number, string>([
    [1, `<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R /Dests 13 0 R /Names << /Dests << /Names [(invoice-1) ${dest(3)} (invoice-2) ${dest(4)} (invoice-3) ${dest(5)}] >> >> >>`],
    [2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'],
    [9, '<< /Type /Outlines /First 10 0 R /Last 12 0 R /Count 3 >>'],
    [13, `<< /invoice-1 ${dest(3)} /invoice-2 ${dest(4)} /invoice-3 ${dest(5)} >>`],
    ...extraObjects,
  ]);
  for (let i = 0; i < 3; i++) {
    objects.set(3 + i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${6 + i} 0 R >>`);
    objects.set(6 + i, rawStream(content));
    objects.set(10 + i, `<< /Title (Fictional invoice ${i + 1}) /Parent 9 0 R /Dest ${dest(3 + i)}${i > 0 ? ` /Prev ${9 + i} 0 R` : ''}${i < 2 ? ` /Next ${11 + i} 0 R` : ''} >>`);
  }
  let pdf = '%PDF-1.7\r\n';
  const offsets = new Map<number, number>();
  for (const [id, body] of [...objects].sort(([a], [b]) => a - b)) {
    offsets.set(id, encode(pdf).length);
    pdf += `${id} 0 obj\r\n${body}\r\nendobj\r\n`;
  }
  const xref = encode(pdf).length;
  const size = Math.max(...objects.keys()) + 1;
  pdf += `xref\r\n0 ${size}\r\n0000000000 65535 f\r\n`;
  for (let id = 1; id < size; id++) {
    pdf += offsets.has(id) ? `${String(offsets.get(id)).padStart(10, '0')} 00000 n\r\n` : '0000000000 00000 f\r\n';
  }
  return encode(`${pdf}trailer\r\n<< /Size ${size} /Root 1 0 R >>\r\nstartxref\r\n${xref}\r\n%%EOF\r\n`);
}

// Deliberately do not use the engine serializer as the operand oracle.
function operandValue(obj: PDFObject): unknown {
  if (obj instanceof PDFNumber || obj instanceof PDFBoolean) return obj.value;
  if (obj instanceof PDFString) return { string: [...obj.toBytes()] };
  if (obj instanceof PDFHexString) return { string: [...obj.toBytes()] };
  if (obj instanceof PDFName) return { name: obj.name };
  if (obj instanceof PDFRef) return { ref: obj.toKey() };
  if (obj instanceof PDFNull) return null;
  if (obj instanceof PDFArray) return obj.items.map(operandValue);
  if (obj instanceof PDFDict) return Object.fromEntries([...obj.entries()].map(([k, v]) => [k, operandValue(v)]));
  throw new Error('Unexpected stream operand');
}

function resourceValue(obj: PDFObject, objects: Map<string, PDFObject>): unknown {
  if (obj instanceof PDFRef) {
    const resolved = objects.get(obj.toKey());
    expect(resolved, `resource ${obj.toKey()}`).toBeDefined();
    return resourceValue(resolved!, objects);
  }
  if (obj instanceof PDFStream) return { dict: resourceValue(obj.dict, objects), bytes: [...obj.rawBytes] };
  if (obj instanceof PDFDict) return Object.fromEntries([...obj.entries()].map(([key, value]) => [key, resourceValue(value, objects)]));
  if (obj instanceof PDFArray) return obj.items.map(value => resourceValue(value, objects));
  return operandValue(obj);
}

function instructionValues(instructions: CSInstruction[]) {
  return instructions.map(inst => ({ operator: inst.operator, operands: inst.operands.map(operandValue) }));
}

function runValues(runs: TextRun[]) {
  return runs.map(run => ({
    text: run.text, x: run.glyphs[0].tRm.e, y: run.glyphs[0].tRm.f, fontSize: run.fontSize,
    bounds: [run.x, run.y],
    glyphs: run.glyphs.map(g => ({ text: g.unicode, x: g.tRm.e, y: g.tRm.f })),
  }));
}

function expectOracle(runs: TextRun[], fixture: ProducerFixture) {
  expect(runs.map(r => r.text), `${fixture.name}: independent strings`).toEqual(fixture.runs.map(r => r.text));
  runs.forEach((run, i) => {
    expect(run.glyphs[0].tRm.e, `${fixture.name}: run ${i} x`).toBeCloseTo(fixture.runs[i].x, 5);
    expect(run.glyphs[0].tRm.f, `${fixture.name}: run ${i} y`).toBeCloseTo(fixture.runs[i].y, 5);
    expect(run.fontSize, `${fixture.name}: run ${i} size`).toBe(fixture.runs[i].fontSize);
  });
}

function expectBalanced(instructions: CSInstruction[], original: CSInstruction[]) {
  for (const [open, close] of [['q', 'Q'], ['BDC', 'EMC']] as const) {
    const sequence = instructions.filter(i => i.operator === open || i.operator === close).map(i => i.operator);
    expect(sequence, `${open}/${close} sequence`).toEqual(original.filter(i => i.operator === open || i.operator === close).map(i => i.operator));
    let depth = 0;
    for (const op of sequence) {
      depth += op === open ? 1 : -1;
      expect(depth, `${open}/${close} underflow`).toBeGreaterThanOrEqual(0);
    }
    expect(depth, `${open}/${close} final depth`).toBe(0);
  }
  expect(instructionValues(instructions.filter(i => ['BDC', 'EMC'].includes(i.operator))))
    .toEqual(instructionValues(original.filter(i => ['BDC', 'EMC'].includes(i.operator))));
}

function pageSnapshot(doc: PDFDocumentData, index: number) {
  const page = doc.pages[index];
  const bytes = getPageContentBytes(page, doc.objects);
  const interpreted = interpretPage(bytes, page, doc.objects);
  return {
    bytes, runs: interpreted.textRuns, values: runValues(interpreted.textRuns),
    resources: resourceValue(page.resources, doc.objects),
    instructions: parseContentStream(bytes),
    // Includes state at paint time, not just an operator spelling comparison.
    graphics: interpreted.displayList.filter(item => item.type !== 'text'),
  };
}

function navigation(doc: PDFDocumentData) {
  const dict = (obj: PDFObject | undefined) => {
    const value = obj && resolveRef(obj, doc.objects);
    expect(value).toBeInstanceOf(PDFDict);
    return value as PDFDict;
  };
  const root = dict(doc.catalog.get('Outlines'));
  const outlines: unknown[] = [];
  const seen = new Set<string>();
  let next = root.get('First');
  while (next instanceof PDFRef) {
    expect(seen.has(next.toKey()), 'outline cycle').toBe(false);
    seen.add(next.toKey());
    const item = dict(next);
    expect(item.get('Parent')).toEqual(doc.catalog.get('Outlines'));
    outlines.push([item.getString('Title'), operandValue(item.get('Dest')!)]);
    next = item.get('Next');
  }
  expect(root.getNumber('Count')).toBe(outlines.length);
  const flat = dict(doc.catalog.get('Dests'));
  const names = dict(dict(doc.catalog.get('Names')).get('Dests')).getArray('Names')!;
  return { outlines, dests: operandValue(flat), names: operandValue(names) };
}

function expectedNavigation(pages: number[]) {
  const destination = (page: number) => [{ ref: `${page}_0` }, { name: 'XYZ' }, 40, 700, null];
  return {
    outlines: pages.map(page => [`Fictional invoice ${page - 2}`, destination(page)]),
    dests: Object.fromEntries(pages.map(page => [`invoice-${page - 2}`, destination(page)])),
    names: pages.flatMap(page => [{ string: [...encode(`invoice-${page - 2}`)] }, destination(page)]),
  };
}

const saveModes = [{ name: 'saveQuick', save: saveQuick }, { name: 'saveOptimized', save: saveOptimized }];

export function producerContracts(fixture: ProducerFixture) {
  describe(`${fixture.name} producer integrity`, () => {
    it.each(saveModes)('a/d: no-edit $name keeps semantics, operands and repeat parse stability', async ({ save }) => {
      const doc = await parsePDF(fixture.bytes);
      expect(doc.pages).toHaveLength(3);
      expect(navigation(doc)).toEqual(expectedNavigation([3, 4, 5]));
      const before = doc.pages.map((_, i) => pageSnapshot(doc, i));
      before.forEach(page => {
        expectOracle(page.runs, fixture);
        expect(page.bytes).toEqual(encode(fixture.content));
        expect(page.instructions.map(i => i.operator)).toEqual(fixture.operators);
      });
      const saved = await save(doc);
      for (let parse = 0; parse < 2; parse++) {
        const reopened = await parsePDF(saved);
        expect(reopened.pages).toHaveLength(3);
        expect(navigation(reopened)).toEqual(expectedNavigation([3, 4, 5]));
        reopened.pages.forEach((_, i) => {
          const after = pageSnapshot(reopened, i);
          expectOracle(after.runs, fixture);
          expect(after.values).toEqual(before[i].values);
          expect(after.bytes).toEqual(encode(fixture.content));
          expect(instructionValues(after.instructions)).toEqual(instructionValues(before[i].instructions));
          expect(after.graphics).toEqual(before[i].graphics);
          expect(after.resources).toEqual(before[i].resources);
          expectBalanced(after.instructions, before[i].instructions);
        });
      }
    });

    it('d: recompilation preserves unusual operands independently of saving raw bytes', async () => {
      const doc = await parsePDF(fixture.bytes);
      const before = pageSnapshot(doc, 0);
      expect(before.instructions.map(i => i.operator)).toEqual(fixture.operators);
      expect(before.instructions[1].operands.map(operandValue)).toEqual([0.001]);
      expect(before.instructions[2].operands.map(operandValue)).toEqual([0.5, -0.5]);
      const bytes = compileInstructions(before.instructions);
      const parsed = parseContentStream(bytes);
      expect(instructionValues(parsed)).toEqual(instructionValues(before.instructions));
      expectBalanced(parsed, before.instructions);
      expectOracle(interpretPage(bytes, doc.pages[0], doc.objects).textRuns, fixture);
      expect(runValues(interpretPage(bytes, doc.pages[0], doc.objects).textRuns)).toEqual(before.values);
    });

    it.each(saveModes)('b: editing one run through $name preserves all other runs and paint state', async ({ save }) => {
      const doc = await parsePDF(fixture.bytes);
      const before = pageSnapshot(doc, 0);
      expectOracle(before.runs, fixture);
      const result = applyTextEdits(before.bytes, doc.pages[0], doc.objects, [
        { targetRun: before.runs[fixture.targetIndex], newText: fixture.replacement },
      ]);
      await updatePageContent(doc.pages[0].contentRefs, result.newContentBytes, doc.objects);
      const saved = await save(doc);
      for (let parse = 0; parse < 2; parse++) {
        const reopened = await parsePDF(saved);
        const after = pageSnapshot(reopened, 0);
        expect(after.runs.map(r => r.text)).toEqual(fixture.runs.map((r, i) => i === fixture.targetIndex ? fixture.replacement : r.text));
        after.values.forEach((run, i) => {
          if (i !== fixture.targetIndex) {
            const expected = before.values[i];
            const label = `untouched run ${i}`;
            expect(run.text, `${label} text`).toBe(expected.text);
            expect(run.fontSize, `${label} font size`).toBe(expected.fontSize);
            expect(run.y, `${label} y`).toBe(expected.y);
            // TJ compensation preserves position, not its floating-point representation.
            expect(Math.abs(run.x - expected.x), `${label} x`).toBeLessThanOrEqual(1e-6);
            run.bounds.forEach((value, axis) => {
              expect(Math.abs(value - expected.bounds[axis]), `${label} bounds ${axis}`).toBeLessThanOrEqual(1e-6);
            });
            expect(run.glyphs.map(g => g.text), `${label} glyphs`).toEqual(expected.glyphs.map(g => g.text));
            run.glyphs.forEach((glyph, j) => {
              expect(Math.abs(glyph.x - expected.glyphs[j].x), `${label} glyph ${j} x`).toBeLessThanOrEqual(1e-6);
              expect(Math.abs(glyph.y - expected.glyphs[j].y), `${label} glyph ${j} y`).toBeLessThanOrEqual(1e-6);
            });
          } else {
            expect(run.x).toBeCloseTo(before.values[i].x, 5);
            expect(run.y).toBeCloseTo(before.values[i].y, 5);
          }
        });
        expect(after.graphics).toEqual(before.graphics);
        expect(after.resources).toEqual(before.resources);
        const probe = after.graphics.find(item => item.type === 'path' && item.paintType === 'both');
        expect(probe).toMatchObject({ lineWidth: 1.2345, fillColor: [0.2, 0.3, 0.4], strokeColor: [0.4, 0.3, 0.2] });
        expect(probe!.clipPaths).toHaveLength(1);
        expectBalanced(after.instructions, before.instructions);
        expect(instructionValues(after.instructions.filter(i => !['Tj', 'TJ', "'", '"'].includes(i.operator))))
          .toEqual(instructionValues(before.instructions.filter(i => !['Tj', 'TJ', "'", '"'].includes(i.operator))));
        expect(navigation(reopened)).toEqual(expectedNavigation([3, 4, 5]));
        for (const i of [1, 2]) expect(pageSnapshot(reopened, i).values).toEqual(before.values);
      }
    });

    it.each(saveModes)('c: deleting the middle page and inserting a blank through $name preserves surviving navigation', async ({ save }) => {
      const doc = await parsePDF(fixture.bytes);
      const original = pageSnapshot(doc, 0);
      deletePage(doc, 1);
      expect(doc.pages).toHaveLength(2);
      expect(navigation(doc)).toEqual(expectedNavigation([3, 5]));
      insertBlankPage(doc, 1);
      expect(doc.pages).toHaveLength(3);
      const saved = await save(doc);
      for (let parse = 0; parse < 2; parse++) {
        const reopened = await parsePDF(saved);
        expect(reopened.pages).toHaveLength(3);
        expect(reopened.pages.map(p => p.index)).toEqual([0, 1, 2]);
        expect(navigation(reopened)).toEqual(expectedNavigation([3, 5]));
        const root = resolveRef(reopened.catalog.get('Pages')!, reopened.objects) as PDFDict;
        expect(root.getNumber('Count')).toBe(3);
        expect(pageSnapshot(reopened, 1).runs).toEqual([]);
        expect(pageSnapshot(reopened, 1).graphics).toEqual([]);
        for (const i of [0, 2]) {
          const page = pageSnapshot(reopened, i);
          expectOracle(page.runs, fixture);
          expect(page.bytes).toEqual(encode(fixture.content));
          expect(page.instructions.map(inst => inst.operator)).toEqual(fixture.operators);
          expect(page.resources).toEqual(original.resources);
        }
      }
    });
  });
}
