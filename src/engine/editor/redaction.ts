/**
 * Redaction — mark and apply irreversible content removal.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  type PDFDocumentData,
  type PDFObject,
  type PDFRectangle,
} from '../types';
import { getPageContentBytes, resolveRef } from '../parser/parser';
import { parseContentStream } from '../content/operator-lexer';
import { interpretPage } from '../content/interpreter';
import { compileInstructions } from './text-editor';
import { updatePageContent, concatBytes } from './stream-compiler';
import {
  createAnnotationDict,
  addAnnotationToPage,
  removeAnnotationFromPage,
  type RedactAnnotation,
} from './annotation-engine';
import { getNextObjNum } from '../writer/serializer';
import { quadPointsToRect } from '../flow/selection-quads';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ApplyRedactionsResult {
  redactedCount: number;
  removedOperatorCount: number;
  removedRuns: number;
  appliedRects: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/**
 * Union overlapping rectangles; leave disjoint ones separate.
 * Returns an array of merged rects.
 */
export function unionRects(rects: Rect[]): Rect[] {
  if (rects.length === 0) return [];
  const result: Rect[] = rects.map(r => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        if (rectsOverlap(result[i], result[j])) {
          const a = result[i];
          const b = result[j];
          const minX = Math.min(a.x, b.x);
          const minY = Math.min(a.y, b.y);
          const maxX = Math.max(a.x + a.width, b.x + b.width);
          const maxY = Math.max(a.y + a.height, b.y + b.height);
          result[i] = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          result.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }
  return result;
}

/** Mark a redaction annotation on a page. */
export function markRedaction(
  doc: PDFDocumentData,
  pageIndex: number,
  quadPoints: number[],
  color: [number, number, number] = [0, 0, 0],
  overlayText?: string,
): PDFRef {
  const page = doc.pages[pageIndex];
  const bounds = quadPointsToRect(quadPoints);
  const rect: PDFRectangle = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  const annot: RedactAnnotation = {
    type: 'Redact',
    rect,
    color,
    opacity: 0.4,
    quadPoints,
    overlayText,
  };

  const objNum = getNextObjNum(doc);
  const { dict } = createAnnotationDict(annot, objNum, doc.objects);
  const ref = new PDFRef(objNum, 0);
  addAnnotationToPage(page.dict, dict, ref, doc.objects);
  return ref;
}

/**
 * Apply all Redact annotations on a page.
 */
export async function applyRedactions(
  doc: PDFDocumentData,
  pageIndex: number,
): Promise<ApplyRedactionsResult> {
  const page = doc.pages[pageIndex];
  const redactRefs = collectRedactRefs(page.dict, doc.objects);
  if (redactRefs.length === 0) {
    return { redactedCount: 0, removedOperatorCount: 0, removedRuns: 0, appliedRects: 0 };
  }

  const redactRects: Rect[] = [];
  for (const { dict } of redactRefs) {
    const qp = dict.get('QuadPoints');
    if (qp instanceof PDFArray) {
      const nums: number[] = [];
      for (let i = 0; i < qp.length; i++) {
        const n = qp.get(i);
        if (n instanceof PDFNumber) nums.push(n.value);
      }
      if (nums.length >= 8) redactRects.push(quadPointsToRect(nums));
    } else {
      const r = dict.get('Rect');
      if (r instanceof PDFArray && r.length >= 4) {
        const x1 = (r.get(0) as PDFNumber).value;
        const y1 = (r.get(1) as PDFNumber).value;
        const x2 = (r.get(2) as PDFNumber).value;
        const y2 = (r.get(3) as PDFNumber).value;
        redactRects.push({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        });
      }
    }
  }

  const contentBytes = getPageContentBytes(page, doc.objects);
  const interpreted = interpretPage(contentBytes, page, doc.objects);
  const instructions = parseContentStream(contentBytes);

  const removeIndices = new Set<number>();
  let removedRuns = 0;
  for (const item of interpreted.displayList) {
    if (item.type !== 'text') continue;
    const run = item;
    const runRect: Rect = {
      x: run.x,
      y: run.y - run.fontSize * 0.2,
      width: Math.max(run.width, 1),
      height: Math.max(run.fontSize * 1.2, 1),
    };
    if (redactRects.some(rr => rectsOverlap(runRect, rr))) {
      removedRuns++;
      for (const idx of run.sourceInstructionIndices ?? []) {
        removeIndices.add(idx);
      }
      // Also remove surrounding BT/ET text block when possible
      const indices = run.sourceInstructionIndices ?? [];
      if (indices.length > 0) {
        const mid = indices[0];
        for (let i = mid; i >= 0; i--) {
          if (instructions[i]?.operator === 'BT') { removeIndices.add(i); break; }
          removeIndices.add(i);
        }
        for (let i = mid; i < instructions.length; i++) {
          removeIndices.add(i);
          if (instructions[i]?.operator === 'ET') break;
        }
      }
    }
  }

  const sorted = Array.from(removeIndices).sort((a, b) => b - a);
  let removedOperatorCount = 0;
  for (const idx of sorted) {
    if (idx >= 0 && idx < instructions.length) {
      instructions.splice(idx, 1);
      removedOperatorCount++;
    }
  }

  let bytes = compileInstructions(instructions);

  const fillParts: string[] = ['\nq', '0 0 0 rg'];
  for (const r of redactRects) {
    fillParts.push(`${r.x} ${r.y} ${r.width} ${r.height} re f`);
  }
  fillParts.push('Q\n');
  bytes = concatBytes(bytes, new TextEncoder().encode(fillParts.join('\n')));

  await updatePageContent(page.contentRefs, bytes, doc.objects);

  for (const { ref } of redactRefs) {
    removeAnnotationFromPage(page.dict, ref, doc.objects);
    doc.objects.delete(ref.toKey());
  }

  return {
    redactedCount: redactRefs.length,
    removedOperatorCount,
    removedRuns,
    appliedRects: redactRects.length,
  };
}

function collectRedactRefs(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
): Array<{ ref: PDFRef; dict: PDFDict }> {
  const result: Array<{ ref: PDFRef; dict: PDFDict }> = [];
  const annots = pageDict.get('Annots');
  if (!annots) return result;

  const arr = annots instanceof PDFRef ? resolveRef(annots, objects) : annots;
  if (!(arr instanceof PDFArray)) return result;

  for (let i = 0; i < arr.length; i++) {
    const item = arr.get(i);
    if (!(item instanceof PDFRef)) continue;
    const dict = resolveRef(item, objects);
    if (!(dict instanceof PDFDict)) continue;
    const subtype = dict.get('Subtype');
    if (subtype instanceof PDFName && subtype.name === 'Redact') {
      result.push({ ref: item, dict });
    }
  }
  return result;
}
