/**
 * Line reconstruction — group absolute PDF runs into logical lines.
 *
 * Algorithm (baseline clustering, used by PDF.js / MuPDF / Acrobat):
 *   1. Compute baseline y for each run (median glyph y).
 *   2. Sort runs by baseline descending (top of page first in PDF coords).
 *   3. Greedy cluster: assign run to line if |baseline − lineBaseline| < ε.
 *   4. Sort runs within line by left edge (reading order).
 *   5. Detect justification from inter-run gap distribution.
 */

import type { TextRun } from '../content/interpreter';
import type { StyledSegment, TextLine } from './types';
import { computeBaseline, getRunBounds } from './metrics';
import { detectTabSplitIndex, detectJustifiedBodyText, detectColumnSplitIndices } from './justification-detect';

let lineIdCounter = 0;

function nextLineId(): string {
  lineIdCounter += 1;
  return `line-${lineIdCounter}`;
}

export function resetLineIdCounter(): void {
  lineIdCounter = 0;
}

function buildSegments(runs: TextRun[]): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let index = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const text = run.text;
    segments.push({
      run,
      startIndex: index,
      endIndex: index + text.length,
      text,
    });
    index += text.length;
  }
  return segments;
}

function detectJustification(runs: TextRun[], fontSize: number, text: string, tabSplitIndex: number): boolean {
  return detectJustifiedBodyText(runs, fontSize, text, tabSplitIndex);
}

function finalizeLine(runs: TextRun[]): TextLine {
  const sorted = [...runs].sort((a, b) => getRunBounds(a).left - getRunBounds(b).left);
  const segments = buildSegments(sorted);
  const text = sorted.map(r => r.text).join('');

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let fontSize = 12;
  let baselineSum = 0;

  for (let i = 0; i < sorted.length; i++) {
    const b = getRunBounds(sorted[i]);
    if (b.left < minX) minX = b.left;
    if (b.right > maxX) maxX = b.right;
    if (b.bottom < minY) minY = b.bottom;
    if (b.top > maxY) maxY = b.top;
    const runSize =
      sorted[i].glyphs[0]
        ? Math.sqrt(
            sorted[i].glyphs[0].tRm.c * sorted[i].glyphs[0].tRm.c +
            sorted[i].glyphs[0].tRm.d * sorted[i].glyphs[0].tRm.d,
          ) || sorted[i].fontSize || 12
        : sorted[i].fontSize || 12;
    fontSize = Math.max(fontSize, runSize);
    baselineSum += computeBaseline(sorted[i]);
  }

  const baseline = baselineSum / sorted.length;
  const tabSplitIndex = detectTabSplitIndex(sorted, fontSize);

  return {
    id: nextLineId(),
    runs: sorted,
    text,
    segments,
    baseline,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    leftMargin: minX,
    rightEdge: maxX,
    fontSize,
    isJustified: detectJustification(sorted, fontSize, text, tabSplitIndex),
    tabSplitIndex: -1, // Reset since we split on tabs now
  };
}

function processCluster(runs: TextRun[]): TextLine[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => getRunBounds(a).left - getRunBounds(b).left);

  // Largest font on the baseline. Do not floor at 12 pt: a 10 pt table row would then
  // need a 16.2 pt gutter instead of 13.5 pt and narrow-gutter cells would merge.
  let maxFontSize = 0;
  for (let i = 0; i < sorted.length; i++) {
    maxFontSize = Math.max(maxFontSize, sorted[i].fontSize || sorted[i].glyphs[0]?.fontSize || 12);
  }

  // Split multi-column table rows into separate editable cells
  const colSplits = detectColumnSplitIndices(sorted, maxFontSize);
  if (colSplits.length > 0) {
    const groups: TextRun[][] = [];
    let start = 0;
    for (const split of colSplits) {
      if (split >= start && split < sorted.length - 1) {
        groups.push(sorted.slice(start, split + 1));
        start = split + 1;
      }
    }
    if (start < sorted.length) groups.push(sorted.slice(start));
    if (groups.length > 1) {
      return groups.flatMap(g => processCluster(g));
    }
  }

  // Legacy single tab (title | date) when column detector found nothing
  const splitIdx = detectTabSplitIndex(sorted, maxFontSize);
  if (splitIdx >= 0 && splitIdx < sorted.length - 1) {
    const leftPart = sorted.slice(0, splitIdx + 1);
    const rightPart = sorted.slice(splitIdx + 1);
    return [...processCluster(leftPart), ...processCluster(rightPart)];
  }

  return [finalizeLine(sorted)];
}

/**
 * Group raw PDF text runs into logical lines.
 * Bold and regular fragments on the same baseline become one line.
 */
export function reconstructLines(runs: TextRun[]): TextLine[] {
  if (runs.length === 0) return [];

  const enriched = runs.map(run => ({
    run,
    baseline: computeBaseline(run),
    left: getRunBounds(run).left,
    fontSize: run.fontSize || run.glyphs[0]?.fontSize || 12,
  }));

  enriched.sort((a, b) => b.baseline - a.baseline || a.left - b.left);

  const clusters: TextRun[][] = [];

  for (let i = 0; i < enriched.length; i++) {
    const item = enriched[i];
    let placed = false;

    for (let c = 0; c < clusters.length; c++) {
      const cluster = clusters[c];
      const refBaseline = computeBaseline(cluster[0]);
      const refSize = cluster[0].fontSize || cluster[0].glyphs[0]?.fontSize || 12;
      const tolerance = Math.max(2, refSize * 0.35);

      if (Math.abs(item.baseline - refBaseline) <= tolerance) {
        cluster.push(item.run);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push([item.run]);
    }
  }

  const lines: TextLine[] = [];
  for (let i = 0; i < clusters.length; i++) {
    lines.push(...processCluster(clusters[i]));
  }
  lines.sort((a, b) => b.baseline - a.baseline);
  return lines;
}
