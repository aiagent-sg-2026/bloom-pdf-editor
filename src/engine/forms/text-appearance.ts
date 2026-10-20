import { parseContentStream } from '../content/operator-lexer';
import { serializeToString } from '../editor/stream-compiler';
import { encodeTextForFont } from '../editor/text-editor';
import { registerFontObject } from '../fonts/font-augmentation';
import { charCodeToUnicode, loadFont, type FontData } from '../fonts/font-parser';
import { resolveRef } from '../parser/parser';
import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNumber, PDFObject, PDFRef, PDFStream, PDFString, type PDFDocumentData } from '../types';
import { getNextObjNum } from '../writer/serializer';
import type { AcroFormWidget } from './types';

function resolved(doc: PDFDocumentData, value: PDFObject | undefined): PDFObject | undefined {
  return value ? resolveRef(value, doc.objects) : undefined;
}

function acroForm(doc: PDFDocumentData): PDFDict | undefined {
  const acro = resolved(doc, doc.catalog.get('AcroForm'));
  return acro instanceof PDFDict ? acro : undefined;
}

/** Resolve inheritable field entries through /Parent, then AcroForm defaults. */
export function inherited(doc: PDFDocumentData, dict: PDFDict, key: string): PDFObject | undefined {
  const seen = new Set<PDFDict>();
  let current: PDFObject | undefined = dict;
  while (current instanceof PDFDict && !seen.has(current)) {
    seen.add(current);
    if (current.has(key)) return resolved(doc, current.get(key));
    current = resolved(doc, current.get('Parent'));
  }
  return resolved(doc, acroForm(doc)?.get(key));
}

/** Decode PDF text strings, not font-encoded appearance strings. */
export function formText(value: PDFObject | undefined): string {
  if (!(value instanceof PDFString || value instanceof PDFHexString)) return '';
  const bytes = value.toBytes();
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
    return text;
  }
  return value instanceof PDFString ? value.value : value.toText();
}

function valueString(value: string): PDFString {
  if (!/[^\u0000-\u007f]/.test(value)) return new PDFString(value);
  let bytes = '\xfe\xff';
  for (let i = 0; i < value.length; i++) bytes += String.fromCharCode(value.charCodeAt(i) >> 8, value.charCodeAt(i) & 255);
  return new PDFString(bytes);
}

function number(value: PDFObject | undefined, fallback = 0): number {
  return value instanceof PDFNumber && Number.isFinite(value.value) ? value.value : fallback;
}

const fmt = (value: number): string => serializeToString(new PDFNumber(value));

interface Glyph { bytes: string; width: number }

type GlyphEncoder = (text: string) => Glyph | undefined;

function encoder(font: FontData): GlyphEncoder {
  const cache = new Map<string, Glyph | undefined>();
  const reverse = new Map<string, number>();
  if (!font.isComposite) {
    for (let code = 32; code < 256; code++) {
      if (font.toUnicode.size && !font.toUnicode.has(code) && !font.differences.has(code)) continue;
      // Without an explicit mapping, high bytes in non-WinAnsi fonts are unsafe.
      if (code >= 127 && font.encoding !== 'WinAnsiEncoding' && !font.toUnicode.has(code) && !font.differences.has(code)) continue;
      reverse.set(charCodeToUnicode(code, font), code);
    }
  }
  return text => {
    if (cache.has(text)) return cache.get(text);
    let bytes: string;
    let code: number;
    if (!font.isComposite) {
      const mapped = reverse.get(text);
      if (mapped === undefined) { cache.set(text, undefined); return undefined; }
      code = mapped;
      bytes = String.fromCharCode(code);
    } else {
      const encoded = encodeTextForFont(text, font);
      if (encoded.missing.length) { cache.set(text, undefined); return undefined; }
      const raw = encoded.pdfString.toBytes();
      bytes = Array.from(raw, byte => String.fromCharCode(byte)).join('');
      code = raw.reduce((value, byte) => value * 256 + byte, 0);
      code = font.encodingCMap?.toCIDByLength.get(raw.length)?.get(code) ?? font.toCID?.get(code) ?? code;
    }
    const glyph = { bytes, width: font.widths.get(code) ?? font.defaultWidth };
    cache.set(text, glyph);
    return glyph;
  };
}

function color(value: PDFObject | undefined, stroke = false): string | undefined {
  if (!(value instanceof PDFArray) || ![1, 3, 4].includes(value.length)) return undefined;
  if (!value.items.every(item => item instanceof PDFNumber && Number.isFinite(item.value))) return undefined;
  const operator = value.length === 1 ? 'g' : value.length === 3 ? 'rg' : 'k';
  return `${value.asNumbers().map(component => fmt(Math.max(0, Math.min(1, component)))).join(' ')} ${stroke ? operator.toUpperCase() : operator}`;
}

function wrap(text: string, measure: (text: string) => number, limit: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let lineWidth = 0;
    for (const word of paragraph.match(/\S+|[^\S\n]+/g) ?? []) {
      if (line && lineWidth + measure(word) > limit) {
        lines.push(line.trimEnd());
        line = '';
        lineWidth = 0;
        if (!word.trim()) continue;
      }
      for (const ch of word) {
        const charWidth = measure(ch);
        if (line && lineWidth + charWidth > limit) { lines.push(line); line = ''; lineWidth = 0; }
        line += ch;
        lineWidth += charWidth;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Replace only /AP /N; rollover/down appearances and shared fonts remain untouched. */
function regenerate(doc: PDFDocumentData, dict: PDFDict): boolean {
  const type = inherited(doc, dict, 'FT');
  if (!(type instanceof PDFName) || (type.name !== 'Tx' && type.name !== 'Ch')) return false;
  const rect = resolved(doc, dict.get('Rect'));
  if (!(rect instanceof PDFArray) || rect.length !== 4 || !rect.items.every(item => item instanceof PDFNumber && Number.isFinite(item.value))) return false;
  const [x0, y0, x1, y1] = rect.asNumbers();
  const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
  if (width <= 0 || height <= 0) return false;

  const value = inherited(doc, dict, 'V');
  if (value && !(value instanceof PDFString || value instanceof PDFHexString)) return false;
  let text = formText(value);
  if (type.name === 'Ch') {
    const options = inherited(doc, dict, 'Opt');
    if (options instanceof PDFArray) {
      for (const entry of options.items) {
        const option = resolved(doc, entry);
        if (option instanceof PDFArray && formText(resolved(doc, option.get(0))) === text) {
          text = formText(resolved(doc, option.get(1)));
          break;
        }
      }
    }
  }
  const flags = number(inherited(doc, dict, 'Ff'));
  const multiline = type.name === 'Tx' && (flags & 4096) !== 0;
  const maxLen = Math.max(0, Math.floor(number(inherited(doc, dict, 'MaxLen'))));
  const comb = type.name === 'Tx' && (flags & 16777216) !== 0 && maxLen > 0 && !multiline;
  text = text.replace(/\r\n?|\n/g, multiline ? '\n' : ' ').replace(/\t/g, ' ');
  if (type.name === 'Tx' && maxLen) text = Array.from(text).slice(0, maxLen).join('');

  let fontName = '', fontSize = 12, textColor = '0 g';
  for (const instruction of parseContentStream(new TextEncoder().encode(formText(inherited(doc, dict, 'DA'))))) {
    const { operator, operands } = instruction;
    if (operator === 'Tf' && operands[0] instanceof PDFName) {
      fontName = operands[0].name;
      fontSize = Math.max(0, number(operands[1], 12));
    } else if (['g', 'rg', 'k'].includes(operator)) {
      textColor = color(new PDFArray(operands)) ?? textColor;
    }
  }
  const resources = resolved(doc, acroForm(doc)?.get('DR'));
  const fonts = resources instanceof PDFDict ? resolved(doc, resources.get('Font')) : undefined;
  let fontObject = fonts instanceof PDFDict ? fonts.get(fontName) : undefined;
  let fontDict = resolved(doc, fontObject);
  let font: FontData | undefined;
  let encode: GlyphEncoder | undefined;
  if (fontDict instanceof PDFDict) {
    font = loadFont('FForm', fontDict, doc.objects);
    encode = encoder(font);
  }
  if (!encode || Array.from(text).some(ch => ch !== '\n' && !encode!(ch))) {
    fontDict = new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
      ['BaseFont', new PDFName('Helvetica')], ['Encoding', new PDFName('WinAnsiEncoding')],
    ]);
    fontObject = fontDict;
    font = loadFont('FForm', fontDict, doc.objects);
    encode = encoder(font);
  }
  const selectedFont = font!;
  const encodeGlyph = encode!;
  // Preserve Unicode in /V; unsupported appearance glyphs degrade to visible '?'.
  const glyph = (ch: string): Glyph => encodeGlyph(ch) ?? encodeGlyph('?')!;
  const units = (line: string): number => Array.from(line).reduce((sum, ch) => sum + glyph(ch).width, 0) / 1000;

  const mk = resolved(doc, dict.get('MK'));
  const bg = mk instanceof PDFDict ? color(resolved(doc, mk.get('BG'))) : undefined;
  const borderColor = mk instanceof PDFDict ? color(resolved(doc, mk.get('BC')), true) : undefined;
  const bs = resolved(doc, dict.get('BS'));
  const border = resolved(doc, dict.get('Border'));
  const borderWidth = Math.max(0, bs instanceof PDFDict ? number(bs.get('W'), 1) : border instanceof PDFArray ? number(border.get(2), 1) : 1);
  const pad = Math.max(2, borderColor ? borderWidth + 1 : 2);
  const availableWidth = width - pad * 2, availableHeight = height - pad * 2;
  if (availableWidth <= 0 || availableHeight <= 0) return false;
  const ascent = (selectedFont.ascent ?? 800) / 1000;
  const descent = (selectedFont.descent ?? -200) / 1000;
  const emHeight = Math.max(1, ascent - descent);
  const layout = (size: number): string[] => multiline ? wrap(text, line => units(line) * size, availableWidth) : [text];
  if (fontSize === 0) {
    let low = 0, high = availableHeight / emHeight;
    for (let i = 0; i < 24; i++) {
      const size = (low + high) / 2;
      const lines = layout(size);
      const fitsWidth = comb ? Array.from(text).every(ch => units(ch) * size <= availableWidth / maxLen) : lines.every(line => units(line) * size <= availableWidth);
      if (fitsWidth && (emHeight + (lines.length - 1) * 1.2) * size <= availableHeight) low = size;
      else high = size;
    }
    fontSize = Math.max(0.00001, Math.floor(low * 100000) / 100000);
  }
  const alignment = number(inherited(doc, dict, 'Q'));
  const commands = ['q'];
  if (bg) commands.push(bg, `0 0 ${fmt(width)} ${fmt(height)} re f`);
  if (borderColor && borderWidth > 0) {
    commands.push(borderColor, `${fmt(borderWidth)} w`, `${fmt(borderWidth / 2)} ${fmt(borderWidth / 2)} ${fmt(Math.max(0, width - borderWidth))} ${fmt(Math.max(0, height - borderWidth))} re S`);
  }
  commands.push(`${fmt(pad)} ${fmt(pad)} ${fmt(availableWidth)} ${fmt(availableHeight)} re W n`, '/Tx BMC', 'BT', `/FForm ${fmt(fontSize)} Tf`, textColor);
  const baseline = multiline ? height - pad - ascent * fontSize : (height - (ascent + descent) * fontSize) / 2;
  const show = (line: string, x: number, y: number): void => {
    const encoded = new PDFString(Array.from(line, ch => glyph(ch).bytes).join(''));
    commands.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm ${serializeToString(encoded)} Tj`);
  };
  if (comb) {
    const chars = Array.from(text);
    const start = alignment === 1 ? Math.floor((maxLen - chars.length) / 2) : alignment === 2 ? maxLen - chars.length : 0;
    chars.forEach((ch, i) => show(ch, pad + (start + i + 0.5) * availableWidth / maxLen - units(ch) * fontSize / 2, baseline));
  } else {
    layout(fontSize).forEach((line, i) => {
      const remaining = availableWidth - units(line) * fontSize;
      show(line, pad + (alignment === 1 ? remaining / 2 : alignment === 2 ? remaining : 0), baseline - i * fontSize * 1.2);
    });
  }
  commands.push('ET', 'EMC', 'Q');
  const bytes = new TextEncoder().encode(commands.join('\n'));
  if (!(fontObject instanceof PDFRef) && fontDict instanceof PDFDict) {
    fontObject = registerFontObject(doc.objects, fontDict);
  }
  const streamDict = new PDFDict([
    ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Form')],
    ['BBox', new PDFArray([0, 0, width, height].map(value => new PDFNumber(value)))],
    ['Resources', new PDFDict([['Font', new PDFDict([['FForm', fontObject!]])]])],
    ['Length', new PDFNumber(bytes.length)],
  ]);
  const ref = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), new PDFStream(streamDict, bytes, bytes));
  const oldAP = resolved(doc, dict.get('AP'));
  const ap = new PDFDict(oldAP instanceof PDFDict ? [...oldAP.entries()] : []);
  ap.set('N', ref);
  dict.set('AP', ap);
  return true;
}

/** Update the terminal field and all its widgets, including widgets on other pages. */
export function setTextFieldValue(doc: PDFDocumentData, widget: AcroFormWidget, value: string): void {
  let owner = widget.dict;
  const seen = new Set<PDFDict>();
  while (!owner.has('T') && !owner.has('FT') && !seen.has(owner)) {
    seen.add(owner);
    const parent = resolved(doc, owner.get('Parent'));
    if (!(parent instanceof PDFDict)) break;
    owner = parent;
  }
  const maxLen = Math.max(0, Math.floor(number(inherited(doc, owner, 'MaxLen'))));
  if (widget.fieldType === 'Tx' && maxLen) value = Array.from(value).slice(0, maxLen).join('');
  owner.set('V', valueString(value));
  widget.value = value;
  const regenerated = new Set<PDFDict>();
  const visited = new Set<PDFDict>();
  const visit = (dict: PDFDict): boolean => {
    if (visited.has(dict)) return false;
    visited.add(dict);
    let complete = true;
    if (dict.getName('Subtype') === 'Widget') {
      complete = regenerated.has(dict) || regenerate(doc, dict);
      if (complete) regenerated.add(dict);
    }
    const kids = resolved(doc, dict.get('Kids'));
    if (kids instanceof PDFArray) for (const entry of kids.items) {
      const child = resolved(doc, entry);
      if (!(child instanceof PDFDict) || !visit(child)) complete = false;
    }
    return complete;
  };
  visit(owner);
  const acro = acroForm(doc);
  if (!(acro?.get('NeedAppearances') instanceof PDFBoolean) || !(acro.get('NeedAppearances') as PDFBoolean).value) return;
  visited.clear();
  const fields = resolved(doc, acro.get('Fields'));
  let complete = fields instanceof PDFArray;
  if (fields instanceof PDFArray) for (const entry of fields.items) {
    const field = resolved(doc, entry);
    if (!(field instanceof PDFDict) || !visit(field)) complete = false;
  }
  // Unsupported fields (e.g. signatures/buttons) retain the document's original hint.
  if (complete) acro.delete('NeedAppearances');
}
