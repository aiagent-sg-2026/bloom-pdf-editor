import { parseContentStream, type CSInstruction } from './operator-lexer';
import { compileInstructions } from '../editor/text-editor';
import { interpretPage, type FontInfo, type Matrix } from './interpreter';
import {
  PDFArray,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFString,
  PDFHexString,
} from '../types';
import type { PDFPageInfo } from '../types';
import { getCharCodeLength } from '../fonts/cmap-parser';

/** Shared with flow column detection: smaller gaps are kerning/word spacing. */
export const COLUMN_GUTTER_FACTOR = 1.35;

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f,
  };
}

function inverse(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

function translation(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function countGlyphs(obj: PDFObject, font: FontInfo | undefined): number {
  if (obj instanceof PDFArray) {
    let count = 0;
    for (const item of obj.items) count += countGlyphs(item, font);
    return count;
  }
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const bytes = obj.toBytes();
    if (!font?.isComposite) return bytes.length;
    let count = 0;
    for (let offset = 0; offset < bytes.length; count++) {
      offset += getCharCodeLength(bytes, offset, font.codeSpaceRanges);
    }
    return count;
  }
  return 0;
}

function restoreDelta(from: Matrix, to: Matrix): [number, number] {
  const de = to.e - from.e;
  const df = to.f - from.f;
  const det = from.a * from.d - from.b * from.c;
  if (Math.abs(det) < 1e-9) return [de, df];
  return [(de * from.d - df * from.c) / det, (from.a * df - from.b * de) / det];
}

/**
 * Split only large TJ numeric gaps into independently editable Tj operations.
 * The original interpreter supplies the exact page-space start matrix for each
 * piece, which avoids duplicating font, spacing, composite-code, and CTM logic.
 * Runs may span several shows; source instruction boundaries identify the
 * current TJ's glyphs without resetting its continuing text matrix.
 */
export function explodeTJGaps(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): Uint8Array {
  const instructions = parseContentStream(contentBytes);
  const original = interpretPage(contentBytes, page, objects);
  const out: CSInstruction[] = [];
  let ctm: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let lineMatrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let fontSize = 12;
  let hScale = 1;
  let rise = 0;
  let leading = 0;
  const ctmStack: Matrix[] = [];
  let fontName = '';
  const fontStack: string[] = [];
  const sourceFonts: Array<FontInfo | undefined> = [];
  let dirtyLineMatrix: { absolute: Matrix; original: Matrix } | undefined;

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.operator === 'q') fontStack.push(fontName);
    else if (inst.operator === 'Q' && fontStack.length) fontName = fontStack.pop()!;
    else if (inst.operator === 'Tf' && inst.operands[0] instanceof PDFName) fontName = inst.operands[0].name;
    const font = original.fonts.get(fontName);
    sourceFonts[i] = font;
    // An exploded piece replaces both the text and line matrices. Keep that
    // replacement until the original stream moves to another line; text-show
    // operators only advance the text matrix and must not trigger restoration.
    if (dirtyLineMatrix && LINE_MOVE_OPS.has(inst.operator)) {
      const [tx, ty] = restoreDelta(dirtyLineMatrix.absolute, dirtyLineMatrix.original);
      out.push({ operator: 'Td', operands: [new PDFNumber(tx), new PDFNumber(ty)], offset: inst.offset });
      dirtyLineMatrix = undefined;
    }

    if (inst.operator === 'q') ctmStack.push({ ...ctm });
    else if (inst.operator === 'Q' && ctmStack.length) ctm = ctmStack.pop()!;
    else if (inst.operator === 'cm') {
      const n = inst.operands.map(o => o instanceof PDFNumber ? o.value : 0);
      ctm = multiply({ a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] }, ctm);
    } else if (inst.operator === 'Tf') {
      fontSize = inst.operands[1] instanceof PDFNumber ? inst.operands[1].value : fontSize;
    } else if (inst.operator === 'Tz') {
      hScale = (inst.operands[0] instanceof PDFNumber ? inst.operands[0].value : 100) / 100;
    } else if (inst.operator === 'Ts') {
      rise = inst.operands[0] instanceof PDFNumber ? inst.operands[0].value : 0;
    } else if (inst.operator === 'TL') {
      leading = inst.operands[0] instanceof PDFNumber ? inst.operands[0].value : leading;
    } else if (inst.operator === 'Tm') {
      const n = inst.operands.map(o => o instanceof PDFNumber ? o.value : 0);
      lineMatrix = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
      dirtyLineMatrix = undefined;
    } else if (inst.operator === 'Td' || inst.operator === 'TD') {
      const tx = inst.operands[0] instanceof PDFNumber ? inst.operands[0].value : 0;
      const ty = inst.operands[1] instanceof PDFNumber ? inst.operands[1].value : 0;
      lineMatrix = multiply(translation(tx, ty), lineMatrix);
      if (inst.operator === 'TD') leading = -ty;
    } else if (inst.operator === 'T*' || inst.operator === "'" || inst.operator === '"') {
      lineMatrix = multiply(translation(0, -leading), lineMatrix);
    } else if (inst.operator === 'BT') {
      lineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      dirtyLineMatrix = undefined;
    } else if (inst.operator === 'ET') {
      dirtyLineMatrix = undefined;
    }

    if (inst.operator !== 'TJ' || !(inst.operands[0] instanceof PDFArray)) {
      out.push(inst);
      continue;
    }

    const arr = inst.operands[0];
    const run = original.textRuns.find(r => r.sourceInstructionIndices?.includes(i));
    if (!run) { out.push(inst); continue; }
    // interpretPage merges adjacent shows, even across Tf. Piece starts are
    // local to this TJ, so skip glyphs belonging to earlier shows in the run.
    let glyphCount = 0;
    for (const sourceIndex of run.sourceInstructionIndices ?? []) {
      if (sourceIndex === i) break;
      for (const operand of instructions[sourceIndex].operands) {
        glyphCount += countGlyphs(operand, sourceFonts[sourceIndex]);
      }
    }
    const pieces: PDFObject[][] = [[]];
    const starts: number[] = [glyphCount];
    let split = false;
    for (let j = 0; j < arr.length; j++) {
      const item = arr.get(j)!;
      if (item instanceof PDFNumber) {
        if (Math.abs(item.value) / 1000 >= COLUMN_GUTTER_FACTOR) {
          pieces.push([]);
          starts.push(glyphCount);
          split = true;
        } else {
          pieces[pieces.length - 1].push(item);
        }
      } else {
        pieces[pieces.length - 1].push(item);
        glyphCount += countGlyphs(item, font);
      }
    }
    if (!split || pieces.some((p, n) => n > 0 && !p.some(o => o instanceof PDFString || o instanceof PDFHexString))) {
      out.push(inst);
      continue;
    }

    for (let p = 0; p < pieces.length; p++) {
      const glyph = run.glyphs[starts[p]];
      if (!glyph) continue;
      if (p > 0) {
        const tState: Matrix = { a: fontSize * hScale, b: 0, c: 0, d: fontSize, e: 0, f: rise };
        const textMatrix = multiply(multiply(inverse(tState), glyph.tRm), inverse(ctm));
        out.push({ operator: 'Tm', operands: [
          new PDFNumber(textMatrix.a), new PDFNumber(textMatrix.b), new PDFNumber(textMatrix.c),
          new PDFNumber(textMatrix.d), new PDFNumber(textMatrix.e), new PDFNumber(textMatrix.f),
        ], offset: inst.offset });
      }
      const strings = pieces[p].filter(o => o instanceof PDFString || o instanceof PDFHexString);
      const operands = pieces[p].filter(o => o instanceof PDFString || o instanceof PDFHexString || o instanceof PDFNumber);
      if (strings.length === 1 && operands.length === 1) {
        out.push({ operator: 'Tj', operands: [strings[0]], offset: inst.offset });
      } else {
        out.push({ operator: 'TJ', operands: [new PDFArray(operands)], offset: inst.offset });
      }
    }
    const last = run.glyphs[starts[starts.length - 1]]?.tRm;
    if (last) {
      const tState: Matrix = { a: fontSize * hScale, b: 0, c: 0, d: fontSize, e: 0, f: rise };
      const lastText = multiply(multiply(inverse(tState), last), inverse(ctm));
      dirtyLineMatrix = { absolute: lastText, original: { ...lineMatrix } };
    }
  }
  return splitBytesEqual(out, instructions) ? contentBytes : compileInstructions(out);
}

const LINE_MOVE_OPS = new Set(['Td', 'TD', 'T*', "'", '"']);

function splitBytesEqual(out: CSInstruction[], original: CSInstruction[]): boolean {
  return out.length === original.length && out.every((x, i) => x === original[i]);
}
