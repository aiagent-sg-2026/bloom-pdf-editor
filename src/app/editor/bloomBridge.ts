/**
 * Bridge helpers: Bloom blocks ↔ editor TextLine selection UI.
 */

import type { BloomBlock, BloomPage, TextLine, TextRun } from '@/engine/browser-core';
import { blockPlainText } from '@/engine/browser-core';

/** Build a synthetic TextLine so existing sidebars keep working. */
export function bloomBlockToTextLine(block: BloomBlock): TextLine {
  const text = blockPlainText(block);
  const run0 = block.runs[0];
  const lb = block.lineBoxes[0];
  const fontSize = run0?.fontSize || 12;

  const syntheticRun: TextRun = {
    type: 'text',
    text,
    glyphs: [],
    sourceInstructionIndices: [...block.sourceInstructionIndices],
    x: block.box.x,
    y: lb?.baseline ?? block.box.y,
    width: block.box.width,
    height: block.box.height,
    fontName: run0?.fontName || 'F1',
    fontSize,
    textMatrix: { a: 1, b: 0, c: 0, d: 1, e: block.box.x, f: lb?.baseline ?? block.box.y },
    fillColor: run0?.color ?? [0, 0, 0],
    fillAlpha: 1,
    isUnderline: run0?.underline,
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
  };

  return {
    id: block.id,
    runs: [syntheticRun],
    text,
    segments: [{ run: syntheticRun, startIndex: 0, endIndex: text.length, text }],
    baseline: lb?.baseline ?? block.box.y + fontSize,
    x: block.box.x,
    y: block.box.y,
    width: block.box.width,
    height: block.box.height,
    leftMargin: block.box.x,
    rightEdge: block.box.x + block.box.width,
    fontSize,
    isJustified: block.align === 'justify',
    tabSplitIndex: -1,
  };
}

export function findBlockById(page: BloomPage | null, id: string): BloomBlock | undefined {
  return page?.blocks.find(b => b.id === id);
}
