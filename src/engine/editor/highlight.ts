/**
 * Highlight / markup helpers from flow text selection.
 */

import {
  PDFRef,
  type PDFDocumentData,
  type PDFRectangle,
} from '../types';
import {
  createAnnotationDict,
  addAnnotationToPage,
  type HighlightAnnotation,
} from './annotation-engine';
import { getNextObjNum } from '../writer/serializer';
import type { TextLine } from '../flow/types';
import {
  lineSelectionToQuadPoints,
  multiLineSelectionToQuadPoints,
  quadPointsToRect,
} from '../flow/selection-quads';

export interface SelectionPos {
  lineIndex: number;
  charIndex: number;
}

/**
 * Add a Highlight (or other markup) annotation from a multi-line selection.
 * Returns null for empty selection.
 */
export function addHighlightFromSelection(
  doc: PDFDocumentData,
  pageIndex: number,
  lines: TextLine[],
  start: SelectionPos,
  end: SelectionPos,
  color: [number, number, number] = [1, 1, 0],
  subtype: HighlightAnnotation['type'] = 'Highlight',
): PDFRef | null {
  const quadPoints = multiLineSelectionToQuadPoints(
    lines,
    start.lineIndex,
    start.charIndex,
    end.lineIndex,
    end.charIndex,
  );
  if (quadPoints.length === 0) return null;
  return addMarkupAnnotation(doc, pageIndex, quadPoints, color, subtype);
}

/** Convenience: highlight a single line range. */
export function addHighlightFromLineSelection(
  doc: PDFDocumentData,
  pageIndex: number,
  line: TextLine,
  start: number,
  end: number,
  color: [number, number, number] = [1, 1, 0],
  subtype: HighlightAnnotation['type'] = 'Highlight',
): PDFRef | null {
  const quadPoints = lineSelectionToQuadPoints(line, start, end);
  if (quadPoints.length === 0) return null;
  return addMarkupAnnotation(doc, pageIndex, quadPoints, color, subtype);
}

export function addHighlightFromMultiLineSelection(
  doc: PDFDocumentData,
  pageIndex: number,
  lines: TextLine[],
  startLineIndex: number,
  startChar: number,
  endLineIndex: number,
  endChar: number,
  color: [number, number, number] = [1, 1, 0],
  subtype: HighlightAnnotation['type'] = 'Highlight',
): PDFRef | null {
  return addHighlightFromSelection(
    doc, pageIndex, lines,
    { lineIndex: startLineIndex, charIndex: startChar },
    { lineIndex: endLineIndex, charIndex: endChar },
    color, subtype,
  );
}

function addMarkupAnnotation(
  doc: PDFDocumentData,
  pageIndex: number,
  quadPoints: number[],
  color: [number, number, number],
  subtype: HighlightAnnotation['type'],
): PDFRef {
  const page = doc.pages[pageIndex];
  const bounds = quadPointsToRect(quadPoints);

  // Reject absurd geometry (e.g. padded line.height / empty-glyph fallbacks
  // that previously painted a full-width bar at the page bottom).
  const pageH = page.mediaBox.height || 792;
  const pageW = page.mediaBox.width || 612;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    bounds.width > pageW * 1.2 ||
    bounds.height > pageH * 0.25 ||
    bounds.height < 0.5
  ) {
    throw new Error(
      `Invalid highlight bounds: ${bounds.width.toFixed(1)}×${bounds.height.toFixed(1)} at (${bounds.x.toFixed(1)}, ${bounds.y.toFixed(1)})`,
    );
  }

  const rect: PDFRectangle = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  const annot: HighlightAnnotation = {
    type: subtype,
    rect,
    color,
    opacity: 0.4,
    quadPoints,
  };

  const objNum = getNextObjNum(doc);
  const { dict } = createAnnotationDict(annot, objNum, doc.objects);
  const ref = new PDFRef(objNum, 0);
  addAnnotationToPage(page.dict, dict, ref, doc.objects);
  return ref;
}
