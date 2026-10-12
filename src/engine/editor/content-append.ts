import { parseContentStream } from '../content/operator-lexer';

/**
 * Prepare an existing page content stream for appending new, page-space content.
 *
 * Cairo/Firefox PDFs start with a top-level `1 0 0 -1 0 H cm` that is never
 * closed. Anything appended afterwards inherits that flip, so new text/images
 * land vertically mirrored. Wrapping the original in `q … Q` restores the
 * default page CTM for whatever is appended next.
 */
export function isolateBaseCtm(contentBytes: Uint8Array): Uint8Array {
  let instructions;
  try {
    instructions = parseContentStream(contentBytes);
  } catch {
    return contentBytes;
  }
  let depth = 0;
  let topLevelCm = false;
  for (const inst of instructions) {
    if (inst.operator === 'q') depth++;
    else if (inst.operator === 'Q') depth = Math.max(0, depth - 1);
    else if (inst.operator === 'cm' && depth === 0) topLevelCm = true;
  }
  if (!topLevelCm) return contentBytes;
  const enc = new TextEncoder();
  const head = enc.encode('q\n');
  // close any q left open by the original so our Q restores the page CTM
  const tail = enc.encode('\n' + 'Q\n'.repeat(depth) + 'Q\n');
  const out = new Uint8Array(head.length + contentBytes.length + tail.length);
  out.set(head);
  out.set(contentBytes, head.length);
  out.set(tail, head.length + contentBytes.length);
  return out;
}
