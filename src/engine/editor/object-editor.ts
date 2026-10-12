/**
 * Object editor — apply transforms / delete objects in content streams.
 * Public API matches editing tests: async (doc, pageIndex, obj, ...).
 */

import {
  PDFName,
  PDFNumber,
  type PDFDocumentData,
  type PDFObject,
} from '../types';
import { getPageContentBytes } from '../parser/parser';
import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { compileInstructions } from './text-editor';
import { updatePageContent } from './stream-compiler';
import { IDENTITY, mulMatrix, invertMatrix, ctmAtEnd } from './matrix';
import type { EditableObject } from '../editing/scene-graph';
import type { ImageItem } from '../content/interpreter';

function op(operator: string, operands: PDFObject[] = []): CSInstruction {
  return { operator, operands, offset: 0 };
}

function numVal(obj: PDFObject | undefined): number {
  return obj instanceof PDFNumber ? obj.value : 0;
}

function doOperandName(inst: CSInstruction): string {
  const op0 = inst.operands[0];
  return op0 instanceof PDFName ? op0.name.replace(/^\//, '') : '';
}

/**
 * Apply a full CTM to an object by wrapping/replacing its placement matrix.
 */
export async function applyObjectTransform(
  doc: PDFDocumentData,
  pageIndex: number,
  obj: EditableObject,
  newCtm: number[],
): Promise<void> {
  const page = doc.pages[pageIndex];
  const contentBytes = getPageContentBytes(page, doc.objects);
  const instructions = parseContentStream(contentBytes);
  const targetIndex = findObjectInstructionIndex(instructions, obj);
  if (targetIndex < 0) return;

  if (obj.kind === 'image') {
    await applyImageTransform(instructions, targetIndex, obj, newCtm, page, doc);
    return;
  }

  // Generic: wrap with q / cm / Q using delta from identity toward newCtm
  let start = targetIndex;
  if (obj.kind === 'path') {
    while (start > 0) {
      const prev = instructions[start - 1].operator;
      if (['m', 'l', 'c', 'v', 'y', 'h', 're', 'w', 'J', 'j', 'RG', 'rg', 'G', 'g', 'K', 'k', 'CS', 'cs', 'SC', 'sc'].includes(prev)) {
        start--;
      } else break;
    }
  }

  if (obj.kind === 'path') {
    const tdx = newCtm[4] - obj.ctm[4];
    const tdy = newCtm[5] - obj.ctm[5];
    for (let i = start; i <= targetIndex; i++) {
      const inst = instructions[i];
      if (inst.operator === 're' && inst.operands.length >= 4) {
        inst.operands[0] = new PDFNumber(numVal(inst.operands[0]) + tdx);
        inst.operands[1] = new PDFNumber(numVal(inst.operands[1]) + tdy);
      } else if ((inst.operator === 'm' || inst.operator === 'l') && inst.operands.length >= 2) {
        inst.operands[0] = new PDFNumber(numVal(inst.operands[0]) + tdx);
        inst.operands[1] = new PDFNumber(numVal(inst.operands[1]) + tdy);
      }
    }
    const next = compileInstructions(instructions);
    await updatePageContent(page.contentRefs, next, doc.objects);
    return;
  }

  // Fallback wrap
  const cmOps = newCtm.map(n => new PDFNumber(n));
  instructions.splice(start, 0, op('q'), op('cm', cmOps));
  instructions.splice(targetIndex + 3, 0, op('Q'));
  const next = compileInstructions(instructions);
  await updatePageContent(page.contentRefs, next, doc.objects);
}

/**
 * Move/resize an image without disturbing shared clips/text.
 *
 * Strategy: remove only the image's own placement (`cm`/`Do`, or a tight
 * image-only `q…Q`), then append a fresh unclipped `q cm Do Q` at the new
 * CTM. Never translate/strip geometry in a shared graphics block — that was
 * cropping certificate text when the logo moved.
 */
async function applyImageTransform(
  instructions: CSInstruction[],
  targetIndex: number,
  obj: EditableObject,
  newCtm: number[],
  page: PDFDocumentData['pages'][number],
  doc: PDFDocumentData,
): Promise<void> {
  const img = obj.source as ImageItem | undefined;
  const imgName = (
    doOperandName(instructions[targetIndex]) ||
    img?.name ||
    ''
  ).replace(/^\//, '');
  if (!imgName) return;

  let cmIdx = -1;
  for (let j = targetIndex - 1; j >= Math.max(0, targetIndex - 20); j--) {
    if (instructions[j].operator === 'cm' && instructions[j].operands.length >= 6) {
      cmIdx = j;
      break;
    }
  }

  let removeStart = cmIdx >= 0 ? cmIdx : targetIndex;
  let removeEnd = targetIndex;

  // If wrapped in a tight image-only q…Q, remove the whole wrapper
  // (optional dedicated clip + cm + Do only — no text/paint/other Do).
  if (removeStart > 0 && instructions[removeStart - 1].operator === 'q') {
    const qStart = removeStart - 1;
    let depth = 0;
    let qEnd = -1;
    for (let j = removeEnd + 1; j < instructions.length; j++) {
      if (instructions[j].operator === 'q') depth++;
      else if (instructions[j].operator === 'Q') {
        if (depth === 0) { qEnd = j; break; }
        depth--;
      }
    }
    if (qEnd > removeEnd) {
      let foreign = false;
      for (let j = qStart + 1; j < qEnd; j++) {
        if (j === targetIndex || j === cmIdx) continue;
        const o = instructions[j].operator;
        if (
          o === 'Do' ||
          o === 'BT' || o === 'ET' || o === 'Tj' || o === 'TJ' || o === 'Tf' ||
          o === "'" || o === '"' || o === 'Td' || o === 'TD' || o === 'Tm' || o === 'T*' ||
          o === 'f' || o === 'F' || o === 'f*' || o === 'S' || o === 's' ||
          o === 'B' || o === 'b' || o === 'B*' || o === 'b*'
        ) {
          foreign = true;
          break;
        }
        // Allowed in image-only block: clip path construction + W/n, cm
        if (!['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*', 'n', 'cm', 'q', 'Q', 'gs', 'rg', 'RG', 'g', 'G', 'k', 'K', 'CS', 'cs', 'SC', 'sc', 'SCN', 'scn', 'w', 'J', 'j', 'M', 'd', 'ri', 'i'].includes(o)) {
          foreign = true;
          break;
        }
      }
      if (!foreign) {
        removeStart = qStart;
        removeEnd = qEnd;
      }
    }
  }

  // Remove old placement first, then append an unclipped placement at the
  // end so the image paints above existing content and never mutates shared
  // clips.
  instructions.splice(removeStart, removeEnd - removeStart + 1);

  // `newCtm` is expressed in page space. The appended `cm` is applied on top
  // of whatever CTM is live at the end of the stream (e.g. the
  // `1 0 0 -1 0 842 cm` flip that cairo/Firefox PDFs open with), so convert:
  //   M × base = newCtm  →  M = newCtm × base⁻¹
  const base = ctmAtEnd(instructions);
  const local = mulMatrix(newCtm, invertMatrix(base) ?? IDENTITY);

  const simple = Math.abs(local[1]) < 0.001 && Math.abs(local[2]) < 0.001;
  const placementCtm = simple
    ? [local[0], 0, 0, local[3], local[4], local[5]]
    : local;

  const placement: CSInstruction[] = [
    op('q'),
    op('cm', placementCtm.map(n => new PDFNumber(n))),
    op('Do', [new PDFName(imgName)]),
    op('Q'),
  ];
  instructions.push(...placement);

  const next = compileInstructions(instructions);
  await updatePageContent(page.contentRefs, next, doc.objects);
}

/** Delete an object from the page content stream. */
export async function deleteObject(
  doc: PDFDocumentData,
  pageIndex: number,
  obj: EditableObject,
): Promise<void> {
  const page = doc.pages[pageIndex];
  const contentBytes = getPageContentBytes(page, doc.objects);
  const instructions = parseContentStream(contentBytes);
  const targetIndex = findObjectInstructionIndex(instructions, obj);
  if (targetIndex < 0) {
    throw new Error('Could not locate object in content stream — refuse to delete');
  }

  let start = targetIndex;
  let end = targetIndex;

  if (obj.kind === 'image') {
    // ONLY remove a tight image placement block. Never peel an outer q/Q that
    // wraps other page content — that blanks the whole page.
    // Allowed patterns:
    //   q cm Do Q   (contiguous)
    //   cm Do
    //   Do
    if (
      targetIndex >= 2 &&
      targetIndex + 1 < instructions.length &&
      instructions[targetIndex - 2].operator === 'q' &&
      instructions[targetIndex - 1].operator === 'cm' &&
      instructions[targetIndex].operator === 'Do' &&
      instructions[targetIndex + 1].operator === 'Q'
    ) {
      start = targetIndex - 2;
      end = targetIndex + 1;
    } else if (
      targetIndex >= 1 &&
      instructions[targetIndex - 1].operator === 'cm' &&
      instructions[targetIndex].operator === 'Do'
    ) {
      start = targetIndex - 1;
      end = targetIndex;
    }
    // else: just the Do at targetIndex
  } else if (obj.kind === 'path') {
    while (start > 0) {
      const prev = instructions[start - 1].operator;
      if (['m', 'l', 'c', 'v', 'y', 'h', 're', 'w', 'J', 'j', 'RG', 'rg', 'G', 'g', 'K', 'k'].includes(prev)) {
        start--;
      } else break;
    }
  } else if (obj.kind === 'text') {
    for (let i = targetIndex; i >= 0; i--) {
      if (instructions[i].operator === 'BT') { start = i; break; }
    }
    for (let i = targetIndex; i < instructions.length; i++) {
      if (instructions[i].operator === 'ET') { end = i; break; }
    }
  }

  instructions.splice(start, end - start + 1);
  const next = compileInstructions(instructions);
  await updatePageContent(page.contentRefs, next, doc.objects);
}

/**
 * Locate the content-stream instruction for an editable object.
 * Images: never fall back to "first Do" — that blanks pages when a Form
 * XObject or another image is matched by mistake.
 */
export function findObjectInstructionIndex(
  instructions: CSInstruction[],
  obj: EditableObject,
): number {
  if (obj.kind === 'image') {
    const img = obj.source as ImageItem | undefined;
    const targetName = (img?.name || '').replace(/^\//, '');
    const sourceIdx = img?.sourceInstructionIndex;

    // Prefer the exact instruction index captured during interpretation
    if (
      sourceIdx != null &&
      sourceIdx >= 0 &&
      sourceIdx < instructions.length &&
      instructions[sourceIdx].operator === 'Do'
    ) {
      const name = doOperandName(instructions[sourceIdx]);
      if (!targetName || name === targetName) return sourceIdx;
    }

    let bestIdx = -1;
    let bestScore = Infinity;
    const nameMatches: number[] = [];

    for (let i = 0; i < instructions.length; i++) {
      if (instructions[i].operator !== 'Do') continue;
      const name = doOperandName(instructions[i]);

      // Name mismatch → skip (critical: don't delete Form XObjects named differently)
      if (targetName && name && name !== targetName) continue;
      if (targetName && name === targetName) nameMatches.push(i);

      // Score by nearest preceding cm vs object CTM / bbox
      let score = targetName && name === targetName ? 0 : 50;
      let foundCm = false;
      for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
        if (instructions[j].operator !== 'cm' || instructions[j].operands.length < 6) continue;
        foundCm = true;
        const a = numVal(instructions[j].operands[0]);
        const d = numVal(instructions[j].operands[3]);
        const e = numVal(instructions[j].operands[4]);
        const f = numVal(instructions[j].operands[5]);
        score += Math.abs(e - obj.bbox.x) + Math.abs(f - obj.bbox.y);
        score += Math.abs(Math.abs(a) - obj.bbox.width) * 0.25;
        score += Math.abs(Math.abs(d) - obj.bbox.height) * 0.25;
        if (obj.ctm.length >= 6) {
          score += Math.abs(e - obj.ctm[4]) + Math.abs(f - obj.ctm[5]);
        }
        break;
      }
      if (!foundCm) score += 200;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    // Unique resource name match is authoritative even if CTM scoring is loose
    if (nameMatches.length === 1) return nameMatches[0];
    if (bestIdx >= 0 && bestScore < 120) return bestIdx;
    return -1;
  }

  if (obj.kind === 'path') {
    const paintOps = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < instructions.length; i++) {
      if (!paintOps.has(instructions[i].operator)) continue;
      for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
        if (instructions[j].operator === 're' && instructions[j].operands.length >= 4) {
          const x = numVal(instructions[j].operands[0]);
          const y = numVal(instructions[j].operands[1]);
          const w = numVal(instructions[j].operands[2]);
          const h = numVal(instructions[j].operands[3]);
          const dx = Math.abs(x - obj.bbox.x);
          const dy = Math.abs(y - obj.bbox.y);
          const dw = Math.abs(w - obj.bbox.width);
          const dh = Math.abs(h - obj.bbox.height);
          if (dx < 8 && dy < 8 && dw < 8 && dh < 8) {
            const score = dx + dy + dw + dh;
            if (score < bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }
        }
      }
    }
    if (bestIdx >= 0) return bestIdx;
    return -1;
  }

  if (obj.kind === 'text') {
    if (obj.contentRange) return obj.contentRange.startOp;
    for (let i = 0; i < instructions.length; i++) {
      if (instructions[i].operator === 'Tj' || instructions[i].operator === 'TJ') return i;
    }
  }

  return -1;
}
