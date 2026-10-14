/**
 * Flow-aware text editing — commit full-line edits across styled runs.
 */

import { detectTablesOnPage, findCellForLine } from './table-detect';
import { interpretPage } from '../content/interpreter';
import type { TextRun } from '../content/interpreter';
import type { PDFObject, PDFPageInfo } from '../types';
import {
  applyTextEdits,
  applyRunPositionShifts,
  assertTextEncodable,
  loadFontForName,
  measureUnicodeExportText,
  type EditResult,
  type TextEdit,
  type RunPositionShift,
} from '../editor/text-editor';
import { distributeTextChangeToSegments, distributeTextToSegments } from './reflow';
import {
  computeLayoutPlan,
  computeHorizontalShifts,
  computeHorizontalShiftsFromEdits,
  findParagraphForLine,
  type LayoutPlan,
} from './layout';
import {
  estimateTextWidth,
  estimateTextWidthWithOverrides,
  getRunBounds,
  visualFontSize,
} from './metrics';
import type { DocumentFlow, TextLine } from './types';

/** Normalize bullets/dashes so "• " still matches rewritten "- ". */
function normalizeEditText(text: string): string {
  return text
    .replace(/^[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB•∙]\s*/, '- ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve post-edit runs for each segment. Prefer left-to-right same-baseline
 * peers when counts match — text match alone fails when "•" becomes "-".
 */
function resolveFreshSegmentRuns(
  runs: TextRun[],
  segmentEdits: { run: TextRun; newText: string }[],
  baseline: number,
  fontSize: number,
): TextRun[] | null {
  const tol = Math.max(2, fontSize * 0.35);
  const peers = runs
    .filter(r => {
      if ((r.sourceInstructionIndices ?? []).length === 0) return false;
      const bl = r.glyphs.length > 0 ? r.glyphs[0].tRm.f : r.y;
      return Math.abs(bl - baseline) <= tol;
    })
    .sort((a, b) => a.x - b.x || a.y - b.y);

  if (peers.length === segmentEdits.length) {
    return peers;
  }

  // Fallback: greedy text match with bullet normalization
  const used = new Set<TextRun>();
  const fresh: TextRun[] = [];
  for (let i = 0; i < segmentEdits.length; i++) {
    const want = normalizeEditText(segmentEdits[i].newText);
    let best: TextRun | null = null;
    let bestScore = -1;
    for (let p = 0; p < peers.length; p++) {
      const run = peers[p];
      if (used.has(run)) continue;
      const got = normalizeEditText(run.text);
      let score = 0;
      if (got === want) score = 100;
      else if (want.length > 0 && got.includes(want.slice(0, Math.min(10, want.length)))) score = 50;
      else if (want.length > 2 && got.slice(0, 6) === want.slice(0, 6)) score = 25;
      if (score > bestScore) {
        bestScore = score;
        best = run;
      }
    }
    if (!best || bestScore < 25) return null;
    used.add(best);
    fresh.push(best);
  }
  return fresh;
}

/**
 * After estimate-based shifts + text rewrite, re-measure real glyph widths and
 * nudge trailing runs so rivers/overlaps from width-estimate error disappear.
 */
function isKernedPerGlyphLine(line: TextLine): boolean {
  if (line.segments.length < 4) return false;
  let negGaps = 0;
  for (let i = 0; i < line.segments.length - 1; i++) {
    const a = getRunBounds(line.segments[i].run);
    const b = getRunBounds(line.segments[i + 1].run);
    if (b.left < a.right - 0.5) negGaps++;
  }
  return negGaps >= Math.ceil((line.segments.length - 1) * 0.5);
}

function correctResidualRunGaps(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  segmentEdits: { run: TextRun; newText: string }[],
  /**
   * Pre-edit line whose inter-run gaps define PDF spacing. Using the post-edit
   * line here reuses estimate-inflated rivers and then stacks font-growth push
   * on top.
   */
  gapSourceLine?: TextLine,
): { bytes: Uint8Array; corrections: RunPositionShift[] } {
  if (segmentEdits.length < 2) {
    return { bytes: contentBytes, corrections: [] };
  }

  // Type3 score-card lines: one glyph per run with heavy negative kerning.
  // After a Helvetica mid-line fallback, fresh-run matching + residual packing
  // yanks trailers to the wrong X. Skip for both in-engine and page.tsx callers.
  const gapProbe = gapSourceLine ?? line;
  if (isKernedPerGlyphLine(gapProbe) || isKernedPerGlyphLine(line)) {
    return { bytes: contentBytes, corrections: [] };
  }

  const interpreted = interpretPage(contentBytes, page, objects);
  const fresh = resolveFreshSegmentRuns(
    interpreted.textRuns,
    segmentEdits,
    line.baseline,
    line.fontSize,
  );
  if (!fresh) {
    return { bytes: contentBytes, corrections: [] };
  }

  const gapLine = gapSourceLine ?? line;
  const corrections: RunPositionShift[] = [];
  let cursor = getRunBounds(fresh[0]).left;
  const fs = Math.max(line.fontSize, 8);

  for (let i = 0; i < fresh.length; i++) {
    const bounds = getRunBounds(fresh[i]);
    const dx = cursor - bounds.left;
    if (Math.abs(dx) > 0.5) {
      corrections.push({ run: fresh[i], dx, dy: 0 });
    }

    let gap = fs * 0.12;
    if (i < gapLine.segments.length - 1) {
      const ob = getRunBounds(gapLine.segments[i].run);
      const nb = getRunBounds(gapLine.segments[i + 1].run);
      // Preserve negative gaps (kerning / overlapping Type3 per-glyph runs).
      gap = nb.left - ob.right;
    }
    const text = segmentEdits[i]?.newText ?? fresh[i].text;
    const estW = measureUnicodeExportText(text, fresh[i], page, objects) ?? estimateTextWidth(text, fresh[i]);
    const w = Math.max(bounds.width, estW);
    cursor += w + gap;
  }


  if (corrections.length === 0) {
    return { bytes: contentBytes, corrections };
  }
  return {
    bytes: applyRunPositionShifts(contentBytes, corrections),
    corrections,
  };
}

/**
 * Width growth of the edited line itself. Needed when title|tags have already
 * been split into separate flow cells — segment shifts are empty (segCount=1)
 * but peers on the same baseline still need to move.
 */
function estimateLineGrowthDx(
  line: TextLine,
  oldText: string,
  newText: string,
  fontSizeOverrides?: Array<{ start: number; end: number; fontSize: number }>,
): number {
  if (newText.length <= oldText.length) return 0;
  const run = line.segments[0]?.run ?? line.runs[0];
  if (!run) return 0;

  const oldW = Math.max(line.width, estimateTextWidth(oldText, run), 0.01);
  const estimated = fontSizeOverrides?.length
    ? estimateTextWidthWithOverrides(newText, run, 0, fontSizeOverrides)
    : estimateTextWidth(newText, run);
  const fs = visualFontSize(run);
  const deltaChars = newText.length - oldText.length;
  const deltaSpaces =
    (newText.match(/\s/g) || []).length - (oldText.match(/\s/g) || []).length;
  const deltaLetters = deltaChars - deltaSpaces;
  if (fontSizeOverrides?.length) {
    return Math.max(0, estimated - oldW);
  }
  if (deltaSpaces > 0) {
    const spaceFloor =
      oldW
      + Math.max(0, deltaLetters) * fs * 0.35
      + Math.max(0, deltaSpaces) * fs * 0.28;
    return Math.max(0, Math.max(estimated, spaceFloor) - oldW);
  }
  const scaled = oldW * (newText.length / Math.max(1, oldText.length));
  const deltaFloor = oldW + Math.max(0, deltaLetters) * fs * 0.4;
  const emCap = newText.length * fs * 0.52;
  const proportional = Math.max(estimated, scaled);
  const newW = Math.max(deltaFloor, Math.min(proportional, emCap));
  return Math.max(0, newW - oldW);
}

function buildLayoutPlan(
  flow: DocumentFlow | undefined,
  line: TextLine,
  newText: string,
): LayoutPlan {
  if (flow) {
    const paragraph = findParagraphForLine(flow, line);
    if (paragraph) {
      return computeLayoutPlan(paragraph, line, newText);
    }
  }

  return {
    lineEdits: [{ line, newText }],
    shifts: computeHorizontalShifts(line, newText),
    previewLines: [newText],
  };
}

/**
 * Nudge same-baseline peer runs that are not part of this line's segments.
 *
 * Covers: right-column date cells past the edited line, and orphan duplicate
 * draws (common in resume PDFs) that sit mid-line after the grown run — those
 * used to stay put when only segment trailers moved, overlapping the new gap.
 */
function collectPeerShiftsAfter(
  line: TextLine,
  flow: DocumentFlow | undefined,
  afterX: number,
  dx: number,
): RunPositionShift[] {
  if (!flow?.rawRuns?.length || dx < 0.5) return [];

  const owned = new Set<TextRun>(line.runs);
  const fs = Math.max(line.fontSize, 8);
  const shifts: RunPositionShift[] = [];

  for (let i = 0; i < flow.rawRuns.length; i++) {
    const run = flow.rawRuns[i];
    if (owned.has(run)) continue;
    if ((run.sourceInstructionIndices ?? []).length === 0) continue;

    const baseline = run.glyphs.length > 0 ? run.glyphs[0].tRm.f : run.y;
    if (Math.abs(baseline - line.baseline) > Math.max(2, fs * 0.35)) continue;
    if (run.x < afterX - 0.5) continue;

    shifts.push({ run, dx, dy: 0 });
  }

  // Only push the peers when the grown line would actually run into the nearest
  // one. Otherwise they belong to a different block that merely shares the
  // baseline (e.g. an address on the left and a "DATE : ..." header on the
  // right) and must stay where they are.
  if (shifts.length > 0) {
    const newRight = afterX + dx;
    const nearest = Math.min(...shifts.map(s => s.run.x));
    if (nearest > newRight + 2) return [];
  }

  return shifts;
}

export interface LineTextEditOptions {
  /** Original line text at edit-session start (for caret-aware redistribute). */
  oldText?: string;
  /** Caret index after the edit (matches overlay preview). */
  caretAfter?: number;
  /**
   * Skip measured residual gap correction. Needed when a larger fontSize will
   * be applied next — residual packs to the old-size widths and pulls peers
   * back into the space the size bump still needs.
   */
  skipResidualCorrection?: boolean;
  /**
   * Pending fontSize patches in new-text coordinates so insert width estimates
   * match the size that will be applied on the same commit.
   */
  fontSizeOverrides?: Array<{ start: number; end: number; fontSize: number }>;
}

/**
 * Apply a Word-style line edit with paragraph layout:
 * distributes text across styled runs, wraps overflow, and shifts positions.
 */
/**
 * Close rivers / overlaps using measured glyph bounds after text+style edits.
 * Safe to run once fonts/sizes are final (not before a pending fontSize bump).
 */
export function correctLineResidualGaps(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  options?: { gapSourceLine?: TextLine },
): { bytes: Uint8Array; corrections: RunPositionShift[] } {
  if (line.segments.length < 2) {
    return { bytes: contentBytes, corrections: [] };
  }
  return correctResidualRunGaps(
    contentBytes,
    page,
    objects,
    line,
    line.segments.map(s => ({ run: s.run, newText: s.text })),
    options?.gapSourceLine,
  );
}

export function applyLineTextEdit(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  newText: string,
  flow?: DocumentFlow,
  options?: LineTextEditOptions,
): EditResult {
  if (line.runs.some(run => run.actualText) && newText !== line.text) {
    throw new Error('Exported shaped text cannot be edited in place; add a new text box instead.');
  }
  const plan = buildLayoutPlan(flow, line, newText);
  const edits: TextEdit[] = [];
  const oldText = options?.oldText ?? line.text;
  const caretAfter = options?.caretAfter ?? newText.length;

  let primarySegmentEdits: ReturnType<typeof distributeTextChangeToSegments> | null = null;
  let primaryLine = line;

  for (let i = 0; i < plan.lineEdits.length; i++) {
    const { line: targetLine, newText: lineText } = plan.lineEdits[i];
    // Prefer caret-aware split (same as the live overlay) so commit matches preview.
    const segmentEdits = i === 0 && (options?.oldText != null || options?.caretAfter != null)
      ? distributeTextChangeToSegments(targetLine, oldText, lineText, caretAfter)
      : distributeTextToSegments(targetLine, lineText);
    if (i === 0) {
      primarySegmentEdits = segmentEdits;
      primaryLine = targetLine;
    }
    for (let j = 0; j < segmentEdits.length; j++) {
      edits.push({
        targetRun: segmentEdits[j].run,
        newText: segmentEdits[j].newText,
      });
    }
  }
  // Position shifts can reindex the live runs. Reject unsupported text before that mutation.
  for (const edit of edits) {
    if (edit.newText !== edit.targetRun.text) {
      assertTextEncodable(edit.newText, loadFontForName(edit.targetRun.fontName, page, objects), true, objects);
    }
  }


  // Shifts must use the same caret-aware split as the text rewrite.
  const editShifts = primarySegmentEdits
    ? computeHorizontalShiftsFromEdits(
      primaryLine,
      primarySegmentEdits,
      options?.fontSizeOverrides,
      (text, run, lineStart) => measureUnicodeExportText(text, run, page, objects, options?.fontSizeOverrides, lineStart),
    )
    : plan.shifts;

  let horizShifts = editShifts.filter(s => Math.abs(s.dy) < 0.01 && Math.abs(s.dx) > 0.01);
  const segmentGrowthDx = horizShifts.reduce((m, s) => Math.max(m, s.dx), 0);
  // Multi-segment: trust segment chain. Single-segment: estimate line growth for
  // right-column peers. Never inflate the whole line by a pending fontSize.
  const primaryRun = primaryLine.segments[0]?.run ?? primaryLine.runs[0];
  const exactLineWidth = primaryRun && measureUnicodeExportText(newText, primaryRun, page, objects, options?.fontSizeOverrides);
  const lineGrowthDx = primaryLine.segments.length <= 1
    ? exactLineWidth !== undefined
      ? Math.max(0, exactLineWidth - primaryLine.width)
      : estimateLineGrowthDx(primaryLine, oldText, newText, options?.fontSizeOverrides)
    : 0;
  const growthDx = Math.max(segmentGrowthDx, lineGrowthDx);
  const dSpaces = (newText.match(/\s/g) || []).length - (oldText.match(/\s/g) || []).length;

  // Peer origin: just after the last changed segment (or classic right-column fence).
  const fsPeer = Math.max(primaryLine.fontSize, 8);
  let peerAfterX = primaryLine.rightEdge - fsPeer * 0.25;
  let peerDx = growthDx;
  if (primarySegmentEdits) {
    for (let i = 0; i < primaryLine.segments.length; i++) {
      const seg = primaryLine.segments[i];
      const edit = primarySegmentEdits.find(e => e.run === seg.run) ?? primarySegmentEdits[i];
      if (edit && edit.newText !== seg.text) {
        peerAfterX = getRunBounds(seg.run).right;
      }
    }
    const trailer = horizShifts
      .filter(s => s.run.x >= peerAfterX - 1)
      .sort((a, b) => a.run.x - b.run.x)[0];
    if (trailer) peerDx = trailer.dx;
  }
  // Skip peers that share content-stream ops with segment trailers already shifted.
  const shiftedOps = new Set<number>();
  for (const s of horizShifts) {
    for (const idx of s.run.sourceInstructionIndices ?? []) shiftedOps.add(idx);
  }
  // Table cells are fixed columns: growth in one cell must not push its
  // neighbours (they would drift out of the grid). Title | tags | date style
  // rows are not tables and keep the push behaviour.
  const inTable = flow
    ? findCellForLine(detectTablesOnPage(flow.lines), primaryLine.id) !== null
    : false;
  // Trailing segments are only pushed when the grown text would run into them;
  // otherwise they are separate columns and must stay where they are.
  let keepColumns = false;
  {
    const trailing = horizShifts.filter(s => s.run.x >= peerAfterX - 1);
    if (trailing.length > 0) {
      const nearestX = Math.min(...trailing.map(s => s.run.x));
      const collides = nearestX < peerAfterX + peerDx + 2;
      if (!collides) {
        horizShifts = horizShifts.filter(s => s.run.x < peerAfterX - 1);
        keepColumns = true;
      }
    }
  }
  const peerShifts = (inTable ? [] : collectPeerShiftsAfter(primaryLine, flow, peerAfterX, peerDx))
    .filter(s => !(s.run.sourceInstructionIndices ?? []).some(idx => shiftedOps.has(idx)));
  if (peerShifts.length > 0) {
    horizShifts = [...horizShifts, ...peerShifts];
  }

  // Second pass: close rivers / overlaps left by width-estimate error (or a
  // first-pass shift that failed to land). Uses measured glyph bounds.
  // Skip when a pending fontSize enlarge will need that slack next.
  // Also skip when spaces were inserted: subset fonts often measure space
  // width ≈ 0, so residual packing pulls trailers back and live gaps vanish
  // on commit (spaces in Tj, but next run still at old X).
  const skipResidualForSpaces = dSpaces > 0;

  // Apply position shifts FIRST while sourceInstructionIndices still match the
  // stream. Font switches and incomplete-rewrite erase fallbacks can insert
  // operators, so shifting afterward can miss runs and overlap grown text.
  let bytes = contentBytes;
  if (horizShifts.length > 0) {
    bytes = applyRunPositionShifts(
      bytes,
      horizShifts,
      edits.map(e => e.targetRun),
    );
  }

  const editResult = applyTextEdits(bytes, page, objects, edits);
  bytes = editResult.newContentBytes;

  if (
    !options?.skipResidualCorrection
    && !keepColumns
    && !skipResidualForSpaces
    && primarySegmentEdits
    && primarySegmentEdits.length > 1
  ) {
    const corrected = correctResidualRunGaps(
      bytes,
      page,
      objects,
      primaryLine,
      primarySegmentEdits,
    );
    bytes = corrected.bytes;
  }

  return { ...editResult, newContentBytes: bytes };
}

export { buildLayoutPlan };
