/**
 * Style mutation API — safely patch color / size / underline on existing runs.
 *
 * Rules to avoid corrupting PDFs:
 * - Only modify operators already inside the run's BT…ET block
 * - Never invent font resource names that aren't on the page
 * - Never inject synthetic Tm shear (breaks baselines)
 * - Bold/italic only when a sibling Standard14 / resource font exists
 */

import {
  PDFName,
  PDFNumber,
  PDFDict,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFArray,
  type PDFDocumentData,
  type PDFObject,
  type PDFPageInfo,
} from '../types';
import type { TextRun } from '../content/interpreter';
import { getPageContentBytes, resolveRef } from '../parser/parser';
import {
  applyRunPositionShifts,
  buildTJWithSpaceAdvances,
  SPACE_TJ_MAX_CHARS,
  spaceSupplementalTJ,
  compileInstructions,
  encodeTextForFont,
  encodeTextWinAnsi,
  assertTextEncodable,
  loadFontForName,
  type EditResult,
  type EncodedText,
  type RunPositionShift,
} from '../editor/text-editor';
import { ensureFallbackFont, registerFontObject } from '../fonts/font-augmentation';
import { ctmBefore, deltaThroughInverse, invertMatrix } from '../editor/matrix';
import { updatePageContent } from '../editor/stream-compiler';
import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { interpretPage } from '../content/interpreter';
import { reconstructLines } from './line-reconstruction';
import type { TextLine, StyledSegment } from './types';
import {
  estimateTextWidth,
  getRunBounds,
  fontNameStyleFlags,
  resolveRunStyleFlags,
  visualFontSize,
} from './metrics';
import { charCodeToUnicode, type FontData } from '../fonts/font-parser';
import { getCharCodeLength, readCharCode } from '../fonts/cmap-parser';

export interface TextStylePatch {
  fontSize?: number;
  /** UI / CSS family name (Helvetica, Arial, Times New Roman, …) mapped to Standard 14. */
  fontFamily?: string;
  /** RGB in 0–1 */
  color?: [number, number, number];
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
}

/** Map a UI font family (+ style flags) onto a Standard 14 face name. */
function mapUIFamilyToStandard14(family: string, wantBold: boolean, wantItalic: boolean): string {
  const lower = family.toLowerCase();
  let base: 'Helvetica' | 'Times' | 'Courier' = 'Helvetica';
  if (
    lower.includes('times') || lower.includes('georgia') || lower.includes('garamond')
    || lower.includes('palatino') || lower.includes('cambria') || lower.includes('serif')
  ) {
    base = 'Times';
  } else if (
    lower.includes('courier') || lower.includes('mono') || lower.includes('consolas')
    || lower.includes('lucida console')
  ) {
    base = 'Courier';
  }

  if (base === 'Times') {
    if (wantBold && wantItalic) return 'Times-BoldItalic';
    if (wantBold) return 'Times-Bold';
    if (wantItalic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (base === 'Courier') {
    if (wantBold && wantItalic) return 'Courier-BoldOblique';
    if (wantBold) return 'Courier-Bold';
    if (wantItalic) return 'Courier-Oblique';
    return 'Courier';
  }
  if (wantBold && wantItalic) return 'Helvetica-BoldOblique';
  if (wantBold) return 'Helvetica-Bold';
  if (wantItalic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

export interface StyleEditResult extends EditResult {
  usedSyntheticItalic?: boolean;
  addedUnderline?: boolean;
  removedUnderline?: boolean;
}

function op(operator: string, operands: PDFObject[] = []): CSInstruction {
  return { operator, operands, offset: 0 };
}

/** Map a line-level [start,end) selection onto per-segment ranges. */
export function mapSelectionToSegments(
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
): Array<{ segment: StyledSegment; localStart: number; localEnd: number }> {
  const start = Math.max(0, Math.min(selectionStart, line.text.length));
  const end = Math.max(start, Math.min(selectionEnd, line.text.length));
  const hits: Array<{ segment: StyledSegment; localStart: number; localEnd: number }> = [];

  for (const seg of line.segments) {
    const overlapStart = Math.max(start, seg.startIndex);
    const overlapEnd = Math.min(end, seg.endIndex);
    if (overlapStart < overlapEnd) {
      hits.push({
        segment: seg,
        localStart: overlapStart - seg.startIndex,
        localEnd: overlapEnd - seg.startIndex,
      });
    }
  }
  return hits;
}

/**
 * When fontSize grows on a mid-line span, sibling runs keep absolute Tm and
 * pile onto the enlarged glyphs. Shift trailing peers by selectedW×(ratio−1).
 *
 * Peer selection is by CHARACTER INDEX (segments starting at/after selectionEnd),
 * not by x — after caret-aware redistribute the grown span is often one mega-run,
 * so every later word shares that run and an x-fence finds nobody to shift.
 */
function collectFontSizeTrailingShifts(
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  newFontSize: number,
): {
  shifts: RunPositionShift[];
  growthDx: number;
  fenceX: number;
  ownedCount: number;
  trailingSegs: number;
} {
  const hits = mapSelectionToSegments(line, selectionStart, selectionEnd);
  if (hits.length === 0) {
    return { shifts: [], growthDx: 0, fenceX: 0, ownedCount: 0, trailingSegs: 0 };
  }

  let growthDx = 0;
  let fenceX = Infinity;
  const owned = new Set<TextRun>();

  for (const h of hits) {
    const run = h.segment.run;
    owned.add(run);
    const oldFs = visualFontSize(run);
    if (oldFs < 0.5) continue;
    const ratio = newFontSize / oldFs;
    if (Math.abs(ratio - 1) < 0.02) continue;

    const localText = run.text.slice(h.localStart, h.localEnd);
    const wGlyph = widthUpToChar(run, h.localEnd) - widthUpToChar(run, h.localStart);
    const wEst = estimateTextWidth(localText, run);
    const selectedW = Math.max(wGlyph, wEst, localText.length * oldFs * 0.45);
    growthDx += selectedW * (ratio - 1);

    const startX = run.x + widthUpToChar(run, h.localStart);
    if (startX < fenceX) fenceX = startX;
  }

  if (fenceX === Infinity || Math.abs(growthDx) < 0.35) {
    return { shifts: [], growthDx: 0, fenceX: 0, ownedCount: owned.size, trailingSegs: 0 };
  }

  const maxGrowth = Math.max(8, (selectionEnd - selectionStart) * newFontSize * 0.7);
  if (growthDx > maxGrowth) growthDx = maxGrowth;

  // Whitespace-only enlargements must not shove the rest of the line.
  const selectedSlice = line.text.slice(selectionStart, selectionEnd);
  if (/^\s*$/.test(selectedSlice)) {
    return { shifts: [], growthDx: 0, fenceX: fenceX, ownedCount: owned.size, trailingSegs: 0 };
  }

  const shifts: RunPositionShift[] = [];
  const seen = new Set<TextRun>();
  let trailingSegs = 0;
  for (const seg of line.segments) {
    if (seg.startIndex < selectionEnd) continue;
    trailingSegs++;
    const run = seg.run;
    if (owned.has(run) || seen.has(run)) continue;
    if ((run.sourceInstructionIndices ?? []).length === 0) continue;
    seen.add(run);
    shifts.push({ run, dx: growthDx, dy: 0 });
  }

  // Fallback: x-fence when redistribute absorbed later words into the owned run
  // (no segment starts at/after selectionEnd).
  if (shifts.length === 0) {
    for (const run of line.runs) {
      if (owned.has(run) || seen.has(run)) continue;
      if ((run.sourceInstructionIndices ?? []).length === 0) continue;
      if (getRunBounds(run).left >= fenceX - 0.5) {
        seen.add(run);
        shifts.push({ run, dx: growthDx, dy: 0 });
      }
    }
  }

  return { shifts, growthDx, fenceX, ownedCount: owned.size, trailingSegs };
}

/**
 * One trailing-shift pass for many mid-line fontSize patches (e.g. typed
 * letters separated by spaces). Sequential per-patch shifts stack on the same
 * peers and invent rivers; skipping all shifts lets oversized glyphs overlap.
 *
 * For each segment after a patch, dx = sum of growth from patches that end
 * at/before that segment — same math as sequential applies, one write.
 */
export function collectBatchedFontSizeTrailingShifts(
  line: TextLine,
  ranges: Array<{ start: number; end: number; fontSize: number }>,
): {
  shifts: RunPositionShift[];
  totalGrowthDx: number;
  rangeCount: number;
} {
  const parts: Array<{
    start: number;
    end: number;
    growthDx: number;
    fenceX: number;
    owned: Set<TextRun>;
  }> = [];

  for (const r of ranges) {
    if (r.end <= r.start || r.fontSize == null) continue;
    if (/^\s*$/.test(line.text.slice(r.start, r.end))) continue;
    const one = collectFontSizeTrailingShifts(line, r.start, r.end, r.fontSize);
    if (one.growthDx < 0.35) continue;
    const owned = new Set<TextRun>();
    for (const h of mapSelectionToSegments(line, r.start, r.end)) {
      owned.add(h.segment.run);
    }
    parts.push({
      start: r.start,
      end: r.end,
      growthDx: one.growthDx,
      fenceX: one.fenceX,
      owned,
    });
  }
  if (parts.length === 0) {
    return { shifts: [], totalGrowthDx: 0, rangeCount: 0 };
  }

  const allOwned = new Set<TextRun>();
  for (const p of parts) {
    for (const r of p.owned) allOwned.add(r);
  }

  const dxByRun = new Map<TextRun, number>();
  const seen = new Set<TextRun>();
  for (const seg of line.segments) {
    const run = seg.run;
    if (seen.has(run) || allOwned.has(run)) continue;
    if ((run.sourceInstructionIndices ?? []).length === 0) continue;
    let dx = 0;
    for (const p of parts) {
      if (seg.startIndex >= p.end) dx += p.growthDx;
    }
    if (dx < 0.35) continue;
    seen.add(run);
    dxByRun.set(run, dx);
  }

  if (dxByRun.size === 0) {
    const total = parts.reduce((s, p) => s + p.growthDx, 0);
    let fenceX = Infinity;
    for (const p of parts) {
      if (p.fenceX < fenceX) fenceX = p.fenceX;
    }
    if (Number.isFinite(fenceX) && total >= 0.35) {
      for (const run of line.runs) {
        if (allOwned.has(run)) continue;
        if ((run.sourceInstructionIndices ?? []).length === 0) continue;
        if (getRunBounds(run).left >= fenceX - 0.5) {
          dxByRun.set(run, total);
        }
      }
    }
  }

  const shifts: RunPositionShift[] = [];
  let totalGrowthDx = 0;
  for (const [run, dx] of dxByRun) {
    shifts.push({ run, dx, dy: 0 });
    totalGrowthDx = Math.max(totalGrowthDx, dx);
  }
  return { shifts, totalGrowthDx, rangeCount: parts.length };
}

/**
 * After Tf grows mid-line glyphs, push every same-line run that still starts
 * under the enlarged span by ONE uniform dx (no cascading re-pack).
 *
 * Only runs that overlap the just-styled selection count as "enlarged".
 * Matching every same-size run on the line (e.g. an earlier 16pt insert)
 * makes interstitial content (spaces between two large words) look like an
 * overlap of a mega-span and shoves the rest of the line by hundreds of units.
 */
function fixLineLocalOverlapsAfterFontSize(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  newFontSize: number,
): { bytes: Uint8Array; fixes: number; totalDx: number; pairs: Array<{ left: string; right: string; dx: number }> } {
  const interpreted = interpretPage(contentBytes, page, objects);
  const freshLines = reconstructLines(interpreted.textRuns);
  const normalize = (t: string) => t.replace(/[\u2013\u2014\u2212]/g, '-');
  const want = normalize(line.text);
  const midSlice = line.text.slice(selectionStart, selectionEnd);
  const baseTol = Math.max(2, line.fontSize * 0.35);
  const sameBaseline = freshLines.filter(
    l => Math.abs(l.baseline - line.baseline) <= baseTol,
  );

  // Intact line, else mid-bearing fragment, else all same-baseline lines.
  // After a mid-line Tf split, column detection often tears the enlarged mid
  // onto a sibling cell — peers must still include the after-fragment.
  const fresh =
    sameBaseline.find(l => l.text === line.text)
    ?? sameBaseline.find(l => normalize(l.text) === want)
    ?? (midSlice.trim()
      ? sameBaseline.find(l => l.text.includes(midSlice.trim()))
      : undefined)
    ?? null;

  const peerSource = fresh ? [fresh] : sameBaseline;
  if (peerSource.length === 0) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  // Don't repack the line when only spaces were enlarged.
  if (/^\s*$/.test(midSlice)) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  const peers = peerSource
    .flatMap(l => l.runs)
    .filter(r => (r.sourceInstructionIndices ?? []).length > 0)
    .sort((a, b) => getRunBounds(a).left - getRunBounds(b).left);

  if (peers.length < 2) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  // Selection-local enlarged runs only (not every same-size run on the line).
  const enlarged: TextRun[] = [];
  const seen = new Set<TextRun>();
  const segLists = fresh ? [fresh.segments] : peerSource.map(l => l.segments);
  for (const segments of segLists) {
    for (const seg of segments) {
      if (fresh) {
        if (seg.endIndex <= selectionStart || seg.startIndex >= selectionEnd) continue;
      } else if (midSlice.trim() && !seg.text.includes(midSlice.trim())
        && !midSlice.includes(seg.text.trim())) {
        // Union path: prefer runs that carry the enlarged slice.
        if (Math.abs(visualFontSize(seg.run) - newFontSize) >= 1.0) continue;
      }
      const run = seg.run;
      if (seen.has(run)) continue;
      if ((run.sourceInstructionIndices ?? []).length === 0) continue;
      if (Math.abs(visualFontSize(run) - newFontSize) < 1.0) {
        seen.add(run);
        enlarged.push(run);
      }
    }
  }
  if (enlarged.length === 0) {
    // Fallback: original line hits → match fresh runs by text + x proximity
    const hits = mapSelectionToSegments(line, selectionStart, selectionEnd);
    for (const h of hits) {
      const hb = getRunBounds(h.segment.run);
      const match = peers.find(r => {
        if (seen.has(r)) return false;
        if (Math.abs(visualFontSize(r) - newFontSize) >= 1.0) return false;
        const b = getRunBounds(r);
        return Math.abs(b.left - hb.left) < Math.max(8, newFontSize)
          || r.text.includes(h.segment.run.text.slice(h.localStart, h.localEnd));
      });
      if (match) {
        seen.add(match);
        enlarged.push(match);
      }
    }
  }
  if (enlarged.length === 0) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  let grownRight = -Infinity;
  let enlargedLeft = Infinity;
  let enlargedMaxIdx = -1;
  for (const r of enlarged) {
    const b = getRunBounds(r);
    if (b.right > grownRight) grownRight = b.right;
    if (b.left < enlargedLeft) enlargedLeft = b.left;
    for (const idx of r.sourceInstructionIndices ?? []) {
      if (idx > enlargedMaxIdx) enlargedMaxIdx = idx;
    }
  }
  // Mid glyphs sometimes report ~0 advance after a size-only byte-split; floor
  // grownRight so the after-fragment can still clear the typed span.
  const midFloor =
    enlargedLeft
    + Math.max(1, midSlice.replace(/\s/g, '').length) * newFontSize * 0.42;
  if (grownRight < midFloor) grownRight = midFloor;

  if (!Number.isFinite(grownRight)) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  const minGap = Math.max(
    fresh?.fontSize ?? line.fontSize,
    line.fontSize,
    8,
  ) * 0.1;
  const enlargedSet = new Set(enlarged);
  // Per-peer cascade from a running fence. Stream-after fragments (same BT,
  // consecutive Tj after the enlarged mid) must NOT be position-shifted —
  // applyRunPositionShifts often falls back to absolute Tm at run.x (the
  // before-origin), teleporting "structure" from ~242 back to ~105.
  const selLen = Math.max(1, selectionEnd - selectionStart);
  const softMaxDx = Math.min(selLen * newFontSize * 0.45, newFontSize * 4);
  const shifts: RunPositionShift[] = [];
  const pairs: Array<{ left: string; right: string; dx: number }> = [];
  let fenceRight = grownRight;
  let seenEnlarged = false;
  let totalDx = 0;
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    if (enlargedSet.has(peer)) {
      seenEnlarged = true;
      fenceRight = Math.max(fenceRight, getRunBounds(peer).right, grownRight);
      continue;
    }
    if (!seenEnlarged) continue;
    const b = getRunBounds(peer);
    const idxs = peer.sourceInstructionIndices ?? [];
    const peerMinIdx = idxs.length > 0 ? Math.min(...idxs) : -1;
    const underSpan = b.left >= enlargedLeft - 0.5 && b.left < grownRight - 0.5;
    const overlapsPrev = b.left < fenceRight - 0.5;
    // After-fragment of a Tf split: sits at/just past mid via Tj advance.
    // Far trailers also have higher instruction indices — only skip the near one.
    const afterFragment =
      peerMinIdx > enlargedMaxIdx
      && b.left <= grownRight + Math.max(minGap, newFontSize * 0.25);
    if (afterFragment) {
      fenceRight = Math.max(fenceRight, b.right, grownRight);
      continue;
    }
    if (!underSpan && !overlapsPrev) {
      fenceRight = Math.max(fenceRight, b.right);
      continue;
    }
    let peerDx = Math.max(
      grownRight + minGap - b.left,
      fenceRight + minGap - b.left,
    );
    if (underSpan && !overlapsPrev && peerDx > softMaxDx) {
      peerDx = softMaxDx;
    }
    if (peerDx > 0.5) {
      shifts.push({ run: peer, dx: peerDx, dy: 0 });
      totalDx += peerDx;
      pairs.push({
        left: `fence@${Math.round(fenceRight * 10) / 10}`,
        right: peer.text.slice(0, 12),
        dx: Math.round(peerDx * 100) / 100,
      });
      fenceRight = b.right + peerDx;
    } else {
      fenceRight = Math.max(fenceRight, b.right);
    }
  }
  if (shifts.length === 0) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  return {
    bytes: applyRunPositionShifts(contentBytes, shifts, peers),
    fixes: shifts.length,
    totalDx,
    pairs,
  };
}

/** Strip weight/style tokens so we can rebuild a Regular/Bold/Italic face name. */
function stripStyleTokens(name: string): string {
  return name
    .replace(/^.*\+/, '')
    .replace(/,.*$/, '')
    .replace(/[-_]?(BoldOblique|BoldItalic|Bold|Black|Heavy|SemiBold|DemiBold|Italic|Oblique|Regular|Medium|Light)/gi, '')
    .replace(/[-_]+$/g, '') || name.replace(/^.*\+/, '');
}

/** Guess a bold/italic sibling Standard14 (or family) font name. */
export function resolveStyledFontName(
  baseName: string,
  bold?: boolean,
  italic?: boolean,
): string {
  const bare = baseName.replace(/^.*\+/, '').replace(/,.*$/, '');
  const family = stripStyleTokens(bare);
  const wantBold = !!bold;
  const wantItalic = !!italic;

  if (/helvetica/i.test(family) || /^arial$/i.test(family)) {
    if (wantBold && wantItalic) return 'Helvetica-BoldOblique';
    if (wantBold) return 'Helvetica-Bold';
    if (wantItalic) return 'Helvetica-Oblique';
    return 'Helvetica';
  }
  if (/times/i.test(family) || /roman/i.test(family)) {
    if (wantBold && wantItalic) return 'Times-BoldItalic';
    if (wantBold) return 'Times-Bold';
    if (wantItalic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (/courier/i.test(family)) {
    if (wantBold && wantItalic) return 'Courier-BoldOblique';
    if (wantBold) return 'Courier-Bold';
    if (wantItalic) return 'Courier-Oblique';
    return 'Courier';
  }

  // Generic PostScript-style face name
  if (wantBold && wantItalic) return `${family}-BoldItalic`;
  if (wantBold) return `${family}-Bold`;
  if (wantItalic) return `${family}-Italic`;
  return family || bare;
}

function listPageFonts(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): Array<{ key: string; baseFont: string }> {
  const out: Array<{ key: string; baseFont: string }> = [];
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) return out;
  let fontDict = resources.get('Font');
  if (fontDict instanceof PDFRef) fontDict = resolveRef(fontDict, objects);
  if (!(fontDict instanceof PDFDict)) return out;
  for (const [k, v] of fontDict.entries()) {
    let dict = v;
    if (dict instanceof PDFRef) dict = resolveRef(dict, objects);
    const baseFont =
      dict instanceof PDFDict ? (dict.getName('BaseFont') ?? k) : k;
    out.push({ key: k, baseFont });
  }
  return out;
}

/**
 * Prefer an existing page font whose BaseFont matches the desired weight/style
 * and the same family as the current run.
 */
function findSiblingFontKey(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  currentFontName: string,
  wantBold: boolean,
  wantItalic: boolean,
): string | null {
  const fonts = listPageFonts(page, objects);
  const current = fonts.find(f => f.key === currentFontName.replace(/^\//, ''))
    ?? fonts.find(f => f.baseFont === currentFontName);
  const family = stripStyleTokens(current?.baseFont || currentFontName).toLowerCase();

  let best: string | null = null;
  let bestScore = -1;
  for (const f of fonts) {
    // Subset fonts (ABCDEF+Name) only carry glyphs used by their own text —
    // typing/restyling other text with them drops characters.
    if (/^[A-Z]{6}\+/.test(f.baseFont)) continue;
    const flags = fontNameStyleFlags(f.baseFont);
    if (flags.bold !== wantBold || flags.italic !== wantItalic) continue;
    const fFamily = stripStyleTokens(f.baseFont).toLowerCase();
    let score = 0;
    if (fFamily === family) score += 10;
    else if (fFamily.includes(family) || family.includes(fFamily)) score += 5;
    else continue;
    if (score > bestScore) {
      bestScore = score;
      best = f.key;
    }
  }
  return best;
}

function ensureStandard14Font(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  baseFont: string,
): string | null {
  const resourceKey = baseFont.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'FStyled';
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  let fontDict = resources.get('Font');
  if (fontDict instanceof PDFRef) fontDict = resolveRef(fontDict, objects);
  if (!(fontDict instanceof PDFDict)) {
    fontDict = new PDFDict();
    resources.set('Font', fontDict);
  }
  if (fontDict.has(resourceKey)) return resourceKey;

  const allowed = /^(Helvetica|Times-Roman|Times|Courier)/i.test(baseFont);
  if (!allowed) return null;

  const dict = new PDFDict();
  dict.set('Type', new PDFName('Font'));
  dict.set('Subtype', new PDFName('Type1'));
  dict.set('BaseFont', new PDFName(baseFont));
  fontDict.set(resourceKey, registerFontObject(objects, dict));
  return resourceKey;
}

export interface StyleApplyOptions {
  /**
   * When text was just rewritten in the same commit, peers were already shifted
   * for the new glyph widths. Extra fontSize trailing shifts then stack per
   * letter-patch (especially with spaces between them) and invent rivers.
   * Mid-run Tf growth still advances the same-BT tail via Tj; overlap fix
   * catches true collisions.
   */
  skipTrailingFontSizeShifts?: boolean;
}

/**
 * Apply style to a character range on a line — safe in-BT patches only.
 */
/** x translation (operand e) of the nearest Tm at/before `idx` inside its BT block. */
function tmXBeforeIndex(contentBytes: Uint8Array, idx: number): number | null {
  const instructions = parseContentStream(contentBytes);
  const range = findBtEtRange(instructions, idx);
  if (!range) return null;
  for (let i = idx; i >= range.bt; i--) {
    if (instructions[i].operator === 'Tm' && instructions[i].operands.length >= 6) {
      const n = instructions[i].operands[4];
      return n instanceof PDFNumber ? n.value : null;
    }
  }
  return null;
}

function setTmXBeforeIndex(contentBytes: Uint8Array, idx: number, x: number): Uint8Array {
  const instructions = parseContentStream(contentBytes);
  const range = findBtEtRange(instructions, idx);
  if (!range) return contentBytes;
  for (let i = idx; i >= range.bt; i--) {
    if (instructions[i].operator === 'Tm' && instructions[i].operands.length >= 6) {
      instructions[i].operands[4] = new PDFNumber(x);
      return compileInstructions(instructions);
    }
  }
  return contentBytes;
}

/** Group a run's source instruction indices by the BT..ET block they belong to. */
function groupIndicesByTextBlock(contentBytes: Uint8Array, run: TextRun): number[][] {
  const indices = run.sourceInstructionIndices ?? [];
  if (indices.length < 2) return [];
  const instructions = parseContentStream(contentBytes);
  const groups = new Map<number, number[]>();
  for (const idx of indices) {
    const r = findBtEtRange(instructions, idx);
    const key = r ? r.bt : -1;
    const arr = groups.get(key);
    if (arr) arr.push(idx); else groups.set(key, [idx]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

export function applyStyleToSelection(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  style: TextStylePatch,
  options?: StyleApplyOptions,
): StyleEditResult {
  const start = Math.max(0, Math.min(selectionStart, line.text.length));
  const end = Math.max(start, Math.min(selectionEnd, line.text.length));
  // Collapsed ranges are a no-op here — callers must expand to a segment/line first.
  const hits = end > start ? mapSelectionToSegments(line, start, end) : [];
  if (hits.some(hit => hit.segment.run.actualText)) {
    throw new Error('Per-glyph styles cannot be changed on exported shaped text; add a new text box instead.');
  }
  if (hits.length === 0) {
    return {
      newContentBytes: contentBytes,
      needsFontAugmentation: false,
      missingCharCodes: [],
      usedSyntheticItalic: false,
      addedUnderline: false,
      removedUnderline: false,
    };
  }

  // Merge overlapping local ranges per run so partial bold/italic can split once.
  const byRun = new Map<TextRun, { localStart: number; localEnd: number }>();
  for (const h of hits) {
    const prev = byRun.get(h.segment.run);
    if (!prev) {
      byRun.set(h.segment.run, { localStart: h.localStart, localEnd: h.localEnd });
    } else {
      prev.localStart = Math.min(prev.localStart, h.localStart);
      prev.localEnd = Math.max(prev.localEnd, h.localEnd);
    }
  }
  // Reject lossy face changes and split fallbacks before shifting runs or adding resources.
  for (const [run, range] of byRun) {
    const changesFace = !!style.fontFamily || style.bold != null || style.italic != null;
    if (!changesFace && style.fontSize == null) continue;
    const fontData = loadFontForName(run.fontName, page, objects);
    if (changesFace && fontData?.isComposite) {
      assertTextEncodable(run.text, null, false);
    } else if ((changesFace || style.fontSize != null) &&
        (range.localStart > 0 || range.localEnd < run.text.length)) {
      assertTextEncodable(run.text, fontData, false);
    }
  }

  let bytes = contentBytes;
  let addedUnderline = false;
  let removedUnderline = false;

  // Push trailing absolute-Tm peers BEFORE patching Tf — indices must stay valid.
  // growthDx = selectedW × (newFs/oldFs − 1) stacks with text-edit insert shifts.
  if (
    style.fontSize != null
    && end > start
    && !options?.skipTrailingFontSizeShifts
  ) {
    const { shifts } = collectFontSizeTrailingShifts(
      line, start, end, style.fontSize,
    );
    if (shifts.length > 0) {
      bytes = applyRunPositionShifts(bytes, shifts, line.runs);
    }
  }

  for (const [run, range] of byRun) {
    // A merged run can come from several BT..ET blocks (e.g. a title whose first
    // word has a different colour). Whole-run styles must patch every block, not
    // just the first one, so apply them group by group (last block first so the
    // earlier instruction indices stay valid when `rg` gets inserted).
    const whole = range.localStart <= 0 && range.localEnd >= run.text.length;
    const groups = whole ? groupIndicesByTextBlock(bytes, run) : [];
    if (groups.length > 1) {
      // Original x of each block's Tm, so blocks keep their spacing when the size changes.
      const origX = groups.map((g) => tmXBeforeIndex(bytes, g[0]));
      const ratio = style.fontSize != null ? style.fontSize / Math.max(0.01, visualFontSize(run)) : 1;
      for (let gi = groups.length - 1; gi >= 0; gi--) {
        if (gi > 0 && Math.abs(ratio - 1) > 1e-6 && origX[0] != null && origX[gi] != null) {
          bytes = setTmXBeforeIndex(bytes, groups[gi][0], origX[0]! + (origX[gi]! - origX[0]!) * ratio);
        }
        const sub: TextRun = { ...run, sourceInstructionIndices: groups[gi] };
        const patched = patchRunStyle(bytes, sub, style, page, objects, 0, run.text.length);
        bytes = patched.bytes;
        addedUnderline = addedUnderline || patched.addedUnderline;
        removedUnderline = removedUnderline || patched.removedUnderline;
      }
      continue;
    }
    const patched = patchRunStyle(
      bytes, run, style, page, objects, range.localStart, range.localEnd,
    );
    bytes = patched.bytes;
    addedUnderline = addedUnderline || patched.addedUnderline;
    removedUnderline = removedUnderline || patched.removedUnderline;
  }

  // After Tf grows mid glyphs, push any same-line runs that still overlap
  // (e.g. the "after" fragment of a style split that didn't advance enough).
  if (style.fontSize != null && end > start) {
    const fixed = fixLineLocalOverlapsAfterFontSize(
      bytes, page, objects, line, start, end, style.fontSize,
    );
    bytes = fixed.bytes;
  }

  if (style.align && line.runs.length > 0) {
    bytes = applyAlignmentShift(bytes, line, style.align);
  }

  return {
    newContentBytes: bytes,
    needsFontAugmentation: false,
    missingCharCodes: [],
    usedSyntheticItalic: false,
    addedUnderline,
    removedUnderline,
  };
}

export function applyStyleToLine(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  style: TextStylePatch,
): StyleEditResult {
  return applyStyleToSelection(contentBytes, page, objects, line, 0, line.text.length, style);
}

export async function applyStyleToSelectionOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  style: TextStylePatch,
  options?: StyleApplyOptions,
): Promise<StyleEditResult> {
  const page = doc.pages[pageIndex];
  const contentBytes = getPageContentBytes(page, doc.objects);
  const result = applyStyleToSelection(
    contentBytes, page, doc.objects, line, selectionStart, selectionEnd, style, options,
  );
  await updatePageContent(page.contentRefs, result.newContentBytes, doc.objects);
  return result;
}

function findBtEtRange(
  instructions: CSInstruction[],
  textIndex: number,
): { bt: number; et: number } | null {
  let bt = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'ET') return null;
    if (instructions[i].operator === 'BT') { bt = i; break; }
  }
  if (bt < 0) return null;
  let et = -1;
  for (let i = textIndex; i < instructions.length; i++) {
    if (instructions[i].operator === 'ET') { et = i; break; }
  }
  if (et < 0) return null;
  return { bt, et };
}

/** Prefer a real Tj/TJ/'/" index — min(indices) is often a preceding Tf after font switches. */
function resolveTextShowingIndex(
  instructions: CSInstruction[],
  indices: number[],
): number {
  const sorted = [...indices].sort((a, b) => a - b);
  for (const i of sorted) {
    const op = instructions[i]?.operator;
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') return i;
  }
  const start = sorted.length > 0 ? sorted[0] : 0;
  for (let i = start; i < instructions.length; i++) {
    const op = instructions[i]?.operator;
    if (op === 'ET') break;
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') return i;
  }
  return sorted[0] ?? 0;
}

/** Byte offsets at UTF-16 text boundaries; -1 marks a boundary inside one code. */
function encodedUnicodeCuts(bytes: Uint8Array, fontData: FontData | null): number[] {
  const cuts = [0];
  let offset = 0;
  while (offset < bytes.length) {
    const length = fontData?.isComposite ? getCharCodeLength(bytes, offset, fontData.codeSpaceRanges) : 1;
    const code = readCharCode(bytes, offset, length);
    const unicodeLength = fontData ? charCodeToUnicode(code, fontData, length).length || 1 : 1;
    offset += length;
    for (let i = 1; i < unicodeLength; i++) cuts.push(-1);
    cuts.push(offset);
  }
  return cuts;
}

/**
 * Wrap already-encoded Tj/TJ string bytes in a TJ array, inserting space
 * advances without re-encoding letter CIDs.
 */
function tjFromEncodedWithSpaceAdvances(
  text: string,
  encoded: PDFObject,
  fontData: FontData | null,
): PDFArray {
  let bytes: Uint8Array;
  let asHex = false;
  if (encoded instanceof PDFHexString) {
    bytes = encoded.toBytes();
    asHex = true;
  } else if (encoded instanceof PDFString) {
    bytes = encoded.toBytes();
  } else if (encoded instanceof PDFArray) {
    // Already a TJ — prefer rebuild from text via standard path
    return buildTJWithSpaceAdvances(text, fontData, false);
  } else {
    return buildTJWithSpaceAdvances(text, fontData, false);
  }

  const cuts = encodedUnicodeCuts(bytes, fontData);
  if (cuts.length !== text.length + 1) {
    return buildTJWithSpaceAdvances(text, fontData, false);
  }

  const toPdfString = (from: number, to: number): PDFObject => {
    const part = bytes.slice(from, to);
    if (asHex) {
      let hex = '';
      for (let i = 0; i < part.length; i++) hex += part[i].toString(16).padStart(2, '0');
      return new PDFHexString(hex);
    }
    let s = '';
    for (let i = 0; i < part.length; i++) s += String.fromCharCode(part[i]);
    return new PDFString(s);
  };

  const items: PDFObject[] = [];
  let i = 0;
  const supplemental = spaceSupplementalTJ(fontData, false);
  while (i < text.length) {
    if (text[i] === ' ') {
      let j = i;
      while (j < text.length && text[j] === ' ') j++;
      const n = j - i;
      if (cuts[i] < 0 || cuts[j] < 0) return buildTJWithSpaceAdvances(text, fontData, false);
      items.push(toPdfString(cuts[i], cuts[j]));
      if (supplemental > 0) {
        const advChars = Math.min(n, SPACE_TJ_MAX_CHARS);
        items.push(new PDFNumber(-Math.round(advChars * supplemental)));
      }
      i = j;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] !== ' ') j++;
    if (cuts[i] < 0 || cuts[j] < 0) return buildTJWithSpaceAdvances(text, fontData, false);
    items.push(toPdfString(cuts[i], cuts[j]));
    i = j;
  }
  if (items.length === 0) {
    return buildTJWithSpaceAdvances(text, fontData, false);
  }
  return new PDFArray(items);
}

/**
 * Split an existing Tj/TJ PDF string into before/mid/after by Unicode char index
 * without re-encoding — avoids subset round-trips that turn letters into spaces.
 */
function splitEncodedByUnicodeIndex(
  operand: PDFObject,
  fontData: FontData | null,
  midStart: number,
  midEnd: number,
  totalChars: number,
): { before: PDFObject; mid: PDFObject; after: PDFObject } | null {
  let bytes: Uint8Array;
  let asHex = false;
  if (operand instanceof PDFHexString) {
    bytes = operand.toBytes();
    asHex = true;
  } else if (operand instanceof PDFString) {
    bytes = operand.toBytes();
  } else if (operand instanceof PDFArray) {
    // Flatten TJ string parts only (drop kerning numbers) into one byte stream
    const parts: number[] = [];
    for (let i = 0; i < operand.length; i++) {
      const item = operand.get(i)!;
      if (item instanceof PDFString || item instanceof PDFHexString) {
        const b = item.toBytes();
        for (let j = 0; j < b.length; j++) parts.push(b[j]);
        if (item instanceof PDFHexString) asHex = true;
      }
    }
    if (parts.length === 0) return null;
    bytes = new Uint8Array(parts);
  } else {
    return null;
  }

  const cuts = encodedUnicodeCuts(bytes, fontData);
  if (cuts.length - 1 < totalChars || midEnd >= cuts.length) return null;
  if (midStart < 0 || midStart > midEnd) return null;
  if (cuts[midStart] < 0 || cuts[midEnd] < 0 || cuts[totalChars] < 0) return null;

  const b0 = cuts[midStart] ?? 0;
  const b1 = cuts[midEnd] ?? bytes.length;
  const b2 = cuts[totalChars] ?? bytes.length;
  const slice = (from: number, to: number) => {
    const part = bytes.slice(from, to);
    if (asHex) {
      let hex = '';
      for (let i = 0; i < part.length; i++) hex += part[i].toString(16).padStart(2, '0');
      return new PDFHexString(hex);
    }
    let s = '';
    for (let i = 0; i < part.length; i++) s += String.fromCharCode(part[i]);
    return new PDFString(s);
  };
  return {
    before: slice(0, b0),
    mid: slice(b0, b1),
    after: slice(b1, b2),
  };
}

function patchRunStyle(
  contentBytes: Uint8Array,
  run: TextRun,
  style: TextStylePatch,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  localStart = 0,
  localEnd = run.text.length,
): { bytes: Uint8Array; addedUnderline: boolean; removedUnderline: boolean } {
  const instructions = parseContentStream(contentBytes);
  const indices = run.sourceInstructionIndices ?? [];
  if (indices.length === 0) {
    return { bytes: contentBytes, addedUnderline: false, removedUnderline: false };
  }

  const textIndex = resolveTextShowingIndex(instructions, indices);
  const range = findBtEtRange(instructions, textIndex);
  if (!range) return { bytes: contentBytes, addedUnderline: false, removedUnderline: false };
  // Earlier steps splice instructions (Tf scoping, stroke removal), so keep a handle on the
  // text op itself and re-find it instead of trusting the original index.
  const textAnchor = instructions[textIndex];

  let addedUnderline = false;
  let removedUnderline = false;

  const clampStart = Math.max(0, Math.min(localStart, run.text.length));
  const clampEnd = Math.max(clampStart, Math.min(localEnd, run.text.length));
  const isPartial = clampStart > 0 || clampEnd < run.text.length;

  // Color (whole-run; partial color uses the split path) is applied last, scoped to
  // this run's show ops. Cairo/Firefox put many lines in ONE BT, so an `rg` at the BT
  // start would recolor every later line. Anchors survive the splices made below.
  const colorAnchors: CSInstruction[] = [];
  if (style.color && !isPartial) {
    for (const k of indices) {
      if (k >= range.bt && k <= range.et && instructions[k]) colorAnchors.push(instructions[k]);
    }
  }

  // Font size / face: patch existing Tf / Tm only
  if (style.fontSize != null || style.bold != null || style.italic != null || style.fontFamily != null) {
    let fontKey: string | null = null;
    const fontDataForFlags = loadFontForName(run.fontName, page, objects);
    // F2/F3 resource keys are opaque — never use name-only flags (that marks bold as false).
    const currentFlags = resolveRunStyleFlags(run.fontName, fontDataForFlags);
    const wantBold = style.bold ?? currentFlags.bold;
    const wantItalic = style.italic ?? currentFlags.italic;

    if (style.fontFamily) {
      if (fontDataForFlags?.isComposite) assertTextEncodable(run.text, null, false);
      const desired = mapUIFamilyToStandard14(style.fontFamily, wantBold, wantItalic);
      fontKey = ensureStandard14Font(page, objects, desired);
    } else if (style.bold != null || style.italic != null) {
      // 1) Prefer a sibling already on the page (embedded resume fonts)
      fontKey = findSiblingFontKey(page, objects, run.fontName, wantBold, wantItalic);

      // 2) Fall back to Standard14 face we can inject
      if (!fontKey) {
        if (fontDataForFlags?.isComposite) assertTextEncodable(run.text, null, false);
        // run.fontName is an opaque resource key (F2…): use the real BaseFont.
        const realName = (fontDataForFlags?.baseFont || fontDataForFlags?.name || run.fontName).replace(/^.*\+/, '');
        let desired = resolveStyledFontName(realName, wantBold, wantItalic);
        if (!/^(Helvetica|Times|Courier)/i.test(desired)) desired = mapUIFamilyToStandard14(realName, wantBold, wantItalic);
        fontKey = ensureStandard14Font(page, objects, desired);
      }
    }

    // Partial range: split Tj into before/mid/after so fontSize/face only hit the selection
    const needsSplit = isPartial && (
      style.fontSize != null
      || (fontKey != null && (style.bold != null || style.italic != null || style.fontFamily != null))
    );
    if (needsSplit) {
      const splitOk = splitRunTextStyle(
        instructions,
        run,
        textIndex,
        clampStart,
        clampEnd,
        fontKey,
        page,
        objects,
        style.fontSize ?? null,
      );
      if (!splitOk) {
        // Fall through to whole-run patch if split failed
        applyWholeRunFontPatch(instructions, run, textIndex, range, style, fontKey, fontDataForFlags);
      }
    } else {
      applyWholeRunFontPatch(instructions, run, textIndex, range, style, fontKey, fontDataForFlags);
    }
  }

  // Underline: replace any nearby stroke, then add one spanning the selection.
  if (style.underline === true) {
    removedUnderline = removeUnderlineNearRun(instructions, run) || removedUnderline;
    const color = style.color ?? run.fillColor ?? [0, 0, 0];
    const y = run.y - visualFontSize(run) * 0.12;
    const startX = run.x + widthUpToChar(run, clampStart);
    // Full-run underlines must cover the drawn advance — glyph summation can
    // undercount after mid-line inserts when widths are estimated.
    let endX = run.x + widthUpToChar(run, clampEnd);
    if (clampStart <= 0 && clampEnd >= run.text.length) {
      endX = run.x + Math.max(run.width, endX - run.x, visualFontSize(run) * 0.5);
    }
    const w = Math.max(endX - startX, visualFontSize(run) * 0.5);
    let anchorIdx = instructions.indexOf(textAnchor);
    if (anchorIdx < 0) anchorIdx = Math.min(textIndex, instructions.length - 1);
    const range2 = findBtEtRange(instructions, anchorIdx);
    const insertAt = Math.min(instructions.length, (range2?.et ?? anchorIdx) + 1);
    // run.x / run.y are page-space; the stream may sit under a flip/scale `cm`
    // (cairo/Firefox), so map the stroke back into the CTM active at insertion.
    const inv = invertMatrix(ctmBefore(instructions, insertAt));
    const mapPt = (px: number, py: number): [number, number] =>
      inv ? [px * inv[0] + py * inv[2] + inv[4], px * inv[1] + py * inv[3] + inv[5]] : [px, py];
    const lineScale = inv ? Math.max(1e-6, Math.hypot(inv[0], inv[1])) : 1;
    const [ax, ay] = mapPt(startX, y);
    const [bx, by] = mapPt(startX + w, y);
    const ul: CSInstruction[] = [
      op('q'),
      op('RG', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('w', [new PDFNumber(Math.max(0.4, visualFontSize(run) * 0.05) * lineScale)]),
      op('m', [new PDFNumber(ax), new PDFNumber(ay)]),
      op('l', [new PDFNumber(bx), new PDFNumber(by)]),
      op('S'),
      op('Q'),
    ];
    instructions.splice(insertAt, 0, ...ul);
    addedUnderline = true;
  } else if (style.underline === false) {
    removedUnderline = removeUnderlineNearRun(instructions, run) || removedUnderline;
  }

  if (style.color && !isPartial && colorAnchors.length > 0) {
    applyScopedFillColor(instructions, colorAnchors, style.color, run.fillColor ?? [0, 0, 0]);
  }

  return { bytes: compileInstructions(instructions), addedUnderline, removedUnderline };
}

/**
 * Set the fill colour for one run only: `rg new` right before its first show op and
 * `rg original` right after its last, so later runs sharing the BT keep their colour.
 */
function applyScopedFillColor(
  instructions: CSInstruction[],
  anchors: CSInstruction[],
  color: [number, number, number],
  original: [number, number, number],
): void {
  const idx = anchors.map(a => instructions.indexOf(a)).filter(i => i >= 0).sort((a, b) => a - b);
  if (idx.length === 0) return;
  const first = idx[0];
  const last = idx[idx.length - 1];
  const rg = (c: [number, number, number]) => op('rg', [new PDFNumber(c[0]), new PDFNumber(c[1]), new PDFNumber(c[2])]);
  instructions.splice(last + 1, 0, rg(original));
  instructions.splice(first, 0, rg(color));
}

function applyWholeRunFontPatch(
  instructions: CSInstruction[],
  run: TextRun,
  textIndex: number,
  range: { bt: number; et: number },
  style: TextStylePatch,
  fontKey: string | null,
  fontData: FontData | null = null,
): void {
  const range2 = findBtEtRange(instructions, textIndex) ?? range;

  // Composite source codes must be decoded before switching to a WinAnsi face.
  if (fontKey && fontData?.isComposite) {
    const inst = instructions[textIndex];
    const reencode = (o: PDFObject): PDFObject => {
      if (!(o instanceof PDFString || o instanceof PDFHexString)) return o;
      const b = o.toBytes();
      let t = '';
      for (let i = 0; i < b.length;) {
        const length = getCharCodeLength(b, i, fontData.codeSpaceRanges);
        t += charCodeToUnicode(readCharCode(b, i, length), fontData, length) || ' ';
        i += length;
      }
      assertTextEncodable(t, null, false);
      return encodeTextWinAnsi(t).pdfString;
    };
    if (inst && (inst.operator === 'Tj' || inst.operator === "'")) {
      inst.operands = [reencode(inst.operands[0])];
    } else if (inst?.operator === '"') {
      inst.operands = [inst.operands[0], inst.operands[1], reencode(inst.operands[2])];
    } else if (inst && inst.operator === 'TJ' && inst.operands[0] instanceof PDFArray) {
      const arr = inst.operands[0] as PDFArray;
      const out = new PDFArray();
      for (let i = 0; i < arr.length; i++) out.push(reencode(arr.get(i)!));
      inst.operands = [out];
    }
  }

  // Cairo/Firefox emit many lines in ONE BT sharing a single Tf/Tm. Editing that
  // Tf/Tm would restyle every later line, so scope the change to this run only:
  // new Tf right before its text, original Tf right after.
  {
    const SHOW = new Set(['Tj', 'TJ', "'", '"']);
    const runIdx = new Set(run.sourceInstructionIndices ?? [textIndex]);
    let other = false;
    const mine: number[] = [];
    for (let k = range2.bt; k <= range2.et; k++) {
      if (!SHOW.has(instructions[k].operator)) continue;
      if (runIdx.has(k)) mine.push(k); else other = true;
    }
    let tfIdx = -1;
    for (let k = (mine[0] ?? textIndex); k >= range2.bt; k--) {
      if (instructions[k].operator === 'Tf' && instructions[k].operands.length >= 2) { tfIdx = k; break; }
    }
    if (other && mine.length > 0 && tfIdx >= 0 && (style.fontSize != null || fontKey)) {
      const oName = instructions[tfIdx].operands[0];
      const oSize = instructions[tfIdx].operands[1];
      const curTf = oSize instanceof PDFNumber ? oSize.value : run.fontSize;
      const visual = Math.max(0.1, visualFontSize(run));
      let newSize: PDFObject = oSize;
      if (style.fontSize != null) {
        const scaled = curTf > 0 && curTf <= 1.5 && Math.abs(visual - curTf) > 1;
        newSize = new PDFNumber(scaled ? (style.fontSize / visual) * curTf : style.fontSize);
      }
      const first = mine[0];
      const last = mine[mine.length - 1];
      instructions.splice(last + 1, 0, op('Tf', [oName, oSize]));
      instructions.splice(first, 0, op('Tf', [fontKey ? new PDFName(fontKey) : oName, newSize]));
      return;
    }
  }

  for (let i = textIndex; i >= range2.bt; i--) {
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      if (style.fontSize != null) {
        const tfSize = instructions[i].operands[1];
        const curTf = tfSize instanceof PDFNumber ? tfSize.value : run.fontSize;
        const visual = visualFontSize(run);
        if (curTf > 0 && curTf <= 1.5 && Math.abs(visual - curTf) > 1) {
          const scale = style.fontSize / visual;
          for (let j = textIndex; j >= range2.bt; j--) {
            if (instructions[j].operator === 'Tm' && instructions[j].operands.length >= 6) {
              for (const idx of [0, 1, 2, 3]) {
                const n = instructions[j].operands[idx];
                if (n instanceof PDFNumber) {
                  instructions[j].operands[idx] = new PDFNumber(n.value * scale);
                }
              }
              break;
            }
          }
        } else {
          instructions[i].operands[1] = new PDFNumber(style.fontSize);
        }
      }
      if (fontKey) {
        instructions[i].operands[0] = new PDFName(fontKey);
      }
      break;
    }
  }
}

function widthUpToChar(run: TextRun, charCount: number): number {
  if (charCount <= 0) return 0;
  if (!run.glyphs.length) {
    return (run.width / Math.max(1, run.text.length)) * charCount;
  }
  let w = 0;
  let chars = 0;
  for (const g of run.glyphs) {
    if (chars >= charCount) break;
    w += g.width;
    chars += (g.unicode || '').length || 1;
  }
  return w;
}

/**
 * Encode a text piece for a style split. Fall back to Helvetica/WinAnsi when the
 * subset font can't encode bullets, periods, or typed ASCII (avoids `?` / missing glyphs).
 */
function encodePieceForStyle(
  text: string,
  fontData: ReturnType<typeof loadFontForName>,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): { encoded: EncodedText; fontKey: string | null } {
  if (!text) return { encoded: encodeTextWinAnsi(''), fontKey: null };
  const encoded = encodeTextForFont(text, fontData);
  const lossy = encoded.missing.length > 0
    || (encoded.pdfString instanceof PDFString && encoded.pdfString.value.includes('?') && !text.includes('?'));
  if (lossy) {
    assertTextEncodable(text, null, false);
    const flags = resolveRunStyleFlags(fontData?.name || fontData?.baseFont || '', fontData);
    return { encoded: encodeTextWinAnsi(text), fontKey: ensureFallbackFont(page, objects, flags) };
  }
  return { encoded, fontKey: null };
}

/**
 * Split a single Tj/TJ at [localStart, localEnd) and apply a different face
 * and/or font size to the middle. Surrounding glyphs keep the original style.
 */
function splitRunTextStyle(
  instructions: CSInstruction[],
  run: TextRun,
  textIndex: number,
  localStart: number,
  localEnd: number,
  newFontKey: string | null,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  newFontSize: number | null = null,
): boolean {
  if (textIndex < 0 || textIndex >= instructions.length) return false;
  if (newFontKey == null && newFontSize == null) return false;
  const inst = instructions[textIndex];
  if (inst.operator !== 'Tj' && inst.operator !== 'TJ' && inst.operator !== "'" && inst.operator !== '"') {
    return false;
  }

  const before = run.text.slice(0, localStart);
  const mid = run.text.slice(localStart, localEnd);
  const after = run.text.slice(localEnd);
  if (!mid) return false;

  const fontData = loadFontForName(run.fontName, page, objects);

  // Find current Tf size / name
  let tfSize: PDFObject = new PDFNumber(run.fontSize);
  let origFontName = run.fontName.replace(/^\//, '');
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      tfSize = instructions[i].operands[1];
      const nameOp = instructions[i].operands[0];
      if (nameOp instanceof PDFName) origFontName = nameOp.name;
      break;
    }
  }

  // Unit Tf + scaled Tm: NEVER rewrite Tm (breaks other lines in the same BT).
  // Instead scale the mid Tf relatively: visual' = (midTf/curTf) * visual.
  const curTf = tfSize instanceof PDFNumber ? tfSize.value : run.fontSize;
  const visual = Math.max(0.1, visualFontSize(run));
  const usesScaledTm = curTf > 0 && curTf <= 1.5 && Math.abs(visual - curTf) > 1;

  let midSize: PDFObject = tfSize;
  if (newFontSize != null) {
    if (usesScaledTm) {
      // Keep Tm; choose Tf so rendered size ≈ newFontSize
      midSize = new PDFNumber((newFontSize / visual) * curTf);
    } else {
      midSize = new PDFNumber(newFontSize);
    }
  }

  // Size-only: slice existing Tj/TJ bytes by Unicode index — re-encoding through
  // subset ToUnicode was replacing the after-fragment with leading spaces.
  let beforeOperand: PDFObject | null = null;
  let midOperand: PDFObject | null = null;
  let afterOperand: PDFObject | null = null;
  let beforeFont = origFontName;
  let midFont = (newFontKey ?? origFontName).replace(/^\//, '');
  let afterFont = origFontName;
  let usedByteSplit = false;

  const sizeOnly = newFontKey == null && newFontSize != null;
  if (sizeOnly) {
    const operand = inst.operator === '"' ? inst.operands[2] : inst.operands[0];
    if (operand) {
      const sliced = splitEncodedByUnicodeIndex(
        operand,
        fontData,
        localStart,
        localEnd,
        run.text.length,
      );
      if (sliced) {
        beforeOperand = before ? sliced.before : null;
        midOperand = sliced.mid;
        afterOperand = after ? sliced.after : null;
        usedByteSplit = true;
      }
    }
  }

  if (!usedByteSplit) {
    const beforePiece = before ? encodePieceForStyle(before, fontData, page, objects) : null;
    const midPiece = encodePieceForStyle(mid, fontData, page, objects);
    const afterPiece = after ? encodePieceForStyle(after, fontData, page, objects) : null;
    beforeOperand = beforePiece?.encoded.pdfString ?? null;
    midOperand = midPiece.encoded.pdfString;
    afterOperand = afterPiece?.encoded.pdfString ?? null;
    beforeFont = (beforePiece?.fontKey ?? origFontName).replace(/^\//, '');
    midFont = (newFontKey ?? midPiece.fontKey ?? origFontName).replace(/^\//, '');
    afterFont = (afterPiece?.fontKey ?? origFontName).replace(/^\//, '');
  }


  if (!midOperand) return false;

  // Pieces with spaces need TJ advances (subset space glyphs are ~0 wide).
  // When byte-split succeeded, keep those CID bytes — re-encoding via
  // buildTJWithSpaceAdvances was desyncing mid/after advances.
  const showingOp = (
    text: string,
    operand: PDFObject,
    face: string,
    size: PDFObject,
  ): CSInstruction[] => {
    if (/ /.test(text)) {
      const tj = usedByteSplit
        ? tjFromEncodedWithSpaceAdvances(text, operand, fontData)
        : buildTJWithSpaceAdvances(text, fontData, false);
      return [op('Tf', [new PDFName(face), size]), op('TJ', [tj])];
    }
    return [op('Tf', [new PDFName(face), size]), op('Tj', [operand])];
  };

  const replacement: CSInstruction[] = [];
  // Tj advances the text matrix, so consecutive Tj ops stay on one baseline
  // without Td — inserting Td would double-advance and shift glyphs.
  if (before && beforeOperand) {
    replacement.push(...showingOp(before, beforeOperand, beforeFont, tfSize));
  }
  replacement.push(...showingOp(mid, midOperand, midFont, midSize));
  // Restore face/size for the tail (and later ops in this BT).
  if (after && afterOperand) {
    replacement.push(...showingOp(after, afterOperand, afterFont, tfSize));
  } else {
    replacement.push(op('Tf', [new PDFName(afterFont), tfSize]));
  }


  instructions.splice(textIndex, 1, ...replacement);
  return true;
}

/** Remove horizontal underline strokes near a run (q-wrapped or bare m/l/S). */
function removeUnderlineNearRun(
  instructions: CSInstruction[],
  run: TextRun,
  /** When set, translate matching strokes by this page-space delta instead of removing them. */
  shift?: { dx: number; dy: number; done?: Set<CSInstruction> },
): boolean {
  const fs = visualFontSize(run);
  const targetY = run.y - fs * 0.12;
  const runLeft = run.x - fs * 0.5;
  const runRight = run.x + Math.max(run.width, fs) + fs * 0.5;
  let removed = false;

  const tryRemoveSpan = (mIdx: number, lIdx: number, from: number, to: number): boolean => {
    const mxo = instructions[mIdx].operands[0];
    const myo = instructions[mIdx].operands[1];
    const lxo = instructions[lIdx].operands[0];
    const lyo = instructions[lIdx].operands[1];
    if (!(mxo instanceof PDFNumber) || !(myo instanceof PDFNumber)) return false;
    if (!(lxo instanceof PDFNumber) || !(lyo instanceof PDFNumber)) return false;
    // Strokes live in user space; run.x/y are page-space (flip `cm` on cairo/Firefox pages).
    const m = ctmBefore(instructions, mIdx);
    const toPage = (x: number, y: number) => ({ x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] });
    const pa = toPage(mxo.value, myo.value);
    const pb = toPage(lxo.value, lyo.value);
    const mx = { value: pa.x }; const my = { value: pa.y };
    const lx = { value: pb.x }; const ly = { value: pb.y };
    if (Math.abs(my.value - ly.value) > 0.5) return false;
    if (Math.abs(my.value - targetY) > fs * 0.35) return false;
    const strokeLeft = Math.min(mx.value, lx.value);
    const strokeRight = Math.max(mx.value, lx.value);
    if (strokeRight < runLeft || strokeLeft > runRight) return false;
    if (strokeRight - strokeLeft < fs * 0.3) return false;
    if (shift) {
      if (shift.done?.has(instructions[mIdx])) return false; // one stroke, one shift
      shift.done?.add(instructions[mIdx]);
      const d = deltaThroughInverse(m, shift.dx, shift.dy);
      instructions[mIdx].operands[0] = new PDFNumber(mxo.value + d.dx);
      instructions[mIdx].operands[1] = new PDFNumber(myo.value + d.dy);
      instructions[lIdx].operands[0] = new PDFNumber(lxo.value + d.dx);
      instructions[lIdx].operands[1] = new PDFNumber(lyo.value + d.dy);
      return true;
    }
    instructions.splice(from, to - from + 1);
    return true;
  };

  for (let i = 0; i < instructions.length - 1; i++) {
    // q … m l S Q
    if (instructions[i].operator === 'q') {
      let mIdx = -1;
      let lIdx = -1;
      let sIdx = -1;
      let qIdx = -1;
      for (let j = i + 1; j < Math.min(i + 12, instructions.length); j++) {
        const opName = instructions[j].operator;
        if (opName === 'm' && mIdx < 0) mIdx = j;
        else if (opName === 'l' && mIdx >= 0 && lIdx < 0) lIdx = j;
        else if (opName === 'S' && lIdx >= 0 && sIdx < 0) sIdx = j;
        else if (opName === 'Q' && sIdx >= 0) { qIdx = j; break; }
        else if (opName === 'q' || opName === 'BT') break;
      }
      if (mIdx >= 0 && lIdx >= 0 && sIdx >= 0 && qIdx >= 0) {
        if (tryRemoveSpan(mIdx, lIdx, i, qIdx)) {
          removed = true;
          if (shift) { i = qIdx; continue; }
          i--;
          continue;
        }
      }
    }

    // Bare m l S (common for resume path underlines)
    if (instructions[i].operator === 'm' && i + 2 < instructions.length) {
      if (instructions[i + 1].operator === 'l' && instructions[i + 2].operator === 'S') {
        // Include a preceding w / RG / rg if present (up to 3 ops)
        let from = i;
        for (let k = 1; k <= 3 && i - k >= 0; k++) {
          const prev = instructions[i - k].operator;
          if (prev === 'w' || prev === 'RG' || prev === 'rg' || prev === 'G' || prev === 'g') {
            from = i - k;
          } else break;
        }
        if (tryRemoveSpan(i, i + 1, from, i + 2)) {
          removed = true;
          i = shift ? i + 2 : Math.max(-1, from - 1);
        }
      }
    }
  }
  return removed;
}

function applyAlignmentShift(
  contentBytes: Uint8Array,
  line: TextLine,
  align: 'left' | 'center' | 'right',
): Uint8Array {
  if (align === 'left' || line.runs.length === 0) return contentBytes;

  const natural = line.width;
  const target = line.rightEdge - line.leftMargin;
  if (target <= 0) return contentBytes;

  let dx = 0;
  if (align === 'center') dx = (target - natural) / 2;
  if (align === 'right') dx = target - natural;
  if (Math.abs(dx) < 0.01) return contentBytes;

  const instructions = parseContentStream(contentBytes);
  const first = line.runs[0];
  const indices = first.sourceInstructionIndices ?? [];
  if (indices.length === 0) return contentBytes;

  const textIndex = Math.min(...indices);
  // Prefer adjusting existing Tm/Td rather than inserting a new Td
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tm' && instructions[i].operands.length >= 6) {
      const e = instructions[i].operands[4];
      const cur = e instanceof PDFNumber ? e.value : 0;
      instructions[i].operands[4] = new PDFNumber(cur + dx);
      return compileInstructions(instructions);
    }
    if ((instructions[i].operator === 'Td' || instructions[i].operator === 'TD') && instructions[i].operands.length >= 2) {
      const x = instructions[i].operands[0];
      const cur = x instanceof PDFNumber ? x.value : 0;
      instructions[i].operands[0] = new PDFNumber(cur + dx);
      return compileInstructions(instructions);
    }
  }
  return contentBytes;
}

/**
 * Duplicate a text line below itself (same glyphs, shifted down by line height).
 * Useful for table-like rows and form-style label lines.
 */
export function duplicateLineBelow(
  contentBytes: Uint8Array,
  line: TextLine,
  dyOverride?: number,
): Uint8Array {
  const instructions = parseContentStream(contentBytes);
  const dy = dyOverride ?? -(Math.max(
    line.runs[0] ? visualFontSize(line.runs[0]) : line.fontSize,
    line.fontSize,
  ) * 1.35);
  const clones: CSInstruction[] = [];
  const seenRanges = new Set<string>();

  for (const run of line.runs) {
    const indices = run.sourceInstructionIndices ?? [];
    if (indices.length === 0) continue;
    const textIndex = Math.min(...indices);
    const range = findBtEtRange(instructions, textIndex);
    if (!range) continue;
    const key = `${range.bt}:${range.et}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);

    const slice = instructions.slice(range.bt, range.et + 1).map(cloneInstruction);
    shiftInstructionsY(slice, dy);
    clones.push(...slice);
  }

  if (clones.length === 0) {
    // Fallback: inject a fresh text run under the line
    const run = line.runs[0];
    if (!run) return contentBytes;
    const color = run.fillColor ?? [0, 0, 0];
    const fs = visualFontSize(run);
    clones.push(
      op('q'),
      op('BT'),
      op('rg', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('Tf', [new PDFName(run.fontName.replace(/^\//, '')), new PDFNumber(run.fontSize || fs)]),
      op('Tm', [
        new PDFNumber(1), new PDFNumber(0), new PDFNumber(0), new PDFNumber(1),
        new PDFNumber(run.x), new PDFNumber(run.y + dy),
      ]),
      op('Tj', [new PDFString(line.text)]),
      op('ET'),
      op('Q'),
    );
  }

  instructions.push(...clones);
  return compileInstructions(instructions);
}

/** Duplicate every line in a table row one row-height below (Add Row). */
export function duplicateTableRowBelow(
  contentBytes: Uint8Array,
  rowLines: TextLine[],
): Uint8Array {
  if (rowLines.length === 0) return contentBytes;
  const heights = rowLines.map(l =>
    Math.max(l.fontSize, l.runs[0] ? visualFontSize(l.runs[0]) : l.fontSize) * 1.35,
  );
  const dy = -Math.max(...heights, 14);
  let bytes = contentBytes;
  for (const line of rowLines) {
    bytes = duplicateLineBelow(bytes, line, dy);
  }
  return bytes;
}

/**
 * Add a blank column to the right of a table by inserting empty (or " ") text
 * at each row, aligned after the rightmost cell.
 */
export function insertTableColumnRight(
  contentBytes: Uint8Array,
  rowLines: TextLine[][],
): Uint8Array {
  let bytes = contentBytes;
  for (const row of rowLines) {
    if (row.length === 0) continue;
    const rightmost = [...row].sort((a, b) => b.rightEdge - a.rightEdge)[0];
    const run = rightmost.runs[0];
    if (!run) continue;
    const fs = visualFontSize(run);
    const gap = Math.max(fs * 2.5, 20);
    const x = rightmost.rightEdge + gap;
    const y = run.y;
    const color = run.fillColor ?? [0, 0, 0];
    const instructions = parseContentStream(bytes);
    instructions.push(
      op('q'),
      op('BT'),
      op('rg', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('Tf', [new PDFName(run.fontName.replace(/^\//, '')), new PDFNumber(run.fontSize || fs)]),
      op('Tm', [
        new PDFNumber(1), new PDFNumber(0), new PDFNumber(0), new PDFNumber(1),
        new PDFNumber(x), new PDFNumber(y),
      ]),
      op('Tj', [new PDFString(' ')]),
      op('ET'),
      op('Q'),
    );
    bytes = compileInstructions(instructions);
  }
  return bytes;
}

function cloneInstruction(inst: CSInstruction): CSInstruction {
  return {
    ...inst,
    operands: inst.operands.map(o => o),
    offset: 0,
  };
}

function shiftInstructionsY(instructions: CSInstruction[], dy: number): void {
  for (const inst of instructions) {
    if (inst.operator === 'Tm' && inst.operands.length >= 6) {
      const f = inst.operands[5];
      if (f instanceof PDFNumber) inst.operands[5] = new PDFNumber(f.value + dy);
    } else if ((inst.operator === 'Td' || inst.operator === 'TD') && inst.operands.length >= 2) {
      const y = inst.operands[1];
      if (y instanceof PDFNumber) inst.operands[1] = new PDFNumber(y.value + dy);
    } else if ((inst.operator === 'm' || inst.operator === 'l') && inst.operands.length >= 2) {
      const y = inst.operands[1];
      if (y instanceof PDFNumber) inst.operands[1] = new PDFNumber(y.value + dy);
    }
  }
}



/**
 * Underlines on cairo/Firefox pages are separate stroked paths, not part of the text.
 * When text is moved, translate the strokes sitting under it by the same page-space delta.
 */
export function moveUnderlinesWithRuns(
  contentBytes: Uint8Array,
  runs: TextRun[],
  dx: number,
  dy: number,
): Uint8Array {
  if (runs.length === 0 || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) return contentBytes;
  const instructions = parseContentStream(contentBytes);
  let any = false;
  const done = new Set<CSInstruction>();
  for (const run of runs) {
    if (removeUnderlineNearRun(instructions, run, { dx, dy, done })) any = true;
  }
  return any ? compileInstructions(instructions) : contentBytes;
}
