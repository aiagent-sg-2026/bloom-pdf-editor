/**
 * Content Stream Text Editor
 *
 * Modifies text directly in a PDF page's content stream.
 * This is the core "inline editing" capability — what makes this
 * an Adobe Acrobat-class tool rather than a simple viewer.
 *
 * Operations:
 *   - Replace text within a Tj/TJ operator
 *   - Insert new text at a position
 *   - Delete text from a content stream
 *   - Reflow text with adjusted spacing
 *
 * The editor works at the token level: it locates the exact Tj/TJ
 * instruction in the content stream, modifies its operands, and
 * recompiles the stream.
 */

import { ctmBefore, deltaThroughInverse, invertMatrix } from './matrix';
import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { serializeInstructions } from '../content/instruction-serializer';
import { interpretPage, type TextRun } from '../content/interpreter';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFPageInfo,
} from '../types';
import { resolveRef, resolvePageResources } from '../parser/parser';
import { loadFont, type FontData, charCodeToUnicode } from '../fonts/font-parser';
import { getCharCodeLength, getCodeBytes, isCodeInCodeSpace, readCharCode } from '../fonts/cmap-parser';
import { ensureFallbackFont, registerFontObject } from '../fonts/font-augmentation';
import { ensureBuiltInFallbackFont, getBuiltInFallbackGlyph } from '../fonts/symbol-fallback';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';
import {
  prepareUnicodeText, unicodeTextRuns, hasUnicodeGlyph, ensureUnicodeFont, encodeUnicodeText, unicodeGlyphWidth,
  shapedTextWidth, emitShapedText, preparedShapedClusters,
  type UnicodeFontSources,
} from '../fonts/unicode-font-embed';
import { type ScriptFontId, type ScriptFontOptions, scriptFontId, isShapingFont } from '../fonts/script-fonts';
import { getStandardFontCharWidth } from '../fonts/standard14';
import { resolveRunStyleFlags } from '../flow/metrics';
import { serializeToString } from './stream-compiler';
import { isolateBaseCtm } from './content-append';

/** Visual size for Tf when switching to the Helvetica fallback. */
function runFontSize(run: TextRun): number {
  if (run.glyphs.length > 0) {
    const tRm = run.glyphs[0].tRm;
    const fromTm = Math.hypot(tRm.a, tRm.b) || Math.hypot(tRm.c, tRm.d);
    if (fromTm > 0.5) return fromTm;
  }
  return run.fontSize > 0.5 ? run.fontSize : 12;
}

// ─── Edit operations ────────────────────────────────────────────────────────

export interface TextEdit {
  /** The text run being edited (from the interpreter's display list) */
  targetRun: TextRun;
  /** New text to replace the original */
  newText: string;
}

export interface EditResult {
  /** The modified content stream bytes */
  newContentBytes: Uint8Array;
  /** Whether font augmentation is needed (new glyphs required) */
  needsFontAugmentation: boolean;
  /** Character codes that are missing from the font */
  missingCharCodes: number[];
}

export interface RunPositionShift {
  run: TextRun;
  dx: number;
  dy: number;
}

// ─── Main editing function ──────────────────────────────────────────────────

/**
 * Apply text edits to a page's content stream.
 *
 * @param contentBytes Original decoded content stream bytes
 * @param page Page info for resources
 * @param objects Document object map
 * @param edits Array of text edits to apply
 * @returns Modified content stream bytes
 */
export function applyTextEdits(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  edits: TextEdit[],
): EditResult {
  // Validate the entire batch before adding fallback resources or changing run indices.
  if (edits.some(edit => edit.newText !== edit.targetRun.text && edit.targetRun.actualText)) {
    throw new Error('Exported shaped text cannot be edited in place; add a new text box instead.');
  }
  const prepared = edits.filter(edit => edit.newText !== edit.targetRun.text).map(edit => {
    const fontData = loadFontForRun(edit.targetRun, page, objects);
    const encoded = encodeTextForFont(edit.newText, fontData);
    return { edit, fontData, encoded };
  });
  const unsupported = prepared.flatMap(({ edit, fontData, encoded }) =>
    unsupportedFallbackCodePoints(edit.newText, fontData, encoded));
  const unavailable = unsupported.filter(cp => !hasUnicodeGlyph(objects, cp));
  if (unavailable.length > 0) throw new UnsupportedGlyphsError(unavailable);
  for (const { edit, fontData } of prepared) assertTextEncodable(edit.newText, fontData, true, objects);

  // Parse the content stream into instructions
  const instructions = parseContentStream(contentBytes);

  // Build a map of text-showing instructions with their byte offsets
  const textInstructions = findTextInstructions(instructions);

  let needsFontAugmentation = false;
  const missingCharCodes: number[] = [];
  let indexOffset = 0;

  // Apply each edit
  for (const { edit, fontData, encoded: initialEncoding } of prepared) {
    let encoded = initialEncoding;
    const lossy = isEncodingLossy(edit.newText, encoded, fontData);
    // A covered Unicode scalar may still be lost by whole-run WinAnsi fallback.
    // Split fonts even when no new Unicode subset needs preparation.
    const usesUnicode = unsupportedFallbackCodePoints(edit.newText, fontData, initialEncoding).length > 0 ||
      (lossy && unsupportedFallbackCodePoints(edit.newText, null, encodeTextWinAnsi(edit.newText)).length > 0);
    let useFallbackFont: string | null = null;
    const specialChars = Array.from(edit.newText).some(ch => getBuiltInFallbackGlyph(ch) !== null);

    if (lossy && !usesUnicode) {
      // Keep bold/italic of the source run — HelvAug (regular) was stripping
      // weight from mid-line edits on subset/CID bold faces (F2, etc.).
      const flags = resolveRunStyleFlags(edit.targetRun.fontName, fontData);
      useFallbackFont = ensureFallbackFont(page, objects, flags);
      encoded = encodeTextWinAnsi(edit.newText);
      const unknown = encoded.missing.filter(cp => getBuiltInFallbackGlyph(String.fromCodePoint(cp)) === null);
      needsFontAugmentation = unknown.length > 0;
      missingCharCodes.push(...unknown);
      if (specialChars) {
        for (const ch of Array.from(edit.newText)) {
          const glyph = getBuiltInFallbackGlyph(ch);
          if (glyph) ensureBuiltInFallbackFont(page, objects, glyph.fontKind);
        }
      }
    } else if (!usesUnicode && encoded.missing.length > 0) {
      needsFontAugmentation = true;
      missingCharCodes.push(...encoded.missing);
    }

    const rawIndices = edit.targetRun.sourceInstructionIndices ?? [];
    let sourceInstructionIndices = rawIndices.map(i => i + indexOffset);

    if (sourceInstructionIndices.length > 1) {
      const fullyMatched = sourceInstructionIndices.every(idx => {
        const inst = instructions[idx];
        return inst && isTextShowingOperator(inst.operator);
      });
      if (!fullyMatched) {
        // Unmatched source indices can leave original glyphs in the stream.
        // Keep the white erase only for this incomplete-rewrite fallback.
        const inserted = insertEraseRectForRun(
          instructions,
          edit.targetRun,
          Math.min(...sourceInstructionIndices),
        );
        indexOffset += inserted;
        sourceInstructionIndices = sourceInstructionIndices.map(i => i + inserted);
      }
      const wrote = applyGroupedTextEdit(
        instructions,
        sourceInstructionIndices,
        edit.newText,
        encoded,
        useFallbackFont,
        edit.targetRun,
        fontData,
        usesUnicode ? { page, objects } : undefined,
      );
      indexOffset += wrote;
      continue;
    }

    // Prefer stable index-based matching (immune to fuzzy text match failures)
    let matched: TextInstruction | null = null;
    if (sourceInstructionIndices.length === 1) {
      const idx = sourceInstructionIndices[0];
      const inst = instructions[idx];
      if (inst && isTextShowingOperator(inst.operator)) {
        matched = {
          index: idx,
          instruction: inst,
          fontInstruction: null,
          fontName: edit.targetRun.fontName,
          fontSize: edit.targetRun.fontSize,
          tmX: edit.targetRun.x,
          tmY: edit.targetRun.y,
        };
      }
    }

    if (!matched) {
      matched = matchTextRunToInstruction(
        edit.targetRun,
        textInstructions,
        contentBytes,
        page,
        objects,
      );
      if (matched) {
        // Earlier edits may have inserted operators before this fuzzy match.
        matched.index = instructions.indexOf(matched.instruction);
        if (matched.index < 0) matched = null;
      }
    }

    if (!matched) {
      if (sourceInstructionIndices.length === 1) {
        // Only a placement hint remains: the original showing op was not found.
        indexOffset += insertEraseRectForRun(
          instructions,
          edit.targetRun,
          sourceInstructionIndices[0],
        );
      }
      console.warn('[TextEditor] Could not match text run to instruction');
      continue;
    }

    if (usesUnicode) {
      indexOffset += applyUnicodeShowing(instructions, matched.index, edit.newText,
        edit.targetRun.fontName, fontData, page, objects, edit.targetRun.fontSize);
      continue;
    }
    // Spaces: subset fonts often have ~0 space advance (live CSS shows gaps,
    // PDF does not). Emit TJ with explicit advances instead of a bare string.
    if (specialChars && useFallbackFont) {
      const inserted = applySpecialFallbackShowing(
        instructions,
        matched.index,
        edit.newText,
        useFallbackFont,
        edit.targetRun.fontName,
        runFontSize(edit.targetRun),
      );
      indexOffset += inserted;
      continue;
    }

    const tjArr = matched.instruction.operator === 'TJ' ? matched.instruction.operands[0] : null;
    const patched =
      !useFallbackFont && tjArr instanceof PDFArray
        ? patchTJPreservingGaps(tjArr, edit.targetRun.text, edit.newText, fontData, runEmWidth(edit.targetRun, fontData))
        : null;
    if (patched) {
      matched.instruction.operands = [patched];
    } else {
      applyEncodedShowingOperands(
        matched.instruction,
        edit.newText,
        encoded,
        fontData,
        !!useFallbackFont,
      );
    }

    // Switch to Helvetica when the original subset font can't encode the typed text.
    // Restore the prior font afterward so later Type3 letters in the same BT
    // are not mis-drawn as WinAnsi (Type3 byte 0x48 under Helvetica → "H").
    if (useFallbackFont) {
      const inserted = insertFallbackFontAround(
        instructions,
        matched.index,
        useFallbackFont,
        runFontSize(edit.targetRun),
      );
      indexOffset += inserted;
    }
  }

  // Recompile the instructions back into a content stream
  const newBytes = compileInstructions(instructions);

  return {
    newContentBytes: newBytes,
    needsFontAugmentation,
    missingCharCodes,
  };
}

/**
 * Shift text runs by modifying Tm/Td operands in their BT block.
 * Used by the flow layout layer for horizontal reflow and line push-down.
 */
export function applyRunPositionShifts(
  contentBytes: Uint8Array,
  shifts: RunPositionShift[],
  /** Extra runs whose sourceInstructionIndices must stay in sync when we inject ops. */
  indexPeers: TextRun[] = [],
): Uint8Array {
  if (shifts.length === 0) return contentBytes;

  const instructions = parseContentStream(contentBytes);
  const merged = new Map<TextRun, { dx: number; dy: number }>();
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    const prev = merged.get(s.run) ?? { dx: 0, dy: 0 };
    prev.dx += s.dx;
    prev.dy += s.dy;
    merged.set(s.run, prev);
  }

  type ShiftItem = { textIndex: number; dx: number; dy: number; run: TextRun };
  const items: ShiftItem[] = [];
  merged.forEach((delta, run) => {
    const indices = run.sourceInstructionIndices;
    if (!indices || indices.length === 0) return;
    if (Math.abs(delta.dx) < 0.01 && Math.abs(delta.dy) < 0.01) return;
    items.push({ textIndex: Math.min(...indices), dx: delta.dx, dy: delta.dy, run });
  });
  items.sort((a, b) => a.textIndex - b.textIndex);

  // Prefer in-place Tm/Td in the BT, then CTM `cm` just outside it. Resume
  // generators often position via `cm` with a bare BT/Tj — absolute Tm inject
  // double-counts under CTM. Last resort: absolute Tm (identity CTM).
  const appliedToOp = new Map<number, { dx: number; dy: number }>();
  const trackedRuns: TextRun[] = [];
  const seen = new Set<TextRun>();
  merged.forEach((_, run) => {
    if (!seen.has(run)) { seen.add(run); trackedRuns.push(run); }
  });
  for (let p = 0; p < indexPeers.length; p++) {
    const run = indexPeers[p];
    if (!seen.has(run)) { seen.add(run); trackedRuns.push(run); }
  }

  const bumpIndicesFrom = (at: number, by: number) => {
    for (let r = 0; r < trackedRuns.length; r++) {
      const idxs = trackedRuns[r].sourceInstructionIndices;
      if (!idxs) continue;
      for (let k = 0; k < idxs.length; k++) {
        if (idxs[k] >= at) idxs[k] += by;
      }
    }
    for (let j = 0; j < items.length; j++) {
      if (items[j].textIndex >= at) items[j].textIndex += by;
    }
    // Position-op map keys shift when we insert before them
    const nextMap = new Map<number, { dx: number; dy: number }>();
    appliedToOp.forEach((v, key) => {
      nextMap.set(key >= at ? key + by : key, v);
    });
    appliedToOp.clear();
    nextMap.forEach((v, key) => appliedToOp.set(key, v));
  };

  const resolvePos = (textIndex: number) =>
    findTextPositionInstruction(instructions, textIndex)
    ?? findCtmPositionInstruction(instructions, textIndex);

  const findBtIndex = (textIndex: number): number => {
    for (let i = textIndex; i >= 0; i--) {
      if (instructions[i].operator === 'ET') return -1;
      if (instructions[i].operator === 'BT') return i;
    }
    return -1;
  };


  // Shifts arrive in page space. Convert to the space the edited operand lives
  // in: user space (inverse of the CTM before the op) for Tm / cm, and text
  // space (additionally the inverse of the live text matrix' linear part) for
  // Td / TD. Identity pages are unaffected.
  const toOperandSpace = (opIndex: number, dx: number, dy: number, text: boolean) => {
    const user = deltaThroughInverse(ctmBefore(instructions, opIndex), dx, dy);
    if (!text) return user;
    let tm: number[] | null = null;
    for (let i = opIndex - 1; i >= 0; i--) {
      const o = instructions[i].operator;
      if (o === 'BT') break;
      if (o === 'Tm' && instructions[i].operands.length >= 6) {
        tm = instructions[i].operands.slice(0, 6).map(numVal);
        break;
      }
    }
    return tm ? deltaThroughInverse(tm, user.dx, user.dy) : user;
  };

  // True when mutating `posIndex` would also move a run that is not in this
  // shift batch (shared BT Tm/Td or outer cm). Resume streams often park a
  // whole line under one cm — nudging a trailer would drag earlier runs and
  // invent a column gutter mid-line.
  const posSharedWithUnshifted = (posIndex: number, self: TextRun): boolean => {
    for (let r = 0; r < trackedRuns.length; r++) {
      const other = trackedRuns[r];
      if (other === self || merged.has(other)) continue;
      const idxs = other.sourceInstructionIndices;
      if (!idxs || idxs.length === 0) continue;
      const otherPos = resolvePos(Math.min(...idxs));
      if (otherPos && otherPos.index === posIndex) return true;
    }
    return false;
  };

  const injectLocalTd = (textIndex: number, dx: number, dy: number) => {
    const d = toOperandSpace(textIndex, dx, dy, true);
    instructions.splice(textIndex, 0, {
      operator: 'Td',
      operands: [new PDFNumber(d.dx), new PDFNumber(d.dy)],
      offset: 0,
    });
    bumpIndicesFrom(textIndex, 1);
  };

  // One local Td advances the text matrix for later showing ops in the same BT.
  const localTdByBt = new Map<number, { dx: number; dy: number }>();
  // Last shifted show-op index per BT (kept in sync with inserts below).
  const lastShiftedShow = new Map<number, number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.textIndex < 0 || item.textIndex >= instructions.length) {
      continue;
    }

    const pos = resolvePos(item.textIndex);

    if (!pos) {
      // Prefer local Td inside the BT — absolute Tm at run.x is wrong for
      // after-fragments of a style split (run.x is the before-origin while
      // glyphs already sit further right via Tj advance).
      const bt = findBtIndex(item.textIndex);
      if (bt >= 0) {
        const prevLocal = localTdByBt.get(bt) ?? { dx: 0, dy: 0 };
        const needDx = item.dx - prevLocal.dx;
        const needDy = item.dy - prevLocal.dy;
        if (Math.abs(needDx) >= 0.01 || Math.abs(needDy) >= 0.01) {
          injectLocalTd(item.textIndex, needDx, needDy);
          localTdByBt.set(bt, { dx: prevLocal.dx + needDx, dy: prevLocal.dy + needDy });
        }
        continue;
      }
      // Last resort: absolute Tm from glyph origin (not run.x).
      const g0 = item.run.glyphs[0]?.tRm;
      const absX = (g0?.e ?? item.run.x) + item.dx;
      const absY = (g0?.f ?? item.run.y) + item.dy;
      const insertAt = item.textIndex;
      instructions.splice(insertAt, 0, {
        operator: 'Tm',
        operands: [
          new PDFNumber(1), new PDFNumber(0), new PDFNumber(0), new PDFNumber(1),
          new PDFNumber(absX), new PDFNumber(absY),
        ],
        offset: 0,
      });
      bumpIndicesFrom(insertAt, 1);
      appliedToOp.set(insertAt, { dx: item.dx, dy: item.dy });
      continue;
    }

    const already = appliedToOp.get(pos.index) ?? { dx: 0, dy: 0 };
    const remainDx = item.dx - already.dx;
    const remainDy = item.dy - already.dy;
    if (Math.abs(remainDx) < 0.01 && Math.abs(remainDy) < 0.01) {
      continue;
    }

    if (posSharedWithUnshifted(pos.index, item.run)) {
      const bt = findBtIndex(item.textIndex);
      const prevLocal = bt >= 0 ? (localTdByBt.get(bt) ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 };
      const needDx = item.dx - prevLocal.dx;
      const needDy = item.dy - prevLocal.dy;
      if (Math.abs(needDx) < 0.01 && Math.abs(needDy) < 0.01) {
        continue;
      }
      injectLocalTd(item.textIndex, needDx, needDy);
      if (bt >= 0) {
        localTdByBt.set(bt, { dx: prevLocal.dx + needDx, dy: prevLocal.dy + needDy });
      }
      continue;
    }

    const inst = instructions[pos.index];
    if ((pos.kind === 'Tm' || pos.kind === 'cm') && inst.operands.length >= 6) {
      const d = toOperandSpace(pos.index, remainDx, remainDy, false);
      inst.operands[4] = new PDFNumber(numVal(inst.operands[4]) + d.dx);
      inst.operands[5] = new PDFNumber(numVal(inst.operands[5]) + d.dy);
      appliedToOp.set(pos.index, {
        dx: already.dx + remainDx,
        dy: already.dy + remainDy,
      });
      if (pos.kind === 'Tm') {
        // An absolute Tm restarts the relative-Td chain at this shift.
        const bt = findBtIndex(item.textIndex);
        if (bt >= 0) {
          localTdByBt.set(bt, { dx: item.dx, dy: item.dy });
          lastShiftedShow.set(bt, item.textIndex);
        }
      }
    } else if (pos.kind === 'Td' || inst.operator === 'Td' || inst.operator === 'TD') {
      // Relative Td/TD: applying the full absolute dx to every glyph's Td
      // stacks shifts (Type3 per-letter score cards explode to the right).
      // Only apply the delta beyond what earlier local Td already contributed.
      const bt = findBtIndex(item.textIndex);
      const prevLocal = bt >= 0 ? (localTdByBt.get(bt) ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 };
      const needDx = item.dx - prevLocal.dx;
      const needDy = item.dy - prevLocal.dy;
      if (Math.abs(needDx) < 0.01 && Math.abs(needDy) < 0.01) {
        continue;
      }
      if (inst.operands.length >= 2) {
        const d = toOperandSpace(pos.index, needDx, needDy, true);
        inst.operands[0] = new PDFNumber(numVal(inst.operands[0]) + d.dx);
        inst.operands[1] = new PDFNumber(numVal(inst.operands[1]) + d.dy);
      }
      if (bt >= 0) {
        localTdByBt.set(bt, { dx: prevLocal.dx + needDx, dy: prevLocal.dy + needDy });
        lastShiftedShow.set(bt, item.textIndex);
      }
      appliedToOp.set(pos.index, {
        dx: already.dx + needDx,
        dy: already.dy + needDy,
      });
    } else if (inst.operands.length >= 2) {
      inst.operands[0] = new PDFNumber(numVal(inst.operands[0]) + remainDx);
      inst.operands[1] = new PDFNumber(numVal(inst.operands[1]) + remainDy);
      appliedToOp.set(pos.index, {
        dx: already.dx + remainDx,
        dy: already.dy + remainDy,
      });
    } else {
      continue;
    }
  }

  // Relative Td chains: the shift applied to a Td also moves every later run
  // that is positioned relative to it. Cancel it on the first relative op after
  // the last shifted run so the rest of the BT stays put (an absolute Tm ends
  // the chain, nothing to cancel).
  localTdByBt.forEach((cum, bt) => {
    if (Math.abs(cum.dx) < 0.01 && Math.abs(cum.dy) < 0.01) return;
    const from = lastShiftedShow.get(bt);
    if (from === undefined) return;
    for (let i = from + 1; i < instructions.length; i++) {
      const o = instructions[i].operator;
      if (o === 'ET' || o === 'Tm') break;
      if ((o === 'Td' || o === 'TD') && instructions[i].operands.length >= 2) {
        const d = toOperandSpace(i, -cum.dx, -cum.dy, true);
        instructions[i].operands[0] = new PDFNumber(numVal(instructions[i].operands[0]) + d.dx);
        instructions[i].operands[1] = new PDFNumber(numVal(instructions[i].operands[1]) + d.dy);
        break;
      }
    }
  });

  return compileInstructions(instructions);
}

function findTextPositionInstruction(
  instructions: CSInstruction[],
  textIndex: number,
): { index: number; kind: 'Tm' | 'Td' } | null {
  if (textIndex < 0 || textIndex >= instructions.length) return null;

  let btIndex = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'ET') return null;
    if (instructions[i].operator === 'BT') {
      btIndex = i;
      break;
    }
  }
  if (btIndex < 0) return null;

  let last: { index: number; kind: 'Tm' | 'Td' } | null = null;
  for (let i = btIndex; i < textIndex; i++) {
    const op = instructions[i].operator;
    if (op === 'Tm') last = { index: i, kind: 'Tm' };
    else if (op === 'Td' || op === 'TD') last = { index: i, kind: 'Td' };
  }

  return last;
}

/**
 * CTM translate that still applies at BT. Resume streams often do:
 *   cm  q  BT ... ET  Q
 * so we must walk past the opening `q` (not stop there). Skip nested
 * q/Q pairs so we don't pick a cm from an already-restored region.
 */
function findCtmPositionInstruction(
  instructions: CSInstruction[],
  textIndex: number,
): { index: number; kind: 'cm' } | null {
  if (textIndex < 0 || textIndex >= instructions.length) return null;

  let btIndex = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'ET') return null;
    if (instructions[i].operator === 'BT') {
      btIndex = i;
      break;
    }
  }
  if (btIndex < 0) return null;

  let nest = 0;
  for (let i = btIndex - 1; i >= 0; i--) {
    const op = instructions[i].operator;
    if (op === 'Q') {
      nest++;
      continue;
    }
    if (op === 'q') {
      if (nest > 0) nest--;
      continue;
    }
    if (nest === 0 && op === 'cm' && instructions[i].operands.length >= 6) {
      return { index: i, kind: 'cm' };
    }
  }
  return null;
}

/**
 * Inserts a new text run into a page's content stream.
 *
 * @param contentBytes Original decoded content stream bytes
 * @param page Page info for resources
 * @param objects Document object map
 * @param text The new text to insert
 * @param x X coordinate (PDF units)
 * @param y Y coordinate (PDF units)
 * @param fontSize Font size in points
 * @param color RGB color [0-1, 0-1, 0-1]
 * @returns Modified content stream bytes
 */
export function insertTextRun(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: [number, number, number],
  options: {
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    opacity?: number;
    width?: number;
  } = {},
): Uint8Array {
  assertTextEncodable(text, null, true, objects);
  const usesUnicode = unsupportedFallbackCodePoints(text, null, encodeTextWinAnsi(text)).length > 0;
  // Copy membership dictionaries, including inherited/indirect resources.
  const effective = resolvePageResources(page.dict, objects);
  const resources = new PDFDict([...effective.entries()]);
  const fontObj = effective.get('Font');
  const oldFonts = fontObj ? resolveRef(fontObj, objects) : undefined;
  const fontDict = new PDFDict(oldFonts instanceof PDFDict ? [...oldFonts.entries()] : []);
  resources.set('Font', fontDict);
  page.dict.set('Resources', resources);
  page.resources = resources;
  
  const family = (options.fontFamily || 'Helvetica').toLowerCase();
  const baseFamily = family.includes('times') ? 'Times' : family.includes('courier') ? 'Courier' : 'Helvetica';
  const fontName = baseFamily === 'Times'
    ? (options.bold && options.italic ? 'Times-BoldItalic' : options.bold ? 'Times-Bold' : options.italic ? 'Times-Italic' : 'Times-Roman')
    : baseFamily === 'Courier'
      ? (options.bold && options.italic ? 'Courier-BoldOblique' : options.bold ? 'Courier-Bold' : options.italic ? 'Courier-Oblique' : 'Courier')
      : (options.bold && options.italic ? 'Helvetica-BoldOblique' : options.bold ? 'Helvetica-Bold' : options.italic ? 'Helvetica-Oblique' : 'Helvetica');
  const resourceName = fontName === 'Helvetica' ? 'Helv' : fontName.replace(/[^A-Za-z]/g, '');
  if (!fontDict.has(resourceName)) {
    const helvetica = new PDFDict();
    helvetica.set('Type', new PDFName('Font'));
    helvetica.set('Subtype', new PDFName('Type1'));
    helvetica.set('BaseFont', new PDFName(fontName));
    helvetica.set('Encoding', new PDFName('WinAnsiEncoding'));
    fontDict.set(resourceName, registerFontObject(objects, helvetica));
  }
  const selectedFont = resolveRef(fontDict.get(resourceName)!, objects);
  if (selectedFont instanceof PDFDict && !selectedFont.has('Encoding')) {
    selectedFont.set('Encoding', new PDFName('WinAnsiEncoding'));
  }

  const safeColor = color.map(v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0) as [number, number, number];
  const [r, g, b] = safeColor;
  const lines = text.split(/\r?\n/);
  const leading = Math.max(0.1, fontSize * 1.2);
  const commands: string[] = [`\nq`, `${r} ${g} ${b} rg`, `${r} ${g} ${b} RG`];
  const underlineSegments: string[] = [];
  const measure = (t: string): number => {
    let w = 0;
    const needed = new Set(unsupportedFallbackCodePoints(t, null, encodeTextWinAnsi(t)));
    const selected = needed.size ? unicodeTextRuns(objects, t, needed) : [{ fontId: 'latin' as const, text: t }];
    for (const { fontId, text: part } of selected) {
      if (isShapingFont(fontId)) { w += shapedTextWidth(objects, part, fontId); continue; }
      for (const ch of part) {
        const cp = ch.codePointAt(0)!;
        const special = getBuiltInFallbackGlyph(ch);
        w += hasUnicodeGlyph(objects, cp) && unsupportedFallbackCodePoints(ch, null, encodeTextWinAnsi(ch)).length
          ? unicodeGlyphWidth(objects, cp, fontId)
          : special ? getStandardFontCharWidth(special.fontKind, special.code)
          : getStandardFontCharWidth(fontName, encodeTextWinAnsi(ch).pdfString.toBytes()[0] ?? 32);
      }
    }
    return (w / 1000) * fontSize;
  };
  const opacity = options.opacity == null ? 1 : Math.max(0, Math.min(1, options.opacity));
  if (opacity < 1) {
    const gs = new PDFDict();
    gs.set('Type', new PDFName('ExtGState'));
    gs.set('ca', new PDFNumber(opacity));
    gs.set('CA', new PDFNumber(opacity));
    const gsName = 'TxGS';
    let gsResources = resources.get('ExtGState');
    if (!(gsResources instanceof PDFDict)) { gsResources = new PDFDict(); resources.set('ExtGState', gsResources); }
    gsResources.set(gsName, gs);
    commands.push(`/${gsName} gs`);
  }
  commands.push('BT');
  const widthLimit = Number.isFinite(options.width) && (options.width || 0) > 0 ? options.width! : Infinity;
  let visualLine = 0;
  lines.forEach(line => {
    const chunks: string[] = [];
    let current = '';
    for (const word of line.split(/(\s+)/)) {
      // Do not split a complex-script syllable/conjunct at an arbitrary code point.
      if (usesUnicode && measure(word) > widthLimit &&
          !unicodeTextRuns(objects, word, new Set(unsupportedFallbackCodePoints(word, null, encodeTextWinAnsi(word))))
            .some(part => isShapingFont(part.fontId))) {
        for (const ch of word) {
          if (current && measure(current + ch) > widthLimit) { chunks.push(current); current = ''; }
          current += ch;
        }
        continue;
      }
      if (current && measure(current + word) > widthLimit) {
        chunks.push(current); current = '';
      }
      current += word;
    }
    chunks.push(current);
    chunks.forEach(chunk => {
      const dy = visualLine++ * leading;
      commands.push(`1 0 0 1 ${x} ${y - dy} Tm`);
      if (usesUnicode) {
        commands.push(serializeToStringInstructions(exportShowingInstructions(chunk, resourceName, null, page, objects, fontSize)));
      } else {
        let run = '';
        const flush = () => { if (run) { commands.push(`/${resourceName} ${fontSize} Tf`); commands.push(`${serializeToString(encodeTextWinAnsi(run).pdfString)} Tj`); run = ''; } };
        for (const ch of chunk) {
          const glyph = getBuiltInFallbackGlyph(ch);
          if (glyph) {
            flush();
            const fallbackName = ensureBuiltInFallbackFont(page, objects, glyph.fontKind);
            commands.push(`/${fallbackName} ${fontSize} Tf ${serializeToString(new PDFString(String.fromCharCode(glyph.code)))} Tj`);
          } else run += ch;
        }
        flush();
      }
      if (options.underline && chunk.trim().length) {
        const uy = Math.round((y - dy - fontSize * 0.12) * 100) / 100;
        underlineSegments.push(`${x} ${uy} m ${Math.round((x + measure(chunk.replace(/\s+$/, ''))) * 100) / 100} ${uy} l S`);
      }
    });
  });
  commands.push('ET');
  if (underlineSegments.length) commands.push(`${Math.max(0.3, Math.round(fontSize * 0.06 * 100) / 100)} w`, ...underlineSegments);
  commands.push('Q', '');
  const injection = `\n${commands.join('\n')}`;
  const enc = new TextEncoder();
  const injectionBytes = enc.encode(injection);

  // Concat using a helper
  const base = isolateBaseCtm(contentBytes);
  const newBytes = new Uint8Array(base.length + injectionBytes.length);
  newBytes.set(base);
  newBytes.set(injectionBytes, base.length);

  return newBytes;
}

// ─── Text instruction matching ──────────────────────────────────────────────

interface TextInstruction {
  instruction: CSInstruction;
  index: number;
  /** The preceding Tf instruction (font selection) */
  fontInstruction: CSInstruction | null;
  /** Font name from the most recent Tf */
  fontName: string;
  /** Font size from the most recent Tf */
  fontSize: number;
  /** Approximate X position from text matrix (user space) */
  tmX: number;
  /** Approximate Y position from text matrix (user space) */
  tmY: number;
}

function numVal(obj: PDFObject | undefined): number {
  return obj instanceof PDFNumber ? obj.value : 0;
}

function findTextInstructions(instructions: CSInstruction[]): TextInstruction[] {
  const result: TextInstruction[] = [];
  let currentFont = '';
  let currentFontSize = 12;
  let lastTfInstruction: CSInstruction | null = null;

  // Track text matrix for position-based matching
  // tm = [a, b, c, d, e, f] where e=x, f=y in user space
  let tmE = 0, tmF = 0;     // text matrix translation (position)
  let tlmE = 0, tlmF = 0;   // text line matrix translation
  let tmA = 1, tmB = 0, tmC = 0, tmD = 1;  // text matrix rotation/scale
  let tlmA = 1, tlmB = 0, tlmC = 0, tlmD = 1;
  let textLeading = 0;

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];

    switch (inst.operator) {
      case 'BT':
        tmA = 1; tmB = 0; tmC = 0; tmD = 1; tmE = 0; tmF = 0;
        tlmA = 1; tlmB = 0; tlmC = 0; tlmD = 1; tlmE = 0; tlmF = 0;
        break;

      case 'Tm': {
        tmA = numVal(inst.operands[0]); tmB = numVal(inst.operands[1]);
        tmC = numVal(inst.operands[2]); tmD = numVal(inst.operands[3]);
        tmE = numVal(inst.operands[4]); tmF = numVal(inst.operands[5]);
        tlmA = tmA; tlmB = tmB; tlmC = tmC; tlmD = tmD;
        tlmE = tmE; tlmF = tmF;
        break;
      }

      case 'Td': {
        const tx = numVal(inst.operands[0]);
        const ty = numVal(inst.operands[1]);
        // textLineMatrix = translate(tx,ty) * textLineMatrix
        tlmE = tlmA * tx + tlmC * ty + tlmE;
        tlmF = tlmB * tx + tlmD * ty + tlmF;
        tmA = tlmA; tmB = tlmB; tmC = tlmC; tmD = tlmD;
        tmE = tlmE; tmF = tlmF;
        break;
      }

      case 'TD': {
        const tx = numVal(inst.operands[0]);
        const ty = numVal(inst.operands[1]);
        textLeading = -ty;
        tlmE = tlmA * tx + tlmC * ty + tlmE;
        tlmF = tlmB * tx + tlmD * ty + tlmF;
        tmA = tlmA; tmB = tlmB; tmC = tlmC; tmD = tlmD;
        tmE = tlmE; tmF = tlmF;
        break;
      }

      case 'T*': {
        const ty = -textLeading;
        tlmE = tlmC * ty + tlmE;
        tlmF = tlmD * ty + tlmF;
        tmA = tlmA; tmB = tlmB; tmC = tlmC; tmD = tlmD;
        tmE = tlmE; tmF = tlmF;
        break;
      }

      case 'TL':
        textLeading = numVal(inst.operands[0]);
        break;

      case 'Tf':
        currentFont = inst.operands[0] instanceof PDFName ? inst.operands[0].name : '';
        currentFontSize = inst.operands[1] instanceof PDFNumber ? inst.operands[1].value : 12;
        lastTfInstruction = inst;
        break;
    }

    if (inst.operator === 'Tj' || inst.operator === 'TJ' ||
        inst.operator === "'" || inst.operator === '"') {
      result.push({
        instruction: inst,
        index: i,
        fontInstruction: lastTfInstruction,
        fontName: currentFont,
        fontSize: currentFontSize,
        tmX: tmE,
        tmY: tmF,
      });
    }
  }

  return result;
}

/**
 * Match a TextRun (from the interpreter) to the corresponding
 * text instruction in the content stream.
 *
 * We match based on font name and approximate text content.
 */
function matchTextRunToInstruction(
  run: TextRun,
  textInstructions: TextInstruction[],
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): TextInstruction | null {
  // Helper: check if font names are compatible
  const fontsMatch = (tiFontName: string, runFontName: string): boolean => {
    if (runFontName === '' || tiFontName === '') return true;
    if (tiFontName === runFontName) return true;
    return false;
  };

  // 1) Try exact or trimmed match first
  for (const ti of textInstructions) {
    if (!fontsMatch(ti.fontName, run.fontName)) continue;

    const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
    if (decoded === null) continue;

    if (decoded === run.text || decoded.trim() === run.text.trim()) {
      return ti;
    }
  }

  // 2) Try whitespace-insensitive match
  const runClean = run.text.replace(/\s+/g, '');
  if (runClean.length > 0) {
    for (const ti of textInstructions) {
      if (!fontsMatch(ti.fontName, run.fontName)) continue;

      const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
      if (decoded === null) continue;

      const decClean = decoded.replace(/\s+/g, '');
      if (decClean === runClean) {
        return ti;
      }
    }
  }

  // 3) Try substring match ONLY if decoded instruction contains the run text (e.g. multi-line TJ array)
  // NEVER check if run.text.includes(decoded), as short/single-character instructions would falsely match!
  for (const ti of textInstructions) {
    if (!fontsMatch(ti.fontName, run.fontName)) continue;

    const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
    if (decoded === null) continue;

    if (decoded.includes(run.text) && run.text.trim().length > 1) {
      return ti;
    }
  }

  // 4) Normalized comparison — strip all non-alphanumeric characters and compare
  const runNorm = run.text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (runNorm.length > 2) {
    for (const ti of textInstructions) {
      if (!fontsMatch(ti.fontName, run.fontName)) continue;

      const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
      if (decoded === null) continue;

      const decNorm = decoded.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (decNorm === runNorm) {
        return ti;
      }
    }
  }

  // 5) For single/short text (brackets, special chars, bullet points), try
  //    matching by font name alone when there's a single instruction with that font
  //    that produces similar-length text
  if (run.text.trim().length <= 2 && run.text.trim().length > 0) {
    const candidates = textInstructions.filter(ti => {
      if (!fontsMatch(ti.fontName, run.fontName)) return false;
      const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
      if (decoded === null) return false;
      return decoded.trim().length <= 3 && decoded.trim().length > 0;
    });
    // If exactly one candidate, return it
    if (candidates.length === 1) {
      return candidates[0];
    }
  }

  return null;
}

function decodeInstructionText(
  instruction: CSInstruction,
  fontName: string,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): string | null {
  const op = instruction.operator;
  const ops = instruction.operands;

  if (op === 'Tj') {
    return extractStringText(ops[0], fontName, page, objects);
  }

  if (op === 'TJ') {
    const arr = ops[0];
    if (!(arr instanceof PDFArray)) return null;

    let text = '';
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i)!;
      if (item instanceof PDFString || item instanceof PDFHexString) {
        text += extractStringText(item, fontName, page, objects) ?? '';
      }
      // Numbers are spacing adjustments — skip
    }
    return text;
  }

  if (op === "'") {
    return extractStringText(ops[0], fontName, page, objects);
  }

  if (op === '"') {
    return extractStringText(ops[2], fontName, page, objects);
  }

  return null;
}

function extractStringText(
  obj: PDFObject | undefined,
  fontName: string,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): string | null {
  if (!obj) return null;

  let bytes: Uint8Array;
  if (obj instanceof PDFString) {
    bytes = obj.toBytes();
  } else if (obj instanceof PDFHexString) {
    bytes = obj.toBytes();
  } else {
    return null;
  }

  // Load font data for decoding
  const fontData = loadFontForName(fontName, page, objects);
  if (!fontData) {
    // Fallback: decode as Latin-1
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  // Decode using font's ToUnicode map
  let text = '';
  const isComposite = fontData.isComposite;
  let idx = 0;

  while (idx < bytes.length) {
    const length = isComposite ? getCharCodeLength(bytes, idx, fontData.codeSpaceRanges) : 1;
    const charCode = readCharCode(bytes, idx, length);
    idx += length;
    text += charCodeToUnicode(charCode, fontData, length);
  }

  return text;
}

// ─── Text encoding ──────────────────────────────────────────────────────────

export interface EncodedText {
  pdfString: PDFString | PDFHexString;
  /** Unicode characters that couldn't be encoded */
  missing: number[];
}

/**
 * Encode a Unicode string into PDF text using the font's encoding.
 * This is the reverse of text extraction — Unicode → character codes.
 */
export function encodeTextForFont(text: string, fontData: FontData | null): EncodedText {
  if (!fontData) {
    return encodeTextWinAnsi(text);
  }

  const missing: number[] = [];

  if (fontData.isComposite) {
    const reverse = new Map<string, string>();
    const ranges = fontData.codeSpaceRanges;
    const addCode = (unicode: string, code: number, sourceLength?: number) => {
      const length = sourceLength && ranges?.length ? sourceLength
        : getCodeBytes(code, fontData, 2);
      if (ranges?.length && !isCodeInCodeSpace(code, length, ranges)) return;
      if (ranges?.length) {
        for (let prefixLength = 1; prefixLength < length; prefixLength++) {
          const prefix = Math.floor(code / 256 ** (length - prefixLength));
          if (isCodeInCodeSpace(prefix, prefixLength, ranges)) return;
        }
      }
      const cid = fontData.encodingCMap?.toCIDByLength.get(length)?.get(code) ?? fontData.toCID?.get(code) ?? code;
      if (cid === 0) return;
      const hexCode = code.toString(16).padStart(length * 2, '0');
      if (hexCode.length !== length * 2) return;
      reverse.set(unicode, hexCode);
    };
    if (fontData.unicodeCMap) {
      for (const [length, mappings] of fontData.unicodeCMap.toUnicodeByLength) {
        for (const [code, unicode] of mappings) addCode(unicode, code, length);
      }
    } else {
      for (const [unicode, code] of buildReverseUnicodeMap(fontData)) addCode(unicode, code);
    }
    let hex = '';
    for (const char of text) {
      const code = reverse.get(char);
      if (code !== undefined) {
        hex += code;
      } else {
        missing.push(char.codePointAt(0)!);
        // Callers replace missing characters through the existing fallback path.
        hex += '0000';
      }
    }

    return {
      pdfString: new PDFHexString(hex),
      missing,
    };
  } else {
    // Simple font: use encoding differences or direct mapping
    const reverseMap = buildReverseUnicodeMap(fontData);
    let result = '';

    for (const char of text) {
      const code = reverseMap.get(char);
      if (code !== undefined && code !== 0) {
        result += String.fromCharCode(code & 0xff);
      } else {
        const cp = char.codePointAt(0)!;
        // Subset fonts often omit `.` / digits from ToUnicode — mark missing so we
        // fall back to Helvetica instead of writing `?` or invisible glyphs.
        if (fontData.toUnicode.size > 0) {
          missing.push(cp);
          result += '?';
        } else if (cp < 256) {
          result += char;
        } else {
          missing.push(cp);
          result += '?';
        }
      }
    }

    return {
      pdfString: new PDFString(result),
      missing,
    };
  }
}

/** True for bullet / list-marker code points (and dingbat PUA stand-ins). */
function isBulletLike(cp: number): boolean {
  return (
    cp === 0x2022 || cp === 0x2023 || cp === 0x2043 || cp === 0x2219
    || cp === 0x25cf || cp === 0x25cb || cp === 0x25e6 || cp === 0x25aa
    || cp === 0x25ab || cp === 0x00b7 || cp === 0x2024 || cp === 0xfe61
    || cp === 0xff65 || (cp >= 0xf000 && cp <= 0xf0ff)
  );
}

// Retain the existing punctuation substitutions; only unsupported placeholders are rejected.
const WIN_ANSI_SUBSTITUTIONS: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"',
  0x2013: '-', 0x2014: '-', 0x2026: '...',
};

/** WinAnsi / Latin-1 encode for Helvetica fallback — keeps `.` `a-z` etc. intact. */
export function encodeTextWinAnsi(text: string): EncodedText {
  const missing: number[] = [];
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++; // skip trailing surrogate
    }
    if (isBulletLike(cp)) {
      // WinAnsiEncoding 0x95 = • — never substitute ASCII hyphen (turns list
      // bullets into "-" whenever a run falls back to Helvetica).
      result += String.fromCharCode(0x95);
      continue;
    }
    if (cp <= 0xff) {
      result += String.fromCharCode(cp);
    } else {
      missing.push(cp);
      result += WIN_ANSI_SUBSTITUTIONS[cp] ?? '?';
    }
  }
  return { pdfString: new PDFString(result), missing };
}

function unsupportedFallbackCodePoints(
  text: string,
  fontData: FontData | null,
  encoded: EncodedText,
  allowBuiltInFallback = true,
): number[] {
  // Complex scripts always need shaping, even when an existing font has a Unicode encoder.
  const forced = Array.from(text).filter(ch =>
    /[\u0900-\u0d7f\u0e00-\u0e7f\u200c\u200d\u25cc\p{Script=Arabic}\p{Script=Hebrew}\p{Extended_Pictographic}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(ch));
  if (!isEncodingLossy(text, encoded, fontData)) return forced.map(ch => ch.codePointAt(0)!);
  return Array.from(text).flatMap(ch => {
    const encoding = encodeTextForFont(ch, fontData);
    if (!forced.includes(ch) && !isEncodingLossy(ch, encoding, fontData)) return [];
    if (forced.includes(ch)) return [ch.codePointAt(0)!];
    return encodeTextWinAnsi(ch).missing.filter(cp =>
      WIN_ANSI_SUBSTITUTIONS[cp] === undefined &&
      (!allowBuiltInFallback || getBuiltInFallbackGlyph(ch) === null));
  });
}

/**
 * Preflight a text commit without modifying page resources or editor state.
 * Built-in Symbol/Dingbats are allowed only when the caller emits split fallback runs.
 */
export function assertTextEncodable(
  text: string,
  fontData: FontData | null = null,
  allowBuiltInFallback = true,
  objects?: Map<string, PDFObject>,
): void {
  const unsupported = unsupportedFallbackCodePoints(
    text, fontData, encodeTextForFont(text, fontData), allowBuiltInFallback,
  );
  const unavailable = objects ? unsupported.filter(cp => !hasUnicodeGlyph(objects, cp)) : unsupported;
  if (unavailable.length > 0) throw new UnsupportedGlyphsError(unavailable);
  if (objects && unsupported.length) {
    for (const part of unicodeTextRuns(objects, text, new Set(unsupported), scriptFontId(fontData?.baseFont ?? ''))) {
      if (isShapingFont(part.fontId)) preparedShapedClusters(objects, part.text, part.fontId);
    }
  }
}

/** Async coverage/subset stage shared by floating boxes and existing-run commits. */
export async function prepareTextForExport(
  objects: Map<string, PDFObject>,
  runs: readonly { text: string; fontData?: FontData | null }[],
  source?: UnicodeFontSources,
  options?: ScriptFontOptions,
): Promise<void> {
  const missing = runs.map(({ text, fontData }) => {
    const id = fontData && scriptFontId(fontData.baseFont);
    return {
      text, codePoints: unsupportedFallbackCodePoints(text, fontData ?? null, encodeTextForFont(text, fontData ?? null)),
      preferredHanFont: id && ['sc', 'tc', 'jp', 'kr'].includes(id) ? id as ScriptFontOptions['preferredHanFont'] : undefined,
    };
  });
  await prepareUnicodeText(objects, missing, source, options);
}

/** Exact font advances for lines using the prepared Unicode fallback; other lines retain their estimator. */
export function measureUnicodeExportText(
  text: string, run: TextRun, page: PDFPageInfo, objects: Map<string, PDFObject>,
  overrides?: readonly { start: number; end: number; fontSize: number }[], lineStart = 0,
): number | undefined {
  const unicodeCharacters = Array.from(text).filter(ch => ch.codePointAt(0)! > 255);
  if (!unicodeCharacters.length) return undefined;
  const font = loadFontForName(run.fontName, page, objects);
  if (!scriptFontId(font?.baseFont ?? '') &&
      !unicodeCharacters.some(ch => hasUnicodeGlyph(objects, ch.codePointAt(0)!))) return undefined;
  const flags = resolveRunStyleFlags(run.fontName, font);
  const fallbackName = flags.bold && flags.italic ? 'Helvetica-BoldOblique'
    : flags.bold ? 'Helvetica-Bold' : flags.italic ? 'Helvetica-Oblique' : 'Helvetica';
  const visualSize = runFontSize(run);
  let width = 0, position = lineStart;
  const needed = new Set(unsupportedFallbackCodePoints(text, font, encodeTextForFont(text, font)));
  const selected = needed.size ? unicodeTextRuns(objects, text, needed, scriptFontId(font?.baseFont ?? ''))
    : [{ fontId: 'latin' as const, text }];
  for (const { fontId, text: part } of selected) {
    if (isShapingFont(fontId)) {
      const size = overrides?.find(range => position >= range.start && position < range.end)?.fontSize ?? visualSize;
      width += shapedTextWidth(objects, part, fontId) * size / 1000;
      position += part.length;
      continue;
    }
    for (const ch of part) {
      const cp = ch.codePointAt(0)!, encoded = encodeTextForFont(ch, font);
      let advance: number;
      if (!isEncodingLossy(ch, encoded, font)) {
        const bytes = encoded.pdfString.toBytes();
        const length = font?.isComposite ? getCharCodeLength(bytes, 0, font.codeSpaceRanges) : 1;
        const code = readCharCode(bytes, 0, length);
        const cid = font?.encodingCMap?.toCIDByLength.get(length)?.get(code) ?? font?.toCID?.get(code) ?? code;
        advance = font?.widths.get(cid) ?? font?.defaultWidth ?? getStandardFontCharWidth('Helvetica', code);
      } else if (unsupportedFallbackCodePoints(ch, font, encoded).length) {
        advance = unicodeGlyphWidth(objects, cp, fontId);
      } else {
        const special = getBuiltInFallbackGlyph(ch);
        advance = special ? getStandardFontCharWidth(special.fontKind, special.code)
          : getStandardFontCharWidth(fallbackName, encodeTextWinAnsi(ch).pdfString.toBytes()[0]);
      }
      const size = overrides?.find(range => position >= range.start && position < range.end)?.fontSize ?? visualSize;
      width += advance * size / 1000;
      position += ch.length;
    }
  }
  return width;
}

function splitExportRuns(
  text: string, originalFont: string, fontData: FontData | null,
  page: PDFPageInfo, objects: Map<string, PDFObject>,
): { fontKey: string; operand: PDFObject }[] {
  const needed = new Set(unsupportedFallbackCodePoints(text, fontData, encodeTextForFont(text, fontData)));
  const selected = needed.size ? unicodeTextRuns(objects, text, needed, scriptFontId(fontData?.baseFont ?? ''))
    : [{ fontId: 'latin' as const, text }];
  for (const part of selected) {
    if (Array.from(part.text).some(ch => needed.has(ch.codePointAt(0)!))) ensureUnicodeFont(page, objects, part.fontId);
  }
  if (!needed.size && fontData) {
    // A reopened Unicode font can already cover the non-Latin run. Preserve its
    // inherited resources when adding a Standard 14 font for the Latin run.
    const effective = resolvePageResources(page.dict, objects);
    const resources = new PDFDict([...effective.entries()]);
    const fonts = effective.get('Font');
    const resolved = fonts ? resolveRef(fonts, objects) : undefined;
    resources.set('Font', new PDFDict(resolved instanceof PDFDict ? [...resolved.entries()] : []));
    page.dict.set('Resources', resources); page.resources = resources;
  }
  const groups: { fontKey: string; text: string; fontId: ScriptFontId; kind: 'original' | 'latin' | 'unicode' | 'symbol' }[] = [];
  for (const { fontId, text: part } of selected) for (const ch of part) {
    const encoded = encodeTextForFont(ch, fontData);
    let fontKey = originalFont, kind: 'original' | 'latin' | 'unicode' | 'symbol' = 'original', value = ch;
    if (isEncodingLossy(ch, encoded, fontData)) {
      if (unsupportedFallbackCodePoints(ch, fontData, encoded).length) {
        fontKey = ensureUnicodeFont(page, objects, fontId); kind = 'unicode';
      } else {
        const special = getBuiltInFallbackGlyph(ch);
        if (special) {
          fontKey = ensureBuiltInFallbackFont(page, objects, special.fontKind);
          value = String.fromCharCode(special.code); kind = 'symbol';
        } else {
          fontKey = ensureFallbackFont(page, objects, resolveRunStyleFlags(originalFont, fontData)); kind = 'latin';
        }
      }
    }
    const previous = groups[groups.length - 1];
    if (previous?.fontKey === fontKey && previous.kind === kind) previous.text += value;
    else groups.push({ fontKey, kind, text: value, fontId });
  }
  return groups.map(group => ({
    fontKey: group.fontKey,
    operand: group.kind === 'unicode' ? encodeUnicodeText(objects, group.text, group.fontId)
      : group.kind === 'symbol' ? new PDFString(group.text)
      : group.kind === 'latin' ? encodeTextWinAnsi(group.text).pdfString
      : encodeTextForFont(group.text, fontData).pdfString,
  }));
}

function exportShowingInstructions(
  text: string, originalFont: string, fontData: FontData | null,
  page: PDFPageInfo, objects: Map<string, PDFObject>, size: number, rise = 0,
): CSInstruction[] {
  const parts = unicodeTextRuns(objects, text, new Set(unsupportedFallbackCodePoints(text, fontData, encodeTextForFont(text, fontData))),
    scriptFontId(fontData?.baseFont ?? ''));
  const ops: CSInstruction[] = [];
  for (const part of parts) {
    if (isShapingFont(part.fontId)) {
      const fontKey = ensureUnicodeFont(page, objects, part.fontId);
      ops.push({ operator: 'Tf', operands: [new PDFName(fontKey), new PDFNumber(size)], offset: 0 },
        { operator: 'q', operands: [], offset: 0 },
        { operator: 'Tc', operands: [new PDFNumber(0)], offset: 0 },
        { operator: 'Tw', operands: [new PDFNumber(0)], offset: 0 },
        ...emitShapedText(objects, part.text, part.fontId, size, rise),
        { operator: 'Q', operands: [], offset: 0 });
    } else {
      for (const run of splitExportRuns(part.text, originalFont, fontData, page, objects)) {
        ops.push({ operator: 'Tf', operands: [new PDFName(run.fontKey), new PDFNumber(size)], offset: 0 },
          { operator: 'Tj', operands: [run.operand], offset: 0 });
      }
    }
  }
  return ops;
}

function serializeToStringInstructions(instructions: CSInstruction[]): string {
  return new TextDecoder().decode(serializeInstructions(instructions, serializeToString));
}

function applyUnicodeShowing(
  instructions: CSInstruction[], textIndex: number, text: string, originalFont: string,
  fontData: FontData | null, page: PDFPageInfo, objects: Map<string, PDFObject>, fontSize: number,
): number {
  let previousFont = originalFont.replace(/^\//, ''), size = fontSize;
  for (let i = textIndex - 1; i >= 0; i--) {
    const inst = instructions[i];
    if (inst.operator === 'BT') break;
    if (inst.operator === 'Tf') {
      if (inst.operands[0] instanceof PDFName) previousFont = inst.operands[0].name;
      if (inst.operands[1] instanceof PDFNumber) size = inst.operands[1].value;
      break;
    }
  }
  const original = instructions[textIndex], ops: CSInstruction[] = [];
  if (original.operator === '"') {
    ops.push({ operator: 'Tw', operands: [original.operands[0]], offset: original.offset },
      { operator: 'Tc', operands: [original.operands[1]], offset: original.offset });
  }
  if (original.operator === "'" || original.operator === '"') ops.push({ operator: 'T*', operands: [], offset: original.offset });
  let rise = 0;
  for (let i = textIndex - 1; i >= 0; i--) {
    if (instructions[i].operator === 'Ts') { rise = (instructions[i].operands[0] as PDFNumber).value; break; }
  }
  ops.push(...exportShowingInstructions(text, originalFont, fontData, page, objects, size, rise));
  ops.push({ operator: 'Tf', operands: [new PDFName(previousFont), new PDFNumber(size)], offset: 0 });
  instructions.splice(textIndex, 1, ...ops);
  return ops.length - 1;
}

/** True when encoding dropped/replaced glyphs the user typed (causes missing text / `?`). */
function isEncodingLossy(
  text: string,
  encoded: EncodedText,
  fontData: FontData | null,
): boolean {
  if (!text) return false;
  if (encoded.missing.length > 0) return true;
  if (!fontData) return false;

  if (encoded.pdfString instanceof PDFString) {
    const out = encoded.pdfString.value;
    const n = Math.min(text.length, out.length);
    for (let i = 0; i < n; i++) {
      if (text[i] !== '?' && out[i] === '?') return true;
    }
    if (out.length !== text.length) return true;

    // Type3 fonts use custom CharProcs. ASCII identity fallback in
    // buildReverseUnicodeMap can "succeed" while mapping to .notdef (g0),
    // which renders as a solid bar and must force Helvetica fallback.
    const isType3 = !!(fontData.charProcs && fontData.charProcs.size > 0);
    if (isType3) {
      let g0Hits = 0;
      for (let i = 0; i < out.length; i++) {
        const code = out.charCodeAt(i) & 0xff;
        const name = fontData.differences.get(code);
        if (name === 'g0' || (name != null && !fontData.charProcs!.has(name))) g0Hits++;
        else if (name == null && fontData.toUnicode.size > 0 && !fontData.toUnicode.has(code)) g0Hits++;
      }
      if (g0Hits > 0) return true;
    }
  }

  return false;
}

/** Insert ` /Font size Tf ` before a text-showing op. Returns number of ops inserted. */
function insertFontSwitchBefore(
  instructions: CSInstruction[],
  textIndex: number,
  fontKey: string,
  visualSize: number,
): number {
  if (textIndex < 0 || textIndex >= instructions.length) return 0;

  // Prefer the existing Tf size. Resumes often use `1 Tf` + scaled Tm — if we
  // inject absolute visual size while Tm still scales, text becomes huge.
  let size = Number.isFinite(visualSize) && visualSize > 0 ? visualSize : 12;
  for (let i = textIndex - 1; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      const cur = instructions[i].operands[1];
      if (cur instanceof PDFNumber && cur.value > 0) {
        size = cur.value;
      }
      break;
    }
  }

  instructions.splice(textIndex, 0, {
    operator: 'Tf',
    operands: [new PDFName(fontKey), new PDFNumber(size)],
    offset: 0,
  });
  return 1;
}

/**
 * Switch to a fallback font for one text-showing op, then restore the previous
 * font so later glyphs in the same BT block (common with Type3 per-letter fonts)
 * are not drawn with WinAnsi codes under Helvetica (e.g. Type3 E @ 0x48 → "H").
 * Returns number of ops inserted.
 */
function insertFallbackFontAround(
  instructions: CSInstruction[],
  textIndex: number,
  fallbackFont: string,
  visualSize: number,
): number {
  if (textIndex < 0 || textIndex >= instructions.length) return 0;

  let size = Number.isFinite(visualSize) && visualSize > 0 ? visualSize : 12;
  let prevFont: string | null = null;
  for (let i = textIndex - 1; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      const nameOp = instructions[i].operands[0];
      const sizeOp = instructions[i].operands[1];
      if (nameOp instanceof PDFName) prevFont = nameOp.name;
      if (sizeOp instanceof PDFNumber && sizeOp.value > 0) size = sizeOp.value;
      break;
    }
  }

  instructions.splice(textIndex, 0, {
    operator: 'Tf',
    operands: [new PDFName(fallbackFont), new PDFNumber(size)],
    offset: 0,
  });
  let inserted = 1;

  // text showing op is now at textIndex + 1; restore after it
  if (prevFont && prevFont !== fallbackFont) {
    instructions.splice(textIndex + 2, 0, {
      operator: 'Tf',
      operands: [new PDFName(prevFont), new PDFNumber(size)],
      offset: 0,
    });
    inserted += 1;
  }
  return inserted;
}

/** Replace one text-showing operation with adjacent WinAnsi/Symbol/Dingbats runs. */
function applySpecialFallbackShowing(
  instructions: CSInstruction[],
  textIndex: number,
  text: string,
  fallbackFont: string,
  originalFont: string,
  visualSize: number,
): number {
  let size = Number.isFinite(visualSize) && visualSize > 0 ? visualSize : 12;
  let previousFont = originalFont.replace(/^\//, '');
  for (let i = textIndex - 1; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      const name = instructions[i].operands[0];
      const tfSize = instructions[i].operands[1];
      if (name instanceof PDFName) previousFont = name.name;
      if (tfSize instanceof PDFNumber && tfSize.value > 0) size = tfSize.value;
      break;
    }
  }

  const original = instructions[textIndex];
  const ops: CSInstruction[] = [];
  if (original.operator === '"') {
    ops.push(
      { operator: 'Tw', operands: [original.operands[0]], offset: original.offset },
      { operator: 'Tc', operands: [original.operands[1]], offset: original.offset },
    );
  }
  if (original.operator === "'" || original.operator === '"') {
    ops.push({ operator: 'T*', operands: [], offset: original.offset });
  }
  let normal = '';
  const flushNormal = () => {
    if (!normal) return;
    ops.push({ operator: 'Tf', operands: [new PDFName(fallbackFont), new PDFNumber(size)], offset: 0 });
    ops.push({ operator: 'Tj', operands: [encodeTextWinAnsi(normal).pdfString], offset: 0 });
    normal = '';
  };
  for (const ch of Array.from(text)) {
    const glyph = getBuiltInFallbackGlyph(ch);
    if (!glyph) {
      normal += ch;
      continue;
    }
    flushNormal();
    const resource = glyph.fontKind === 'Symbol' ? 'SymAug' : 'DingAug';
    ops.push({ operator: 'Tf', operands: [new PDFName(resource), new PDFNumber(size)], offset: 0 });
    ops.push({ operator: 'Tj', operands: [new PDFString(String.fromCharCode(glyph.code))], offset: 0 });
  }
  flushNormal();
  ops.push({ operator: 'Tf', operands: [new PDFName(previousFont), new PDFNumber(size)], offset: 0 });
  instructions.splice(textIndex, 1, ...ops);
  return ops.length - 1;
}

function buildReverseUnicodeMap(fontData: FontData): Map<string, number> {
  const reverse = new Map<string, number>();

  // ToUnicode entries take priority
  const entries = Array.from(fontData.toUnicode.entries());
  for (let i = 0; i < entries.length; i++) {
    const [code, unicode] = entries[i];
    reverse.set(unicode, code);
  }

  // Also add encoding differences
  const diffEntries = Array.from(fontData.differences.entries());
  for (let i = 0; i < diffEntries.length; i++) {
    const [code, glyphName] = diffEntries[i];
    // Simple: if the glyph name is a single character, map it
    if (glyphName.length === 1) {
      reverse.set(glyphName, code);
    }
  }

  // For simple fonts, add standard ASCII mapping — but NOT for Type3.
  // Type3 Differences often map ASCII codes to .notdef (g0); inventing
  // identity mappings makes encode look successful while drawing solid bars.
  const isType3 = !!(fontData.charProcs && fontData.charProcs.size > 0);
  // Embedded SUBSETS only carry glyphs for characters the source used, so an
  // identity guess for anything else draws .notdef (an empty box).
  const isSubset = /^[A-Z]{6}\+/.test(fontData.baseFont || '') && fontData.toUnicode.size > 0;
  if (!fontData.isComposite && !isType3) {
    for (let i = 0x20; i <= 0x7e; i++) {
      const char = String.fromCharCode(i);
      if (isSubset && i !== 0x20) continue;
      if (!reverse.has(char)) {
        reverse.set(char, i);
      }
    }
  }

  return reverse;
}

// ─── Text region erase ────────────────────────────────────────────────────────

function isTextShowingOperator(op: string): boolean {
  return op === 'Tj' || op === 'TJ' || op === "'" || op === '"';
}

/**
 * Retain the legacy white erase only when original text operators cannot all
 * be rewritten. Complete rewrites remove old glyph operands without painting.
 */
function insertEraseRectForRun(
  instructions: CSInstruction[],
  run: TextRun,
  hintIndex: number,
): number {
  if (hintIndex < 0 || hintIndex >= instructions.length) return 0;

  // Limit this incomplete-rewrite fallback to the original run bounds.
  let btIndex = hintIndex;
  for (let i = hintIndex; i >= 0; i--) {
    if (instructions[i].operator === 'BT') {
      btIndex = i;
      break;
    }
    if (instructions[i].operator === 'ET') break;
  }

  const fontSize = run.fontSize || run.glyphs[0]?.fontSize || 12;
  const pad = Math.max(1, fontSize * 0.08);
  // Cover ONLY the original run bounds (baseline-relative)
  const eraseWidth = Math.max(run.width, fontSize * 0.5) + pad * 2;
  const ascent = fontSize * 0.85;
  const descent = fontSize * 0.25;
  const eraseHeight = ascent + descent + pad * 2;
  const eraseX = run.x - pad;
  const eraseY = run.y - descent - pad;

  // run.x/y are page-space; undo any base CTM (e.g. Firefox's top-level flip).
  const inv = invertMatrix(ctmBefore(instructions, btIndex));
  const toBase: CSInstruction[] =
    inv && inv.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-9)
      ? [{ operator: 'cm', operands: inv.map((v) => new PDFNumber(v)), offset: 0 }]
      : [];
  const eraseOps: CSInstruction[] = [
    { operator: 'q', operands: [], offset: 0 },
    ...toBase,
    { operator: 'rg', operands: [new PDFNumber(1), new PDFNumber(1), new PDFNumber(1)], offset: 0 },
    {
      operator: 're',
      operands: [
        new PDFNumber(eraseX),
        new PDFNumber(eraseY),
        new PDFNumber(eraseWidth),
        new PDFNumber(eraseHeight),
      ],
      offset: 0,
    },
    { operator: 'f', operands: [], offset: 0 },
    { operator: 'Q', operands: [], offset: 0 },
  ];

  instructions.splice(btIndex, 0, ...eraseOps);
  return eraseOps.length;
}

// ─── Grouped text edit (multi-instruction spans) ────────────────────────────

/**
 * Replace text for a run that spans multiple Tj/TJ instructions.
 *
 * Important: put the FULL new string on the first text-showing op and clear
 * siblings. Proportional splits left undecoded/old fragments in place and
 * produced doubled/interleaved text (e.g. "PRxxxOFESSIONAL EXPERIENCEfgOFESSIONAL…").
 *
 * @returns number of instructions inserted (font switch)
 */
function applyGroupedTextEdit(
  instructions: CSInstruction[],
  sourceIndices: number[],
  newText: string,
  encoded: EncodedText,
  fallbackFont: string | null,
  run: TextRun,
  fontData: FontData | null,
  unicode?: { page: PDFPageInfo; objects: Map<string, PDFObject> },
): number {
  const sortedIndices = Array.from(new Set(sourceIndices)).sort((a, b) => a - b);
  let primaryIdx = -1;
  for (let i = 0; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    const inst = instructions[idx];
    if (inst && isTextShowingOperator(inst.operator)) {
      primaryIdx = idx;
      break;
    }
  }
  if (primaryIdx < 0) return 0;

  const empty = new PDFString('');
  const primary = instructions[primaryIdx];

  for (let i = 0; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    if (idx === primaryIdx) continue;
    const inst = instructions[idx];
    if (!inst || !isTextShowingOperator(inst.operator)) continue;
    if (inst.operator === 'TJ') {
      inst.operands = [new PDFArray([empty])];
    } else if (inst.operator === '"') {
      inst.operands = [...inst.operands.slice(0, 2), empty];
    } else {
      inst.operands = [empty];
    }
  }
  if (unicode) {
    return applyUnicodeShowing(instructions, primaryIdx, newText, run.fontName,
      fontData, unicode.page, unicode.objects, run.fontSize);
  }

  if (fallbackFont && Array.from(newText).some(ch => getBuiltInFallbackGlyph(ch) !== null)) {
    return applySpecialFallbackShowing(
      instructions, primaryIdx, newText, fallbackFont, run.fontName, runFontSize(run),
    );
  }
  applyEncodedShowingOperands(primary, newText, encoded, fontData, !!fallbackFont);
  if (fallbackFont) {
    return insertFallbackFontAround(
      instructions,
      primaryIdx,
      fallbackFont,
      runFontSize(run),
    );
  }
  return 0;
}

/**
 * Edit a TJ array without destroying large position adjustments.
 *
 * Firefox/cairo print-to-PDF puts whole table rows into one TJ, using huge
 * negative numbers (e.g. -6462) as column gaps. Rebuilding the array from the
 * plain text drops them and collapses the columns. This keeps every original
 * string/number outside the changed span (common prefix/suffix diff) and only
 * re-encodes the changed middle.
 *
 * Returns null (caller falls back to the normal rebuild) unless the array has
 * only plain strings whose characters line up 1:1 with the run text.
 */
export function patchTJPreservingGaps(
  oldArr: PDFArray,
  oldText: string,
  newText: string,
  fontData: FontData | null,
  /** Advance of one character in text-space em (1 = font size); enables gap compensation. */
  emWidth?: (ch: string) => number,
): PDFArray | null {
  // Firefox/cairo commonly uses about -350 for a 0.35-em word gap, below the
  // column-gutter threshold. Keep those adjustments eligible for compensation
  // too, so a width change before the gap cannot erase the visual word space.
  const GAP_ADJUST = 200;
  let total = 0;
  for (const it of oldArr.items) {
    if (it instanceof PDFNumber) {
      continue;
    } else if (it instanceof PDFString) {
      total += it.value.length;
    } else {
      return null;
    }
  }
  if (total !== oldText.length) return null;

  const minLen = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < minLen && oldText[p] === newText[p]) p++;
  let sfx = 0;
  while (sfx < minLen - p && oldText[oldText.length - 1 - sfx] === newText[newText.length - 1 - sfx]) sfx++;
  const oldEnd = oldText.length - sfx;
  const newMid = newText.slice(p, newText.length - sfx);

  // Relative gaps would carry the width change into every later column, so
  // take it back out of the first large gap after the edit (thousandths of em).
  const newItems = newMid ? buildTJWithSpaceAdvances(newMid, fontData, false).items : [];
  let newAdv = 0;
  let oldAdv = 0;
  if (emWidth) {
    for (const ch of newMid) newAdv += emWidth(ch);
    for (const ch of oldText.slice(p, oldEnd)) oldAdv += emWidth(ch);
  }
  for (const it of newItems) if (it instanceof PDFNumber) newAdv -= it.value / 1000;
  let compensated = false;

  const out: PDFObject[] = [];
  let inserted = false;
  const insert = () => {
    if (inserted) return;
    inserted = true;
    out.push(...newItems);
  };

  let pos = 0;
  for (const it of oldArr.items) {
    if (it instanceof PDFNumber) {
      const afterEdit = pos >= oldEnd && (pos > p || p === oldEnd);
      if (pos <= p && !afterEdit) out.push(it);
      else if (!afterEdit) oldAdv -= it.value / 1000;
      else if (afterEdit) {
        insert();
        const compensate = emWidth ? Math.round((newAdv - oldAdv) * 1000) : 0;
        if (!compensated && compensate !== 0 && Math.abs(it.value) >= GAP_ADJUST) {
          compensated = true;
          const next = it.value + compensate;
          out.push(new PDFNumber(next));
        } else {
          out.push(it);
        }
      }
      continue;
    }
    const str = (it as PDFString).value;
    const len = str.length;
    if (pos < p) out.push(new PDFString(str.slice(0, Math.min(len, p - pos))));
    if (pos + len >= p) insert();
    if (pos + len > oldEnd) out.push(new PDFString(str.slice(Math.max(0, oldEnd - pos))));
    pos += len;
  }
  insert();
  return new PDFArray(out);
}

/** Per-character advance (text-space em) measured from an interpreted run. */
function runEmWidth(run: TextRun, fontData: FontData | null): (ch: string) => number {
  const byChar = new Map<string, number>();
  let sum = 0;
  let n = 0;
  for (const g of run.glyphs) {
    if (g.unicode && g.textSpaceWidth > 0 && !byChar.has(g.unicode)) byChar.set(g.unicode, g.textSpaceWidth);
    if (g.textSpaceWidth > 0) { sum += g.textSpaceWidth; n++; }
  }
  const avg = n > 0 ? sum / n : 0.5;
  return (ch: string) => {
    const seen = byChar.get(ch);
    if (seen !== undefined) return seen;
    // Unseen character: use the font's own width for its code when known.
    try {
      const ps = encodeTextForFont(ch, fontData).pdfString;
      const w = ps instanceof PDFString ? fontData?.widths?.get(ps.value.charCodeAt(0)) : undefined;
      if (w && w > 0) return w / 1000;
    } catch { /* fall through */ }
    return avg;
  };
}

/** Em-fraction per Space via TJ (negative number → next glyph moves right). */
export const SPACE_TJ_EM = 0.28;
/**
 * Safety ceiling only — the old cap of 3 clipped intentional multi-space gaps
 * so glyphs after the spaces stayed left and overlapped the next run.
 */
export const SPACE_TJ_MAX_CHARS = 64;

/**
 * Extra TJ (thousandths of em) needed beyond the font's native Space advance
 * so total ≈ SPACE_TJ_EM. Subset fonts often have ~0 Space width; Standard 14
 * Helvetica Space is already ~278 — adding a full 0.28em TJ on top doubles gaps.
 */
export function spaceSupplementalTJ(
  fontData: FontData | null,
  useWinAnsi: boolean,
): number {
  const desired = Math.round(SPACE_TJ_EM * 1000);
  const glyphW = fontData?.widths?.get(32)
    ?? fontData?.widths?.get(0x20)
    ?? (useWinAnsi ? 278 : 0);
  return Math.max(0, desired - Math.max(0, glyphW));
}

/**
 * Subset/CID resume fonts often encode Space with ~0 advance. Keep space
 * glyphs (for re-interpret) and add TJ advances so gaps survive commit.
 * Advance length must match layout spaceFloor (0.28em × space count).
 */
export function buildTJWithSpaceAdvances(
  text: string,
  fontData: FontData | null,
  useWinAnsi: boolean,
): PDFArray {
  const items: PDFObject[] = [];
  const parts = text.split(/([ ]+)/);
  const supplemental = spaceSupplementalTJ(fontData, useWinAnsi);
  for (const part of parts) {
    if (!part) continue;
    if (/^ +$/.test(part)) {
      const enc = useWinAnsi ? encodeTextWinAnsi(part) : encodeTextForFont(part, fontData);
      items.push(enc.pdfString);
      if (supplemental > 0) {
        const advChars = Math.min(part.length, SPACE_TJ_MAX_CHARS);
        items.push(new PDFNumber(-Math.round(advChars * supplemental)));
      }
      continue;
    }
    const enc = useWinAnsi ? encodeTextWinAnsi(part) : encodeTextForFont(part, fontData);
    items.push(enc.pdfString);
  }
  if (items.length === 0) {
    const enc = useWinAnsi ? encodeTextWinAnsi(text) : encodeTextForFont(text, fontData);
    items.push(enc.pdfString);
  }
  return new PDFArray(items);
}

function applyEncodedShowingOperands(
  inst: CSInstruction,
  text: string,
  encoded: EncodedText,
  fontData: FontData | null,
  useWinAnsi: boolean,
): void {
  // Quote operators carry line movement and, for ", persistent text spacing.
  // A string-only edit needs no TJ conversion, even when the text has spaces.
  if (inst.operator === "'" || inst.operator === '"') {
    const stringIndex = inst.operator === '"' ? 2 : 0;
    inst.operands = [...inst.operands.slice(0, stringIndex), encoded.pdfString];
    return;
  }
  if (/ /.test(text)) {
    inst.operator = 'TJ';
    inst.operands = [buildTJWithSpaceAdvances(text, fontData, useWinAnsi)];
    return;
  }
  if (inst.operator === 'TJ') {
    inst.operands = [new PDFArray([encoded.pdfString])];
  } else {
    inst.operands = [encoded.pdfString];
  }
}

function findFontNameForInstruction(instructions: CSInstruction[], index: number): string {
  for (let i = index; i >= 0; i--) {
    if (instructions[i].operator === 'Tf') {
      const op = instructions[i].operands[0];
      return op instanceof PDFName ? op.name : '';
    }
  }
  return '';
}

// ─── Smart TJ array building ────────────────────────────────────────────────

/**
 * Build a new TJ array that preserves the spacing pattern from the original.
 * 
 * TJ arrays look like: [(Hello) -80 (World) -120 (!)]
 * The numbers between strings are kerning/spacing adjustments in thousandths
 * of a unit of text space. Destroying these numbers (as the old code did)
 * causes text to render with wrong spacing.
 * 
 * Strategy:
 * - Extract the text fragments and spacing numbers from the old array
 * - If the new text has the same length, apply character-level diff
 * - Otherwise, emit the new text as a single string but inject the average
 *   spacing at word boundaries to maintain readable spacing
 */
function buildSmartTJArray(
  oldArr: PDFArray,
  oldText: string,
  newText: string,
  encodedNewText: PDFObject,
  fontData: FontData | null,
): PDFArray {
  // Collect spacing numbers and their decoded fragment texts
  const fragments: { text: string }[] = [];
  const spacings: number[] = [];

  for (let i = 0; i < oldArr.length; i++) {
    const item = oldArr.get(i)!;
    if (item instanceof PDFNumber) {
      spacings.push(item.value);
    } else if (item instanceof PDFString) {
      fragments.push({ text: item.value });
    } else if (item instanceof PDFHexString) {
      fragments.push({ text: item.hex });
    }
  }

  if (spacings.length === 0 || fragments.length <= 1) {
    return new PDFArray([encodedNewText]);
  }

  // Same-length text: replace fragments in-place, keep all spacing numbers
  if (newText.length === oldText.length && fragments.length === spacings.length + 1) {
    const newItems: PDFObject[] = [];
    let charPos = 0;
    for (let fi = 0; fi < fragments.length; fi++) {
      const fragLen = fragments[fi].text.length;
      const fragText = newText.substring(charPos, charPos + fragLen);
      newItems.push(encodeTextForFont(fragText, fontData).pdfString);
      charPos += fragLen;
      if (fi < spacings.length) {
        newItems.push(new PDFNumber(spacings[fi]));
      }
    }
    return new PDFArray(newItems);
  }

  // Different length: split at word boundaries and distribute spacing proportionally
  const words = newText.split(/(\s+)/);
  if (words.length > 1 && spacings.length > 0) {
    const newItems: PDFObject[] = [];
    const spacingPerGap = spacings.reduce((s, v) => s + v, 0) / spacings.length;
    let wordIdx = 0;

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      if (word.length === 0) continue;
      newItems.push(encodeTextForFont(word, fontData).pdfString);
      if (wi < words.length - 1 && wordIdx < spacings.length) {
        // Use original spacing when available, average otherwise
        newItems.push(new PDFNumber(spacings[wordIdx] ?? spacingPerGap));
        wordIdx++;
      }
    }

    if (newItems.length > 0) {
      return new PDFArray(newItems);
    }
  }

  // Last resort: single string (loses justification but avoids orphan spacing)
  return new PDFArray([encodedNewText]);
}

// ─── Instruction compilation ────────────────────────────────────────────────

/**
 * Compile an array of CSInstructions back into content stream bytes.
 */
export function compileInstructions(instructions: CSInstruction[]): Uint8Array {
  return serializeInstructions(instructions, serializeToString);
}

// ─── Font helpers ───────────────────────────────────────────────────────────

function loadFontForRun(
  run: TextRun,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): FontData | null {
  return loadFontForName(run.fontName, page, objects);
}

export function loadFontForName(
  fontName: string,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): FontData | null {
  const fontDictRef = page.resources.get('Font');
  if (!fontDictRef) return null;

  const fontDict = resolveRef(fontDictRef, objects);
  if (!(fontDict instanceof PDFDict)) return null;

  const fontRef = fontDict.get(fontName);
  if (!fontRef) return null;

  const fontObj = resolveRef(fontRef, objects);
  if (!(fontObj instanceof PDFDict)) return null;

  return loadFont(fontName, fontObj, objects);
}

// ─── Text search (for find-and-replace) ─────────────────────────────────────

/**
 * Find all occurrences of a search string in a page's text.
 * Returns the TextRuns that contain the search text.
 */
export function findTextInPage(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  searchText: string,
  caseSensitive: boolean = false,
): TextRun[] {
  const interpreted = interpretPage(contentBytes, page, objects);
  const results: TextRun[] = [];

  const search = caseSensitive ? searchText : searchText.toLowerCase();

  for (const run of interpreted.textRuns) {
    const text = caseSensitive ? run.text : run.text.toLowerCase();
    if (text.includes(search)) {
      results.push(run);
    }
  }

  return results;
}

/**
 * Find and replace text in a page's content stream.
 */
export function findAndReplace(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  searchText: string,
  replaceText: string,
  caseSensitive: boolean = false,
): EditResult {
  const matchingRuns = findTextInPage(contentBytes, page, objects, searchText, caseSensitive);

  const edits: TextEdit[] = matchingRuns.map((run) => {
    let newText: string;
    if (caseSensitive) {
      newText = run.text.split(searchText).join(replaceText);
    } else {
      // Case-insensitive replace
      const regex = new RegExp(escapeRegex(searchText), 'gi');
      newText = run.text.replace(regex, replaceText);
    }
    return { targetRun: run, newText };
  });

  return applyTextEdits(contentBytes, page, objects, edits);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
