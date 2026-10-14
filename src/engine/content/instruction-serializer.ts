import type { CSInstruction } from './operator-lexer';
import type { PDFObject } from '../types';

/** Serialize instruction syntax without passing inline-image bytes through text encoders. */
export function serializeInstructions(
  instructions: CSInstruction[],
  serializeOperand: (operand: PDFObject) => string,
): Uint8Array {
  const chunks: (string | Uint8Array)[] = [];
  let length = 0;
  for (const inst of instructions) {
    if (inst.operator === 'BI') {
      if (!inst.inlineImageBytes) throw new Error('Cannot serialize an inline image without its original bytes');
      chunks.push(inst.inlineImageBytes, '\n');
      length += inst.inlineImageBytes.length + 1;
      continue;
    }
    let line = '';
    for (const operand of inst.operands) line += serializeOperand(operand) + ' ';
    line += inst.operator + '\n';
    chunks.push(line);
    length += line.length;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      for (let i = 0; i < chunk.length; i++) bytes[offset++] = chunk.charCodeAt(i) & 0xff;
    } else {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  return bytes;
}
