/**
 * Content Stream Operator Lexer
 *
 * Tokenizes PDF page content streams into a sequence of operands and operators.
 * Content streams use a postfix notation: operands come first, then the operator.
 *
 * Example: "BT /F1 12 Tf 100 700 Td (Hello World) Tj ET"
 *   → [BT] [/F1, 12, Tf] [100, 700, Td] [(Hello World), Tj] [ET]
 *
 * This lexer reuses the core PDFLexer for token parsing but adds
 * content-stream-specific logic for inline images and operator grouping.
 */

import { PDFLexer, TokenType } from '../parser/lexer';
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

// ─── Content stream instruction ─────────────────────────────────────────────

export interface CSInstruction {
  /** The operator name (e.g., 'BT', 'Tf', 'Tj', 'm', 'l', 'S') */
  operator: string;
  /** The operands preceding this operator */
  operands: PDFObject[];
  /** Byte offset of the operator in the content stream */
  offset: number;
  /** Original BI dictionary, ID separator, binary data and EI terminator. */
  inlineImageBytes?: Uint8Array;
}

// ─── Operator classification ────────────────────────────────────────────────

/** All valid PDF content stream operators */
const OPERATORS = new Set([
  // Special
  'BT', 'ET',
  // Graphics state
  'q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs',
  // Path construction
  'm', 'l', 'c', 'v', 'y', 'h', 're',
  // Path painting
  'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
  // Clipping
  'W', 'W*',
  // Text state
  'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts',
  // Text positioning
  'Td', 'TD', 'Tm', 'T*',
  // Text showing
  'Tj', 'TJ', "'", '"',
  // Type 3 font
  'd0', 'd1',
  // Color
  'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k',
  // Shading
  'sh',
  // Inline images
  'BI', 'ID', 'EI',
  // XObjects
  'Do',
  // Marked content
  'MP', 'DP', 'BMC', 'BDC', 'EMC',
  // Compatibility
  'BX', 'EX',
]);

function isOperator(word: string): boolean {
  return OPERATORS.has(word);
}

// ─── Content stream parser ──────────────────────────────────────────────────

/**
 * Parse a content stream into a sequence of instructions.
 * Each instruction contains an operator and its preceding operands.
 */
export function parseContentStream(data: Uint8Array): CSInstruction[] {
  const lexer = new PDFLexer(data);
  const instructions: CSInstruction[] = [];
  const operandStack: PDFObject[] = [];

  while (!lexer.isEOF) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    const offset = lexer.position;
    const token = lexer.nextToken();
    if (!token || token.type === TokenType.EOF) break;

    switch (token.type) {
      case TokenType.Integer:
      case TokenType.Real:
        operandStack.push(new PDFNumber(token.value as number));
        break;

      case TokenType.String:
        operandStack.push(new PDFString(token.value as string));
        break;

      case TokenType.HexString:
        operandStack.push(new PDFHexString(token.value as string));
        break;

      case TokenType.Name:
        operandStack.push(new PDFName(token.value as string));
        break;

      case TokenType.Boolean:
        operandStack.push(new PDFBoolean(token.value as boolean));
        break;

      case TokenType.Null:
        operandStack.push(PDFNull.instance);
        break;

      case TokenType.Keyword: {
        const kw = token.value as string;

        if (kw === '[') {
          // Array operand
          operandStack.push(parseCSArray(lexer));
          break;
        }

        if (kw === '<<') {
          // Dictionary operand (rare in content streams, used in BDC)
          operandStack.push(parseCSDictionary(lexer));
          break;
        }

        if (kw === 'BI') {
          // Inline image — special handling
          const inlineImg = parseInlineImage(lexer, data);
          instructions.push({
            operator: 'BI',
            operands: inlineImg ? [inlineImg] : [],
            offset,
            inlineImageBytes: inlineImg ? data.subarray(offset, lexer.position) : undefined,
          });
          operandStack.length = 0;
          break;
        }

        if (isOperator(kw)) {
          // This is an operator — emit instruction with accumulated operands
          instructions.push({
            operator: kw,
            operands: operandStack.splice(0),
            offset,
          });
        } else {
          // Unknown keyword — treat as operator anyway
          // Some PDF generators emit non-standard operators
          instructions.push({
            operator: kw,
            operands: operandStack.splice(0),
            offset,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return instructions;
}

// ─── Array parsing within content stream ────────────────────────────────────

function parseCSArray(lexer: PDFLexer): PDFArray {
  const items: PDFObject[] = [];

  while (!lexer.isEOF) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    const savedPos = lexer.position;
    const token = lexer.nextToken();
    if (!token) break;

    if (token.type === TokenType.Keyword && token.value === ']') break;

    switch (token.type) {
      case TokenType.Integer:
      case TokenType.Real:
        items.push(new PDFNumber(token.value as number));
        break;
      case TokenType.String:
        items.push(new PDFString(token.value as string));
        break;
      case TokenType.HexString:
        items.push(new PDFHexString(token.value as string));
        break;
      case TokenType.Name:
        items.push(new PDFName(token.value as string));
        break;
      case TokenType.Boolean:
        items.push(new PDFBoolean(token.value as boolean));
        break;
      case TokenType.Null:
        items.push(PDFNull.instance);
        break;
      case TokenType.Keyword:
        if (token.value === '[') {
          items.push(parseCSArray(lexer));
        } else {
          // Unexpected — push as number 0 to avoid losing position
          lexer.position = savedPos;
          break;
        }
        break;
      default:
        break;
    }
  }

  return new PDFArray(items);
}

// ─── Dictionary parsing within content stream ───────────────────────────────

function parseCSDictionary(lexer: PDFLexer): PDFDict {
  const dict = new PDFDict();

  while (!lexer.isEOF) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    const token = lexer.nextToken();
    if (!token) break;
    if (token.type === TokenType.Keyword && token.value === '>>') break;

    if (token.type !== TokenType.Name) continue;

    const key = token.value as string;
    const valToken = lexer.nextToken();
    if (!valToken) break;

    switch (valToken.type) {
      case TokenType.Integer:
      case TokenType.Real:
        dict.set(key, new PDFNumber(valToken.value as number));
        break;
      case TokenType.String:
        dict.set(key, new PDFString(valToken.value as string));
        break;
      case TokenType.HexString:
        dict.set(key, new PDFHexString(valToken.value as string));
        break;
      case TokenType.Name:
        dict.set(key, new PDFName(valToken.value as string));
        break;
      case TokenType.Boolean:
        dict.set(key, new PDFBoolean(valToken.value as boolean));
        break;
      case TokenType.Keyword:
        if (valToken.value === '[') dict.set(key, parseCSArray(lexer));
        else if (valToken.value === '<<') dict.set(key, parseCSDictionary(lexer));
        break;
      default:
        break;
    }
  }

  return dict;
}

// ─── Inline image parsing ───────────────────────────────────────────────────

/**
 * Parse an inline image (BI ... ID <data> EI).
 * Returns the image dictionary with offsets into the original stream.
 */
function parseInlineImage(lexer: PDFLexer, data: Uint8Array): PDFDict | null {
  const dict = new PDFDict();
  let foundData = false;

  // Parse key-value pairs until 'ID' keyword
  while (!lexer.isEOF) {
    lexer.skipWhitespaceAndComments();
    const token = lexer.nextToken();
    if (!token) return null;

    if (token.type === TokenType.Keyword && token.value === 'ID') {
      // CRLF is one end-of-line separator, not a leading image sample.
      const separator = lexer.position;
      if (!isInlineImageWhitespace(data[separator])) return null;
      lexer.position += data[separator] === 0x0d && data[separator + 1] === 0x0a ? 2 : 1;
      foundData = true;
      break;
    }

    if (token.type === TokenType.Name) {
      const key = expandInlineImageKey(token.value as string);
      const valToken = lexer.nextToken();
      if (!valToken) return null;

      switch (valToken.type) {
        case TokenType.Integer:
        case TokenType.Real:
          dict.set(key, new PDFNumber(valToken.value as number));
          break;
        case TokenType.Name:
          dict.set(key, new PDFName(expandInlineImageValue(valToken.value as string)));
          break;
        case TokenType.Boolean:
          dict.set(key, new PDFBoolean(valToken.value as boolean));
          break;
        case TokenType.Keyword:
          if (valToken.value === '[') dict.set(key, parseCSArray(lexer));
          break;
        default:
          break;
      }
    }
  }

  if (!foundData) return null;

  const startPos = lexer.position;
  // Known unfiltered sample lengths keep even whitespace-delimited EI samples
  // inside the payload. Filtered/resource colour spaces need delimiter scanning.
  const sampleLength = inlineImageSampleLength(dict);
  let actualEiPos = lexer.searchForward('EI', startPos + (sampleLength ?? 0));
  while (actualEiPos !== -1) {
    const after = actualEiPos + 2;
    if (actualEiPos > startPos && isInlineImageWhitespace(data[actualEiPos - 1])
      && (after === data.length || isInlineImageWhitespace(data[after]))) {
      break;
    }
    actualEiPos = lexer.searchForward('EI', after);
  }
  if (actualEiPos === -1) return null;

  lexer.position = actualEiPos + 2;
  // Keep the existing data range, including the separator preceding EI.
  dict.set('__imageDataOffset', new PDFNumber(startPos));
  dict.set('__imageDataLength', new PDFNumber(actualEiPos - startPos));

  return dict;
}

/** PDF whitespace includes NUL, tab and form feed as well as line endings. */
function isInlineImageWhitespace(byte: number): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

const INLINE_IMAGE_COMPONENTS: Record<string, number> = {
  DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4,
};

function inlineImageSampleLength(dict: PDFDict): number | null {
  if (dict.has('Filter')) return null;
  const width = dict.get('Width');
  const height = dict.get('Height');
  const mask = dict.get('ImageMask');
  const isMask = mask instanceof PDFBoolean && mask.value;
  const bitsObject = dict.get('BitsPerComponent');
  const bits = isMask ? 1 : bitsObject instanceof PDFNumber ? bitsObject.value : 0;
  const colorSpace = dict.get('ColorSpace');
  const components = isMask ? 1 : colorSpace instanceof PDFName
    ? INLINE_IMAGE_COMPONENTS[colorSpace.name]
    : undefined;
  if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)
    || !components
    || !Number.isSafeInteger(width.value) || width.value <= 0
    || !Number.isSafeInteger(height.value) || height.value <= 0
    || !Number.isSafeInteger(bits) || bits <= 0) return null;
  const length = Math.ceil(width.value * components * bits / 8) * height.value;
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Expand abbreviated inline image dictionary keys to full names.
 */
function expandInlineImageKey(abbrev: string): string {
  const map: Record<string, string> = {
    'BPC': 'BitsPerComponent',
    'CS': 'ColorSpace',
    'D': 'Decode',
    'DP': 'DecodeParms',
    'F': 'Filter',
    'H': 'Height',
    'IM': 'ImageMask',
    'I': 'Interpolate',
    'W': 'Width',
    'L': 'Length',
  };
  return map[abbrev] ?? abbrev;
}

/**
 * Expand abbreviated inline image values.
 */
function expandInlineImageValue(abbrev: string): string {
  const map: Record<string, string> = {
    'G': 'DeviceGray',
    'RGB': 'DeviceRGB',
    'CMYK': 'DeviceCMYK',
    'I': 'Indexed',
    'AHx': 'ASCIIHexDecode',
    'A85': 'ASCII85Decode',
    'LZW': 'LZWDecode',
    'Fl': 'FlateDecode',
    'RL': 'RunLengthDecode',
    'CCF': 'CCITTFaxDecode',
    'DCT': 'DCTDecode',
  };
  return map[abbrev] ?? abbrev;
}
