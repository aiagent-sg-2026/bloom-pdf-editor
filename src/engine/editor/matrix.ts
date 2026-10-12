/**
 * Small PDF matrix helpers shared by the object and text editors.
 * Matrices are [a b c d e f] in the PDF row-vector convention.
 */
import { PDFNumber, type PDFObject } from '../types';
import type { CSInstruction } from '../content/operator-lexer';

export type Matrix = number[];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function numVal(obj: PDFObject | undefined): number {
  return obj instanceof PDFNumber ? obj.value : 0;
}

/** PDF matrix product: apply `m` first, then `n` (row-vector convention). */
export function mulMatrix(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function invertMatrix(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** CTM in effect after the last instruction (tracks cm / q / Q). */
export function ctmAtEnd(instructions: CSInstruction[]): Matrix {
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  for (const inst of instructions) {
    if (inst.operator === 'q') {
      stack.push(ctm);
    } else if (inst.operator === 'Q') {
      ctm = stack.pop() ?? ctm;
    } else if (inst.operator === 'cm' && inst.operands.length >= 6) {
      ctm = mulMatrix(inst.operands.slice(0, 6).map(numVal), ctm);
    }
  }
  return ctm;
}


/** CTM in effect just before instructions[index] runs. */
export function ctmBefore(instructions: CSInstruction[], index: number): Matrix {
  return ctmAtEnd(instructions.slice(0, Math.max(0, index)));
}

/** Map a delta through the inverse of a matrix's linear part (translation ignored). */
export function deltaThroughInverse(m: Matrix, dx: number, dy: number): { dx: number; dy: number } {
  const inv = invertMatrix([m[0], m[1], m[2], m[3], 0, 0]);
  if (!inv) return { dx, dy };
  return { dx: dx * inv[0] + dy * inv[2], dy: dx * inv[1] + dy * inv[3] };
}
