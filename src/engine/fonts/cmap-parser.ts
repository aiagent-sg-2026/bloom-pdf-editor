/**
 * CMap Parser — Character Code to Unicode Mapping
 *
 * Parses CMap streams used by PDF fonts to map character codes (glyph IDs)
 * to Unicode code points. CMaps are essential for text extraction from PDFs
 * that use CID fonts (CJK languages, custom encodings, subset fonts).
 *
 * Supports:
 *   - beginbfchar / endbfchar sections (direct char→unicode mappings)
 *   - beginbfrange / endbfrange sections (range-based mappings)
 *   - begincodespacerange / endcodespacerange (byte width determination)
 *   - begincidchar / endcidchar (char→CID mappings)
 *   - begincidrange / endcidrange (range-based CID mappings)
 *   - Multi-byte character codes (1-4 bytes)
 */

// ─── CMap data structure ────────────────────────────────────────────────────

export interface CMapData {
  /** Character code → Unicode string mapping */
  toUnicode: Map<number, string>;
  /** Character code → CID mapping (for CIDFont) */
  toCID: Map<number, number>;
  /** Width-qualified mappings keep <41> distinct from <0041>. */
  toUnicodeByLength: Map<number, Map<number, string>>;
  toCIDByLength: Map<number, Map<number, number>>;
  /** Code space ranges: [low, high] pairs defining valid byte ranges */
  codeSpaceRanges: Array<{ low: number; high: number; bytes: number }>;
  /** CMap name (from /CMapName if present) */
  name: string;
  /** Writing mode: 0 = horizontal, 1 = vertical */
  writingMode: number;
}

// ─── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a CMap stream (raw bytes) into a CMapData structure.
 */
export function parseCMap(data: Uint8Array): CMapData {
  const text = bytesToLatin1(data).replace(/%[^\r\n]*/g, '');
  const result: CMapData = {
    toUnicode: new Map(),
    toCID: new Map(),
    toUnicodeByLength: new Map(),
    toCIDByLength: new Map(),
    codeSpaceRanges: [],
    name: '',
    writingMode: 0,
  };

  // Extract CMap name
  const nameMatch = text.match(/\/CMapName\s*\/(\S+)/);
  if (nameMatch) result.name = nameMatch[1];

  // Extract writing mode
  const wmMatch = text.match(/\/WMode\s+(\d+)/);
  if (wmMatch) result.writingMode = parseInt(wmMatch[1], 10);

  // Parse codespace ranges
  parseCodeSpaceRanges(text, result);

  // Parse bfchar mappings (char code → Unicode)
  parseBfChar(text, result.toUnicode, result.toUnicodeByLength);

  // Parse bfrange mappings (range → Unicode)
  parseBfRange(text, result.toUnicode, result.toUnicodeByLength);

  // Parse cidchar mappings (char code → CID)
  parseCidChar(text, result.toCID, result.toCIDByLength);

  // Parse cidrange mappings (range → CID)
  parseCidRange(text, result.toCID, result.toCIDByLength);

  return result;
}

// ─── Section parsers ────────────────────────────────────────────────────────

function parseCodeSpaceRanges(text: string, result: CMapData): void {
  const regex = /begincodespacerange\s*([\s\S]*?)endcodespacerange/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([^<>]*)>\s*<([^<>]*)>/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const lowHex = lineMatch[1].replace(/\s/g, '');
      const highHex = lineMatch[2].replace(/\s/g, '');
      if (!/^(?:[0-9a-fA-F]{2}){1,4}$/.test(lowHex) || highHex.length !== lowHex.length ||
          !/^[0-9a-fA-F]+$/.test(highHex)) continue;
      const low = parseInt(lowHex, 16);
      const high = parseInt(highHex, 16);
      const bytes = lowHex.length / 2;
      let valid = true;
      for (let shift = 0; shift < bytes * 8; shift += 8) {
        if (((low >>> shift) & 0xff) > ((high >>> shift) & 0xff)) { valid = false; break; }
      }
      if (valid) result.codeSpaceRanges.push({ low, high, bytes });
    }
  }
}

function parseBfChar(text: string, map: Map<number, string>, byLength: Map<number, Map<number, string>>): void {
  const regex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const charCode = parseInt(lineMatch[1], 16);
      const unicode = hexToUnicodeStr(lineMatch[2]);
      map.set(charCode, unicode);
      setWidthMapping(byLength, lineMatch[1].length / 2, charCode, unicode);
    }
  }
}

function parseBfRange(text: string, map: Map<number, string>, byLength: Map<number, Map<number, string>>): void {
  const regex = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];

    // Two formats:
    // <startCode> <endCode> <unicodeStart>         — sequential range
    // <startCode> <endCode> [<u1> <u2> ...]        — explicit array
    const rangeRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let rangeMatch: RegExpExecArray | null;

    while ((rangeMatch = rangeRegex.exec(block)) !== null) {
      const startCode = parseInt(rangeMatch[1], 16);
      const endCode = parseInt(rangeMatch[2], 16);

      if (rangeMatch[3]) {
        // Sequential unicode mapping
        let unicodeStart = parseInt(rangeMatch[3], 16);
        for (let code = startCode; code <= endCode; code++) {
          const unicode = String.fromCodePoint(unicodeStart++);
          map.set(code, unicode);
          setWidthMapping(byLength, rangeMatch[1].length / 2, code, unicode);
        }
      } else if (rangeMatch[4]) {
        // Array of explicit unicode values
        const arrayContent = rangeMatch[4];
        const hexValues = arrayContent.match(/<([0-9a-fA-F]+)>/g) ?? [];
        for (let j = 0; j < hexValues.length && startCode + j <= endCode; j++) {
          const hex = hexValues[j].replace(/[<>]/g, '');
          const unicode = hexToUnicodeStr(hex);
          map.set(startCode + j, unicode);
          setWidthMapping(byLength, rangeMatch[1].length / 2, startCode + j, unicode);
        }
      }
    }
  }
}

function parseCidChar(text: string, map: Map<number, number>, byLength: Map<number, Map<number, number>>): void {
  const regex = /begincidchar\s*([\s\S]*?)endcidchar/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([0-9a-fA-F]+)>\s+(\d+)/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const charCode = parseInt(lineMatch[1], 16);
      const cid = parseInt(lineMatch[2], 10);
      map.set(charCode, cid);
      setWidthMapping(byLength, lineMatch[1].length / 2, charCode, cid);
    }
  }
}

function parseCidRange(text: string, map: Map<number, number>, byLength: Map<number, Map<number, number>>): void {
  const regex = /begincidrange\s*([\s\S]*?)endcidrange/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s+(\d+)/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const startCode = parseInt(lineMatch[1], 16);
      const endCode = parseInt(lineMatch[2], 16);
      let cid = parseInt(lineMatch[3], 10);
      const codeBytes = lineMatch[1].length / 2;
      for (let code = startCode; code <= endCode; code++) {
        map.set(code, cid);
        setWidthMapping(byLength, codeBytes, code, cid);
        cid++;
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setWidthMapping<T>(maps: Map<number, Map<number, T>>, bytes: number, code: number, value: T): void {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 4) return;
  let map = maps.get(bytes);
  if (!map) { map = new Map(); maps.set(bytes, map); }
  map.set(code, value);
}

/**
 * Convert a hex string to a Unicode string.
 * Every 4 hex digits = one Unicode code point.
 * If the hex string has 2 digits, treat as a single byte.
 */
function hexToUnicodeStr(hex: string): string {
  let result = '';
  if (hex.length <= 2) {
    // Single byte
    return String.fromCharCode(parseInt(hex, 16));
  }
  for (let i = 0; i < hex.length; i += 4) {
    if (i + 4 <= hex.length) {
      result += String.fromCodePoint(parseInt(hex.substring(i, i + 4), 16));
    } else {
      // Remaining digits
      result += String.fromCodePoint(parseInt(hex.substring(i), 16));
    }
  }
  return result;
}

function bytesToLatin1(data: Uint8Array): string {
  let str = '';
  for (let i = 0; i < data.length; i++) {
    str += String.fromCharCode(data[i]);
  }
  return str;
}

/**
 * Determine the number of bytes for a character code in this CMap.
 */
export function getCodeBytes(code: number, cmap: { codeSpaceRanges?: CMapData['codeSpaceRanges'] }, fallbackBytes?: number): number {
  if (cmap.codeSpaceRanges) {
    for (let bytes = 1; bytes <= 4; bytes++) {
      for (const range of cmap.codeSpaceRanges) {
        if (range.bytes === bytes && codeMatchesRange(code, range)) return bytes;
      }
    }
  }
  return fallbackBytes ?? (code > 0xff ? 2 : 1);
}

function codeMatchesRange(code: number, range: CMapData['codeSpaceRanges'][number]): boolean {
  if (code < 0 || code >= 256 ** range.bytes) return false;
  for (let shift = 0; shift < range.bytes * 8; shift += 8) {
    const byte = (code >>> shift) & 0xff;
    if (byte < ((range.low >>> shift) & 0xff) || byte > ((range.high >>> shift) & 0xff)) return false;
  }
  return true;
}

/** Test a width-qualified source code against the Encoding CMap. */
export function isCodeInCodeSpace(code: number, bytes: number, ranges: CMapData['codeSpaceRanges']): boolean {
  for (const range of ranges) {
    if (range.bytes === bytes && codeMatchesRange(code, range)) return true;
  }
  return false;
}

/**
 * PDF 32000-1 9.7.6.2: read the shortest complete matching codespace.
 * Invalid/unmatched input retains the legacy two-byte fallback, bounded by EOF.
 */
export function getCharCodeLength(
  data: ArrayLike<number>, offset: number, ranges?: CMapData['codeSpaceRanges'], fallbackBytes = 2,
): number {
  const remaining = data.length - offset;
  if (!ranges?.length) return Math.min(fallbackBytes, remaining);
  let code = 0;
  for (let bytes = 1; bytes <= Math.min(4, remaining); bytes++) {
    code = code * 256 + data[offset + bytes - 1];
    for (const range of ranges) {
      if (range.bytes === bytes && codeMatchesRange(code, range)) return bytes;
    }
  }
  return Math.min(fallbackBytes, remaining);
}

/** Read up to four bytes without signed 32-bit truncation. */
export function readCharCode(data: ArrayLike<number>, offset: number, length: number): number {
  let code = 0;
  for (let i = 0; i < length; i++) code = code * 256 + data[offset + i];
  return code;
}
