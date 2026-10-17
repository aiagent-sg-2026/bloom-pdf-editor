import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { explodeTJGaps } from '../content/tj-normalizer';
import { applyTextEdits, encodeTextForFont } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { parseCMap } from '../fonts/cmap-parser';
import { loadFont } from '../fonts/font-parser';
import { getGlyphOutline, parseTTF } from '../fonts/truetype-parser';
import { buildDocumentFlow } from '../flow';
import { applyStyleToLine, applyStyleToSelection } from '../flow/style-edit';
import { subsetFonts } from '../optimize/font-subsetter';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData, type PDFPageInfo } from '../types';
import { syntheticUnicodeFont, unicodeDocument } from './unicode-font-fixtures';

const bytes = (text: string) => new TextEncoder().encode(text);
const stream = (text: string) => new PDFStream(new PDFDict(), bytes(text), bytes(text));
const oneByte = '<00> <FF>';
// The long ranges share a leading byte; matching must not depend on range order.
const mixed = '<8100> <817F>\n<8180> <81FF>\n<00> <7F>';
const mappings: Array<[string, string, number]> = [['41', 'A', 1], ['8142', 'B', 4], ['8180', 'C', 5], ['20', ' ', 2]];

interface CodespaceFixture {
  doc: PDFDocumentData;
  page: PDFPageInfo;
  font: PDFDict;
  descendant: PDFDict;
  encoding: PDFStream;
}

function fixture(ranges: string, entries = mappings, encodingName?: string): CodespaceFixture {
  const doc = unicodeDocument(), page = doc.pages[0];
  const rangeCount = ranges.trim() ? ranges.trim().split('\n').length : 0;
  const encoding = stream(`begincmap\n${rangeCount} begincodespacerange\n${ranges}\nendcodespacerange\n${entries.length} begincidchar\n${entries.map(([code, , cid]) => `<${code}> ${cid}`).join('\n')}\nendcidchar\nendcmap`);
  // Deliberately broad: Encoding, not ToUnicode, decides how many bytes to read.
  const unicode = stream(`begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${entries.length} beginbfchar\n${entries.map(([code, text]) => `<${code}> <${Array.from(text, ch => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`).join('\n')}\nendbfchar\nendcmap`);
  const descendant = new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('CIDFontType2')],
    ['BaseFont', new PDFName('SyntheticCodespace')], ['DW', new PDFNumber(500)],
    ['W', new PDFArray([new PDFNumber(1), new PDFArray([500, 250, 700, 600, 650].map(n => new PDFNumber(n)))])],
    ['CIDToGIDMap', new PDFName('Identity')],
  ]);
  const font = new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type0')],
    ['BaseFont', new PDFName('SyntheticCodespace')],
    ['Encoding', encodingName ? new PDFName(encodingName) : new PDFRef(10, 0)],
    ['ToUnicode', new PDFRef(11, 0)], ['DescendantFonts', new PDFArray([descendant])],
  ]);
  (page.resources.get('Font') as PDFDict).set('F1', font);
  doc.objects.set('10_0', encoding);
  doc.objects.set('11_0', unicode);
  return { doc, page, font, descendant, encoding };
}

function show(hex: string) { return bytes(`BT /F1 10 Tf 1 0 0 1 40 700 Tm <${hex}> Tj ET`); }
function runs(data: Uint8Array, f: CodespaceFixture) { return interpretPage(data, f.page, f.doc.objects).textRuns; }

const cases = [
  { name: 'one-byte', ranges: oneByte, entries: [['41', 'A', 1], ['42', 'B', 4], ['43', 'C', 5]] as Array<[string, string, number]>, original: '414243', edited: '434241', codes: [0x41, 0x42, 0x43] },
  { name: 'mixed-width overlapping prefixes', ranges: mixed, entries: mappings, original: '4181428180', edited: '8180814241', codes: [0x41, 0x8142, 0x8180] },
  { name: 'leading-zero mixed codes', ranges: '<01> <7F>\n<0000> <00FF>', entries: [['41', 'A', 1], ['0041', 'B', 4], ['0042', 'C', 5]] as Array<[string, string, number]>, original: '4100410042', edited: '0042004141', codes: [0x41, 0x41, 0x42] },
  { name: 'one-byte code zero mapped to a nonzero CID', ranges: oneByte, entries: [['00', 'A', 1], ['01', 'B', 4], ['02', 'C', 5]] as Array<[string, string, number]>, original: '000102', edited: '020100', codes: [0, 1, 2] },
  { name: 'mixed one/three/four-byte codes', ranges: '<00> <7F>\n<810000> <81FFFF>\n<FF000000> <FFFFFFFF>', entries: [['41', 'A', 1], ['810042', 'B', 4], ['FF000043', 'C', 5]] as Array<[string, string, number]>, original: '41810042ff000043', edited: 'ff00004381004241', codes: [0x41, 0x810042, 0xff000043] },
  { name: 'shortest match with overlapping short/long prefixes', ranges: '<8100> <81FF>\n<00> <FF>', entries: [['81', 'A', 1], ['41', 'B', 4], ['42', 'C', 5]] as Array<[string, string, number]>, original: '814142', edited: '424181', codes: [0x81, 0x41, 0x42] },
  { name: 'Identity-H', ranges: '', entries: [['0001', 'A', 1], ['0004', 'B', 4], ['0005', 'C', 5]] as Array<[string, string, number]>, original: '000100040005', edited: '000500040001', codes: [1, 4, 5], encodingName: 'Identity-H' },
];

describe('synthetic Type0 Encoding codespaces', () => {
  it('maps inclusive CID ranges sequentially at each source-code width', () => {
    const cmap = parseCMap(bytes(`begincmap
4 begincidrange
<41> <43> 0
<0041> <0043> 4
<000041> <000043> 10
<00000041> <00000043> 100
endcidrange
1 begincidrange
<44> <44> 7
endcidrange
endcmap`));
    for (const [width, firstCID] of [[1, 0], [2, 4], [3, 10], [4, 100]]) {
      const expected: Array<[number, number]> = [[0x41, firstCID], [0x42, firstCID + 1], [0x43, firstCID + 2]];
      if (width === 1) expected.push([0x44, 7]);
      expect(cmap.toCIDByLength.get(width)).toEqual(new Map(expected));
    }
    expect(cmap.toCID).toEqual(new Map([[0x41, 100], [0x42, 101], [0x43, 102], [0x44, 7]]));
  });

  it('uses width-qualified CID ranges for glyph advances and edited text', () => {
    const f = fixture('<01> <7F>\n<0000> <00FF>', [
      ['41', 'A', 1], ['0041', 'B', 4], ['0042', 'C', 5], ['42', 'D', 2],
    ]);
    f.doc.objects.set('10_0', stream(`begincmap
2 begincodespacerange
<01> <7F>
<0000> <00FF>
endcodespacerange
2 begincidrange
<41> <42> 1
<0041> <0042> 4
endcidrange
endcmap`));
    const data = show('410041004242'), targetRun = runs(data, f)[0];
    expect(targetRun.text).toBe('ABCD');
    expect(targetRun.glyphs.map(g => g.charCode)).toEqual([0x41, 0x41, 0x42, 0x42]);
    expect(targetRun.glyphs.map(g => g.x)).toEqual([40, 45, 51, 57.5]);
    const encoded = encodeTextForFont('CBA', loadFont('F1', f.font, f.doc.objects));
    expect(encoded.missing).toEqual([]);
    expect((encoded.pdfString as PDFHexString).hex.toLowerCase()).toBe('0042004141');
    const edited = applyTextEdits(data, f.page, f.doc.objects, [{ targetRun, newText: 'CBA' }]).newContentBytes;
    const editedRun = runs(edited, f)[0];
    expect(editedRun.text).toBe('CBA');
    expect(editedRun.glyphs.map(g => g.x)).toEqual([40, 46.5, 52.5]);
  });

  it.each(cases)('extracts and edits $name without changing code boundaries', async c => {
    const f = fixture(c.ranges, c.entries, c.encodingName), data = show(c.original);
    const targetRun = runs(data, f)[0];
    expect(targetRun.text).toBe('ABC');
    expect(targetRun.glyphs.map(g => g.charCode)).toEqual(c.codes);
    expect(targetRun.glyphs.map(g => g.x)).toEqual([40, 45, 51]);
    const encoded = encodeTextForFont('CBA', loadFont('F1', f.font, f.doc.objects));
    expect(encoded.missing).toEqual([]);
    expect((encoded.pdfString as PDFHexString).hex.toLowerCase()).toBe(c.edited);
    const edited = applyTextEdits(data, f.page, f.doc.objects, [{ targetRun, newText: 'CBA' }]).newContentBytes;
    expect(runs(edited, f).map(r => r.text).join('')).toBe('CBA');
    const operands = parseContentStream(edited).flatMap(i => i.operands).filter(o => o instanceof PDFHexString);
    expect(operands.map(o => o.hex.toLowerCase()).join('')).toBe(c.edited);
    await updatePageContent(f.page.contentRefs, edited, f.doc.objects);
    const reopened = await parsePDF(await serializeDocument(f.doc));
    expect(interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns.map(r => r.text).join('')).toBe('CBA');
  });

  it.each(cases)('finds and edits literal $name text without source indices', c => {
    const f = fixture(c.ranges, c.entries, c.encodingName);
    const literal = Array.from(new PDFHexString(c.original).toBytes(), byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    const data = bytes(`BT /F1 10 Tf 1 0 0 1 40 700 Tm (${literal}) Tj ET`);
    const targetRun = { ...runs(data, f)[0], sourceInstructionIndices: undefined };
    const edited = applyTextEdits(data, f.page, f.doc.objects, [{ targetRun, newText: 'CBA' }]).newContentBytes;
    expect(runs(edited, f).map(r => r.text).join('')).toBe('CBA');
    expect(runs(edited, f).flatMap(r => r.glyphs.map(g => g.charCode))).toEqual([...c.codes].reverse());
  });

  it.each(["'", '"'])('edits and changes the face of mixed-width %s text', operator => {
    const f = fixture(mixed);
    const operand = operator === '"' ? '0 0 <4181428180>' : '<4181428180>';
    const data = bytes(`BT /F1 10 Tf 10 TL 1 0 0 1 40 700 Tm ${operand} ${operator} ET`);
    const targetRun = runs(data, f)[0];
    expect(targetRun.text).toBe('ABC');
    const edited = applyTextEdits(data, f.page, f.doc.objects, [{ targetRun, newText: 'CBA' }]).newContentBytes;
    expect(runs(edited, f).map(r => r.text).join('')).toBe('CBA');
    const line = buildDocumentFlow(runs(data, f)).lines[0];
    const changedFace = applyStyleToLine(data, f.page, f.doc.objects, line, { fontFamily: 'Courier' }).newContentBytes;
    expect(runs(changedFace, f).map(r => r.text).join('')).toBe('ABC');
  });

  it('matches codespace bytes independently, not a single numeric interval', () => {
    const f = fixture('<00> <7F>\n<8140> <82FE>', [['41', 'A', 1], ['8200', 'B', 4], ['8240', 'C', 5]]);
    // 8200 lies numerically inside 8140..82FE, but its second byte is outside 40..FE.
    const result = runs(show('4182008240'), f)[0];
    expect(result.glyphs.map(g => g.charCode)).toEqual([0x41, 0x8200, 0x8240]);
    expect(result.text).toBe('ABC');
    expect(encodeTextForFont('B', loadFont('F1', f.font, f.doc.objects)).missing).toEqual([0x42]);
  });

  it.each(['<0> <FF>', '<00> <FFFF>', '<FF> <00>', '<0000000000> <FFFFFFFFFF>', '<GG> <FF>', ''])('ignores malformed codespace %s and uses two-byte fallback', ranges => {
    const f = fixture(ranges, [['0001', 'A', 1], ['0004', 'B', 4]]);
    expect(parseCMap(f.encoding.getBytes()).codeSpaceRanges).toEqual([]);
    const result = runs(show('0001000401'), f)[0];
    expect(result.text).toBe('ABA');
    expect(result.glyphs.map(g => g.charCode)).toEqual([1, 4, 1]);
    expect((encodeTextForFont('BA', loadFont('F1', f.font, f.doc.objects)).pdfString as PDFHexString).hex).toBe('00040001');
  });

  it('keeps valid ranges alongside malformed entries and advances over truncated codes', () => {
    const f = fixture('<0> <F>\n<00> <7F>\n<8100> <81FF>', mappings);
    expect(parseCMap(f.encoding.getBytes()).codeSpaceRanges).toEqual([{ low: 0, high: 0x7f, bytes: 1 }, { low: 0x8100, high: 0x81ff, bytes: 2 }]);
    expect(runs(show('41814281'), f)[0].glyphs.map(g => g.charCode)).toEqual([0x41, 0x8142, 0x81]);
  });

  it('applies word spacing only when code 32 was encoded in one byte', () => {
    const entries: Array<[string, string, number]> = [['20', ' ', 2], ['41', 'A', 1]];
    const f = fixture(oneByte, entries);
    const data = bytes('BT /F1 10 Tf 8 Tw 1 0 0 1 40 700 Tm <2041> Tj ET');
    expect(runs(data, f)[0].glyphs.map(g => g.x)).toEqual([40, 50.5]);
    const identity = fixture('', [['0020', ' ', 2], ['0001', 'A', 1]], 'Identity-H');
    expect(runs(bytes('BT /F1 10 Tf 8 Tw 1 0 0 1 40 700 Tm <00200001> Tj ET'), identity)[0].glyphs.map(g => g.x)).toEqual([40, 45]);
  });

  it.each(cases)('preserves $name glyph positions while exploding TJ gaps', c => {
    const f = fixture(c.ranges, c.entries, c.encodingName);
    const first = c.entries[0][0], second = c.entries[1][0], third = c.entries[2][0];
    const data = bytes(`BT /F1 10 Tf 1 0 0 1 40 700 Tm <${first}> Tj [<${second}> -1800 <${third}>] TJ ET`);
    const normalized = explodeTJGaps(data, f.page, f.doc.objects);
    const positions = (b: Uint8Array) => runs(b, f).flatMap(r => r.glyphs.map(g => [g.charCode, g.unicode, g.x, g.y]));
    expect(positions(normalized)).toEqual(positions(data));
  });

  it.each(cases)('keeps $name bytes intact during partial style and face changes', c => {
    const f = fixture(c.ranges, c.entries, c.encodingName), data = show(c.original);
    const line = buildDocumentFlow(runs(data, f)).lines[0];
    const partial = applyStyleToSelection(data, f.page, f.doc.objects, line, 1, 2, { fontSize: 14 }).newContentBytes;
    expect(runs(partial, f).map(r => r.text).join('')).toBe('ABC');
    expect(runs(partial, f).flatMap(r => r.glyphs.map(g => g.charCode))).toEqual(c.codes);
    const changedFace = applyStyleToLine(data, f.page, f.doc.objects, line, { fontFamily: 'Courier' }).newContentBytes;
    expect(runs(changedFace, f).map(r => r.text).join('')).toBe('ABC');
  });

  it.each(cases)('retains used $name glyph outlines during optimization', async c => {
    const f = fixture(c.ranges, c.entries, c.encodingName), data = show(c.original);
    const fontBytes = syntheticUnicodeFont('both', false, 1024), fontRef = new PDFRef(20, 0);
    const program = new PDFStream(new PDFDict(), fontBytes, fontBytes);
    f.doc.objects.set(fontRef.toKey(), program);
    f.descendant.set('FontDescriptor', new PDFDict([['FontFile2', fontRef]]));
    // Use a nonidentity CIDToGIDMap so code -> CID -> GID must all be respected.
    const cidMap = new Uint8Array(12); cidMap[3] = 7; cidMap[9] = 5; cidMap[11] = 4;
    f.descendant.set('CIDToGIDMap', new PDFStream(new PDFDict(), cidMap, cidMap));
    await updatePageContent(f.page.contentRefs, data, f.doc.objects);
    const before = parseTTF(fontBytes), result = await subsetFonts(f.doc);
    expect(result.fontsSubsetted).toBe(1);
    const after = parseTTF(program.getBytes());
    for (const gid of [4, 5, 7]) expect(getGlyphOutline(after, gid)).toEqual(getGlyphOutline(before, gid));
  });
});
