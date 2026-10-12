/**
 * Document flow builder — assembles lines and paragraphs from raw PDF runs.
 */

import type { TextRun } from '../content/interpreter';
import { reconstructLines, resetLineIdCounter } from './line-reconstruction';
import { reconstructParagraphs, resetParagraphIdCounter } from './paragraph';
import type { DocumentFlow } from './types';

export function buildDocumentFlow(runs: TextRun[]): DocumentFlow {
  resetLineIdCounter();
  resetParagraphIdCounter();

  const lines = reconstructLines(runs);
  const paragraphs = reconstructParagraphs(lines);

  return {
    lines,
    paragraphs,
    rawRuns: runs,
  };
}

export { reconstructLines } from './line-reconstruction';
export { reconstructParagraphs } from './paragraph';
export { applyLineTextEdit, buildLayoutPlan, correctLineResidualGaps } from './flow-editor';
export { hitTestTextLine, findNearestTextLine, caretIndexFromLineX, lineXFromCaretIndex } from './hit-test';
export { distributeTextToSegments, distributeTextChangeToSegments, segmentAtIndex, computeLineWidthDelta } from './reflow';
export {
  analyzeJustification,
  distributeJustifiedSpace,
  gapToTJSpacing,
  distributeGlue,
  opticalMarginAdjust,
} from './justification';
export { detectTabSplitIndex, detectJustifiedBodyText, shouldUseFlowDraw, measureWordGaps, detectColumnSplitIndices } from './justification-detect';
export {
  detectTablesOnPage,
  hitTestTableCell,
  getTableRowLines,
  findCellForLine,
} from './table-detect';
export type { DetectedTable, TableCell } from './table-detect';
export {
  computeBaseline,
  getRunBounds,
  averageCharWidth,
  averageLetterWidth,
  estimateSpaceWidth,
  estimateTextWidth,
  visualFontSize,
  fontNameStyleFlags,
  resolveRunStyleFlags,
} from './metrics';
export { greedyWrap, previewWrap, knuthPlassWrap } from './line-break';
export type { KnuthPlassOptions } from './line-break';
export { hyphenateBreaks, hyphenateWord } from './hyphenation';
export {
  computeLayoutPlan,
  computeEditPreview,
  computeHorizontalShifts,
  computeHorizontalShiftsFromEdits,
  computeLineHeight,
  findParagraphForLine,
} from './layout';
export {
  computeFlowDrawPositions,
  buildLineDrawMap,
  buildFlowDrawIndex,
  shouldPackLine,
  lineHasAnomalousIntraWordGaps,
} from './flow-draw';
export { shapeText, measureText, layoutShapedGlyphs } from './shaping';
export {
  applyStyleToSelection,
  moveUnderlinesWithRuns,
  applyStyleToLine,
  applyStyleToSelectionOnPage,
  collectBatchedFontSizeTrailingShifts,
  mapSelectionToSegments,
  resolveStyledFontName,
  duplicateLineBelow,
  duplicateTableRowBelow,
  insertTableColumnRight,
} from './style-edit';
export type { TextStylePatch, StyleEditResult } from './style-edit';

export {
  resolveBidiLevels,
  reorderForDisplay,
  visualToLogical,
  logicalToVisual,
  bidiClassOf,
} from './bidi';
export type { BidiClass } from './bidi';
export {
  graphemeClusters,
  graphemeIndexFromCharIndex,
  charIndexFromGraphemeIndex,
  moveCaret,
  snapCaretToGrapheme,
} from './caret';
export {
  lineSelectionToQuadPoints,
  multiLineSelectionToQuadPoints,
  quadPointsToRect,
} from './selection-quads';
export type { LayoutPlan, LineTextEdit, RunShift } from './layout';
export type { FlowGlyphDraw } from './flow-draw';
export type { ShapedGlyph } from './shaping';

export type {
  DocumentFlow,
  TextLine,
  Paragraph,
  StyledSegment,
  SegmentEdit,
} from './types';
