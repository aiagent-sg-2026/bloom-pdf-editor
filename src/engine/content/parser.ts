/**
 * Content Stream Parser and Pretty-Printer
 *
 * Extends the operator-lexer with specialized functionality for text editing:
 * - Parse all text operators (Tj, TJ, ', ")
 * - Pretty-print operator structures back to PDF bytes
 * - Round-trip testing helpers (parse → print → parse)
 * - Operator matching utilities for finding specific Tj/TJ instructions
 *
 * This module is essential for surgical text editing where we need to:
 * 1. Parse content streams to find text operations
 * 2. Modify text operator operands
 * 3. Serialize back to valid PDF bytes
 * 4. Verify correctness through round-trip testing
 */

import { parseContentStream, type CSInstruction } from './operator-lexer';
import { serializeInstructions } from './instruction-serializer';
import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFString,
} from '../types';

// ─── Text Operator Types ────────────────────────────────────────────────────

export interface TextOperator {
  /** Instruction index in the original stream */
  index: number;
  /** The instruction itself */
  instruction: CSInstruction;
  /** Text content (decoded from operands) */
  text: string;
  /** Operator type */
  type: 'Tj' | 'TJ' | "'" | '"';
}

// ─── Parser Extensions ──────────────────────────────────────────────────────

/**
 * Parse content stream and extract all text-showing operators.
 * Returns both the full instruction list and filtered text operators.
 */
export function parseTextOperators(contentBytes: Uint8Array): {
  instructions: CSInstruction[];
  textOperators: TextOperator[];
} {
  const instructions = parseContentStream(contentBytes);
  const textOperators: TextOperator[] = [];

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    
    switch (inst.operator) {
      case 'Tj': {
        const strObj = inst.operands[0];
        const text = extractTextFromString(strObj);
        textOperators.push({
          index: i,
          instruction: inst,
          text,
          type: 'Tj',
        });
        break;
      }

      case 'TJ': {
        const arr = inst.operands[0];
        const text = extractTextFromTJArray(arr);
        textOperators.push({
          index: i,
          instruction: inst,
          text,
          type: 'TJ',
        });
        break;
      }

      case "'": {
        const strObj = inst.operands[0];
        const text = extractTextFromString(strObj);
        textOperators.push({
          index: i,
          instruction: inst,
          text,
          type: "'",
        });
        break;
      }

      case '"': {
        // " operator: aw ac string "
        const strObj = inst.operands[2];
        const text = extractTextFromString(strObj);
        textOperators.push({
          index: i,
          instruction: inst,
          text,
          type: '"',
        });
        break;
      }
    }
  }

  return { instructions, textOperators };
}

/**
 * Extract text from a PDF string object (PDFString or PDFHexString).
 * For now, this does basic byte-to-char conversion.
 * Font encoding will be handled at a higher level.
 */
function extractTextFromString(obj: PDFObject | undefined): string {
  if (obj instanceof PDFString) {
    return obj.value;
  }
  if (obj instanceof PDFHexString) {
    // Convert hex string to text
    const bytes = hexToBytes(obj.hex);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  return '';
}

/**
 * Extract text from a TJ array operand.
 * TJ arrays contain strings and numbers (for positioning).
 * We concatenate all strings and ignore the numbers.
 */
function extractTextFromTJArray(obj: PDFObject | undefined): string {
  if (!(obj instanceof PDFArray)) return '';
  
  let text = '';
  for (let i = 0; i < obj.length; i++) {
    const item = obj.get(i);
    if (item instanceof PDFString) {
      text += item.value;
    } else if (item instanceof PDFHexString) {
      const bytes = hexToBytes(item.hex);
      text += new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    // Numbers are positioning adjustments - skip them
  }
  return text;
}

/**
 * Convert hex string to byte array.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

// ─── Pretty Printer ─────────────────────────────────────────────────────────

/**
 * Serialize a list of instructions back to PDF content stream bytes.
 * This is the inverse of parseContentStream.
 */
export function prettyPrint(instructions: CSInstruction[]): Uint8Array {
  return serializeInstructions(instructions, serializeOperand);
}

/**
 * Serialize a single PDF object to its content stream representation.
 */
function serializeOperand(obj: PDFObject): string {
  if (obj instanceof PDFNumber) {
    // Format numbers cleanly
    const val = obj.value;
    if (Number.isInteger(val)) {
      return val.toString();
    }
    // Round to 6 decimal places to avoid floating point noise
    return val.toFixed(6).replace(/\.?0+$/, '');
  }

  if (obj instanceof PDFString) {
    // Escape special characters in string
    return `(${escapePDFString(obj.value)})`;
  }

  if (obj instanceof PDFHexString) {
    return `<${obj.hex}>`;
  }

  if (obj instanceof PDFName) {
    return `/${obj.name}`;
  }

  if (obj instanceof PDFBoolean) {
    return obj.value ? 'true' : 'false';
  }

  if (obj instanceof PDFNull) {
    return 'null';
  }

  if (obj instanceof PDFArray) {
    const items = [];
    for (let i = 0; i < obj.length; i++) {
      const item = obj.get(i);
      if (item) items.push(serializeOperand(item));
    }
    return `[${items.join(' ')}]`;
  }

  if (obj instanceof PDFDict) {
    const entries: string[] = [];
    for (const [key, value] of obj.entries()) {
      entries.push(`/${key} ${serializeOperand(value)}`);
    }
    return `<<${entries.join(' ')}>>`;
  }

  return '';
}

/**
 * Escape special characters in PDF literal strings.
 * PDF strings use backslash escaping for: \ ( ) \n \r \t \b \f
 */
function escapePDFString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ─── Round-Trip Testing ─────────────────────────────────────────────────────

/**
 * Test round-trip: parse → print → parse.
 * Returns comparison result.
 */
export function roundTripTest(originalBytes: Uint8Array): RoundTripResult {
  // First parse
  const instructions1 = parseContentStream(originalBytes);
  
  // Print to bytes
  const printedBytes = prettyPrint(instructions1);
  
  // Second parse
  const instructions2 = parseContentStream(printedBytes);
  
  // Compare
  const equivalent = areInstructionsEquivalent(instructions1, instructions2);
  
  return {
    success: equivalent,
    original: instructions1,
    roundTripped: instructions2,
    originalBytes,
    printedBytes,
    diff: equivalent ? null : findDifferences(instructions1, instructions2),
  };
}

export interface RoundTripResult {
  /** True if round-trip preserved semantics */
  success: boolean;
  /** Original parsed instructions */
  original: CSInstruction[];
  /** Instructions after round-trip */
  roundTripped: CSInstruction[];
  /** Original input bytes */
  originalBytes: Uint8Array;
  /** Printed bytes after first parse */
  printedBytes: Uint8Array;
  /** Differences found (if success = false) */
  diff: string | null;
}

/**
 * Compare two instruction lists for equivalence.
 * Allows for whitespace normalization and minor formatting differences.
 */
function areInstructionsEquivalent(
  inst1: CSInstruction[],
  inst2: CSInstruction[],
): boolean {
  if (inst1.length !== inst2.length) return false;

  for (let i = 0; i < inst1.length; i++) {
    const a = inst1[i];
    const b = inst2[i];

    if (a.operator !== b.operator) return false;
    if (a.operator === 'BI') {
      // Source offsets can move when surrounding instructions are reformatted.
      const original = a.inlineImageBytes;
      const printed = b.inlineImageBytes;
      if (!original || !printed || original.length !== printed.length
        || original.some((byte, index) => byte !== printed[index])) return false;
      continue;
    }
    if (a.operands.length !== b.operands.length) return false;

    for (let j = 0; j < a.operands.length; j++) {
      if (!areOperandsEquivalent(a.operands[j], b.operands[j])) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Compare two operands for equivalence.
 * Numbers are compared with tolerance for floating-point precision.
 */
function areOperandsEquivalent(a: PDFObject, b: PDFObject): boolean {
  // Type check
  if (a.constructor !== b.constructor) return false;

  if (a instanceof PDFNumber && b instanceof PDFNumber) {
    // Floating point comparison with tolerance
    return Math.abs(a.value - b.value) < 0.000001;
  }

  if (a instanceof PDFString && b instanceof PDFString) {
    return a.value === b.value;
  }

  if (a instanceof PDFHexString && b instanceof PDFHexString) {
    return a.hex.replace(/\s/g, '') === b.hex.replace(/\s/g, '');
  }

  if (a instanceof PDFName && b instanceof PDFName) {
    return a.name === b.name;
  }

  if (a instanceof PDFBoolean && b instanceof PDFBoolean) {
    return a.value === b.value;
  }

  if (a instanceof PDFNull && b instanceof PDFNull) {
    return true;
  }

  if (a instanceof PDFArray && b instanceof PDFArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const itemA = a.get(i);
      const itemB = b.get(i);
      if (!itemA || !itemB) return false;
      if (!areOperandsEquivalent(itemA, itemB)) return false;
    }
    return true;
  }

  if (a instanceof PDFDict && b instanceof PDFDict) {
    const keysA = Array.from(a.keys()).sort();
    const keysB = Array.from(b.keys()).sort();
    if (keysA.length !== keysB.length) return false;
    if (keysA.join(',') !== keysB.join(',')) return false;
    
    for (const key of keysA) {
      const valA = a.get(key);
      const valB = b.get(key);
      if (!valA || !valB) return false;
      if (!areOperandsEquivalent(valA, valB)) return false;
    }
    return true;
  }

  return false;
}

/**
 * Generate a human-readable diff of instruction differences.
 */
function findDifferences(
  inst1: CSInstruction[],
  inst2: CSInstruction[],
): string {
  const diffs: string[] = [];

  if (inst1.length !== inst2.length) {
    diffs.push(
      `Length mismatch: original has ${inst1.length} instructions, ` +
      `round-trip has ${inst2.length}`
    );
  }

  const maxLen = Math.max(inst1.length, inst2.length);
  for (let i = 0; i < maxLen; i++) {
    const a = inst1[i];
    const b = inst2[i];

    if (!a) {
      diffs.push(`Instruction ${i}: missing in original`);
      continue;
    }
    if (!b) {
      diffs.push(`Instruction ${i}: missing in round-trip`);
      continue;
    }

    if (a.operator !== b.operator) {
      diffs.push(
        `Instruction ${i}: operator mismatch: ` +
        `"${a.operator}" vs "${b.operator}"`
      );
    }

    if (a.operands.length !== b.operands.length) {
      diffs.push(
        `Instruction ${i} (${a.operator}): operand count mismatch: ` +
        `${a.operands.length} vs ${b.operands.length}`
      );
    }
  }

  return diffs.join('\n');
}

// ─── Operator Matching Utilities ────────────────────────────────────────────

/**
 * Find all Tj/TJ operators in the instruction list.
 */
export function findTextOperators(
  instructions: CSInstruction[],
): TextOperator[] {
  return parseTextOperators(new Uint8Array(0)).textOperators; // Placeholder
  // Note: This should be called via parseTextOperators with actual bytes
}

/**
 * Find operators that match a predicate.
 */
export function findOperators(
  instructions: CSInstruction[],
  predicate: (inst: CSInstruction) => boolean,
): CSInstruction[] {
  return instructions.filter(predicate);
}

/**
 * Find operators by name.
 */
export function findOperatorsByName(
  instructions: CSInstruction[],
  operatorName: string,
): CSInstruction[] {
  return instructions.filter(inst => inst.operator === operatorName);
}

/**
 * Find text operators containing specific text.
 */
export function findTextOperatorsWithText(
  instructions: CSInstruction[],
  searchText: string,
): TextOperator[] {
  const bytes = prettyPrint(instructions);
  const { textOperators } = parseTextOperators(bytes);
  return textOperators.filter(op => op.text.includes(searchText));
}

/**
 * Find text operators in a byte offset range.
 */
export function findTextOperatorsInRange(
  instructions: CSInstruction[],
  startOffset: number,
  endOffset: number,
): TextOperator[] {
  const bytes = prettyPrint(instructions);
  const { textOperators } = parseTextOperators(bytes);
  return textOperators.filter(
    op => op.instruction.offset >= startOffset && 
          op.instruction.offset <= endOffset
  );
}

/**
 * Replace a text operator's content with new text.
 * Returns a new instruction list with the replacement applied.
 */
export function replaceTextOperator(
  instructions: CSInstruction[],
  operatorIndex: number,
  newText: string,
): CSInstruction[] {
  const result = [...instructions];
  const inst = result[operatorIndex];
  
  if (!inst) return result;

  switch (inst.operator) {
    case 'Tj':
    case "'": {
      // Replace the string operand
      const operandIndex = inst.operator === 'Tj' ? 0 : 0; // ' also has string at index 0
      result[operatorIndex] = {
        ...inst,
        operands: [
          ...inst.operands.slice(0, operandIndex),
          new PDFString(newText),
          ...inst.operands.slice(operandIndex + 1),
        ],
      };
      break;
    }

    case '"': {
      // " has string at index 2 (after word spacing and char spacing)
      result[operatorIndex] = {
        ...inst,
        operands: [
          inst.operands[0],
          inst.operands[1],
          new PDFString(newText),
        ],
      };
      break;
    }

    case 'TJ': {
      // For TJ, replace the entire array with a single string
      // This is a simplification; more complex logic could preserve positioning
      result[operatorIndex] = {
        ...inst,
        operands: [
          new PDFArray([new PDFString(newText)]),
        ],
      };
      break;
    }
  }

  return result;
}

/**
 * Get indices of all text-showing operators.
 */
export function getTextOperatorIndices(instructions: CSInstruction[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < instructions.length; i++) {
    const op = instructions[i].operator;
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Extract all text content from a content stream in reading order.
 */
export function extractAllText(contentBytes: Uint8Array): string {
  const { textOperators } = parseTextOperators(contentBytes);
  return textOperators.map(op => op.text).join('');
}

// ─── Helper for surgical edits ──────────────────────────────────────────────

/**
 * Apply a text edit to content stream bytes.
 * This is a convenience wrapper that:
 * 1. Parses the content stream
 * 2. Finds the target operator
 * 3. Replaces its text
 * 4. Serializes back to bytes
 */
export function applyTextEdit(
  contentBytes: Uint8Array,
  targetOperatorIndex: number,
  newText: string,
): Uint8Array {
  const instructions = parseContentStream(contentBytes);
  const updated = replaceTextOperator(instructions, targetOperatorIndex, newText);
  return prettyPrint(updated);
}
