/**
 * Resolve a real flow TextLine for editing (has sourceInstructionIndices).
 * Never commit using synthetic Bloom-only lines.
 */

import type { TextLine } from '@/engine/browser-core';

export function findMatchingFlowLine(
  candidate: TextLine,
  flowLines: TextLine[],
): TextLine | null {
  const byId = flowLines.find(l => l.id === candidate.id);
  if (byId) return byId;

  // Match by baseline + x + similar text
  let best: TextLine | null = null;
  let bestScore = Infinity;
  for (const line of flowLines) {
    const dy = Math.abs(line.baseline - candidate.baseline);
    const dx = Math.abs(line.x - candidate.x);
    if (dy > 8 || dx > 40) continue;
    const score = dy + dx * 0.1;
    if (score < bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best;
}
