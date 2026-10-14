import { describe, expect, it } from 'vitest';
import { extractPagePlainText } from '../ai/compare';
import { interpretPage } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { applyTextEdits, insertTextRun, prepareTextForExport } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { applyLineTextEdit } from '../flow/flow-editor';
import { applyStyleToSelection } from '../flow/style-edit';
import { buildDocumentFlow } from '../flow';
import { SHAPING_SCRIPTS, SCRIPT_FONTS, isShapingFont, scriptFontId, splitScriptRuns, type ScriptFontId } from '../fonts/script-fonts';
import { shapeText } from '../fonts/shaping';
import { getGlyphOutline, parseTTF } from '../fonts/truetype-parser';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';
import { getPageContentBytes, parsePDF, resolveRef } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFStream } from '../types';
import { saveQuick, saveOptimized } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';
import { unicodeDocument } from './unicode-font-fixtures';
import { shapingCases, shapingFontBytes } from './shaping-fixtures';

const fontSources = Object.fromEntries([...shapingCases.map(({ id }) => id), 'sc'].map(id => [id,
  () => Promise.resolve(shapingFontBytes(id as ScriptFontId))]));
const exportCases = [...shapingCases.map(({ text }) => ({ text })), { text: 'Hello สวัสดี नमस्ते 你好' },
  { text: 'क्\u200dष क्\u200cष कि क्ष' }];

describe('shaped font PDF export', () => {
  for (const save of [saveQuick, saveOptimized]) {
    it.each(exportCases)(`${save.name} embeds positioned subsets and extracts $text exactly`, async ({ text }) => {
      const doc = unicodeDocument(), page = doc.pages[0];
      await prepareTextForExport(doc.objects, [{ text }], fontSources);
      const bytes = insertTextRun(new Uint8Array(), page, doc.objects, text, 40, 650, 12, [0, 0, 0]);
      await updatePageContent(page.contentRefs, bytes, doc.objects);
      const reopened = await parsePDF(await save(doc)), reopenedPage = reopened.pages[0];
      expect(extractPagePlainText(reopened, 0)).toBe(text);
      const content = getPageContentBytes(reopenedPage, reopened.objects), instructions = parseContentStream(content);
      const resources = resolveRef(reopenedPage.resources.get('Font')!, reopened.objects) as PDFDict;
      const expected = [];
      for (const part of splitScriptRuns(text)) {
        if (!isShapingFont(part.fontId)) continue;
        const clusters = await shapeText(shapingFontBytes(part.fontId), part.text, SHAPING_SCRIPTS[part.fontId]);
        for (const cluster of clusters) expected.push({ id: part.fontId, cluster });
      }
      let activeFont = '', spanIndex = 0, glyphIndex = 0;
      for (const instruction of instructions) {
        if (instruction.operator === 'Tf') activeFont = (instruction.operands[0] as PDFName).name;
        if (instruction.operator === 'BDC') {
          const properties = instruction.operands[1] as PDFDict;
          const actual = properties.get('ActualText') as PDFHexString;
          const entry = expected[spanIndex];
          expect(actual.toBytes().slice(0, 2)).toEqual(new Uint8Array([0xfe, 0xff]));
          let hex = 'feff';
          for (let at = 0; at < entry.cluster.text.length; at++) hex += entry.cluster.text.charCodeAt(at).toString(16).padStart(4, '0');
          expect(actual.hex.toLowerCase()).toBe(hex);
          glyphIndex = 0;
        }
        if (instruction.operator === 'TJ') {
          const entry = expected[spanIndex], glyph = entry.cluster.glyphs[glyphIndex++];
          const source = parseTTF(shapingFontBytes(entry.id));
          const font = resolveRef(resources.get(activeFont)!, reopened.objects) as PDFDict;
          expect(font.getName('BaseFont')).toMatch(new RegExp(`^[A-Z]{6}\\+${SCRIPT_FONTS[entry.id].baseFont}$`));
          expect(font.getName('Subtype')).toBe('Type0');
          expect(font.getName('Encoding')).toBe('Identity-H');
          const descendant = resolveRef(font.getArray('DescendantFonts')!.get(0)!, reopened.objects) as PDFDict;
          expect(descendant.getName('Subtype')).toBe('CIDFontType2');
          const descriptor = resolveRef(descendant.get('FontDescriptor')!, reopened.objects) as PDFDict;
          const program = resolveRef(descriptor.get('FontFile2')!, reopened.objects) as PDFStream;
          expect(program).toBeInstanceOf(PDFStream);
          const subset = parseTTF(program.getBytes());
          expect(subset.numGlyphs).toBeLessThan(source.numGlyphs);
          const cidMap = resolveRef(descendant.get('CIDToGIDMap')!, reopened.objects) as PDFStream;
          const array = instruction.operands[0] as PDFArray, cidBytes = (array.get(1) as PDFHexString).toBytes();
          const cid = (cidBytes[0] << 8) | cidBytes[1], mapping = cidMap.getBytes();
          const gid = (mapping[cid * 2] << 8) | mapping[cid * 2 + 1];
          expect(getGlyphOutline(subset, gid)?.commands).toEqual(getGlyphOutline(source, glyph.gid)?.commands);
          const widths = (descendant.getArray('W')!.get(1) as PDFArray).asNumbers();
          const nominal = source.advanceWidths[glyph.gid] * 1000 / source.unitsPerEm;
          expect(widths[cid - 1]).toBeCloseTo(nominal, 5);
          expect((array.get(0) as PDFNumber).value).toBeCloseTo(-glyph.xOffset * 1000 / source.unitsPerEm, 5);
          expect((array.get(2) as PDFNumber).value).toBeCloseTo((source.advanceWidths[glyph.gid] + glyph.xOffset - glyph.advance) * 1000 / source.unitsPerEm, 5);
          const index = instructions.indexOf(instruction), rise = instructions[index - 1];
          expect(rise.operator).toBe('Ts');
          expect((rise.operands[0] as PDFNumber).value).toBeCloseTo(glyph.yOffset * 12 / source.unitsPerEm, 5);
        }
        if (instruction.operator === 'EMC') {
          expect(glyphIndex).toBe(expected[spanIndex].cluster.glyphs.length);
          spanIndex++;
        }
      }
      expect(spanIndex).toBe(expected.length);
      const graphs = [...resources.values()].map(ref => resolveRef(ref, reopened.objects))
        .filter((font): font is PDFDict => font instanceof PDFDict && font.getName('Subtype') === 'Type0');
      const expectedIds = [...new Set(splitScriptRuns(text).filter(part => part.fontId !== 'latin').map(part => part.fontId))].sort();
      expect(graphs.map(font => scriptFontId(font.getName('BaseFont')!)).sort()).toEqual(expectedIds);
      for (const run of interpretPage(content, reopenedPage, reopened.objects).textRuns.filter(run => run.actualText)) {
        expect(run.actualTextLayout?.width).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it.each(['مرحبا', 'עברית', '😀'])('rejects unsupported text atomically: %s', async text => {
    const doc = unicodeDocument(), before = await serializeDocument(doc);
    await expect(prepareTextForExport(doc.objects, [{ text }], fontSources)).rejects.toBeInstanceOf(UnsupportedGlyphsError);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('keeps all font graphs unpublished on a failed shaping font load', async () => {
    const doc = unicodeDocument(), before = await serializeDocument(doc);
    await expect(prepareTextForExport(doc.objects, [{ text: '你好 नमस्ते' }], {
      sc: shapingFontBytes('sc'), devanagari: async () => { throw new Error('offline'); },
    })).rejects.toBeInstanceOf(UnsupportedGlyphsError);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('requires preparation of new conjunct glyphs even when every scalar was prepared earlier', async () => {
    const doc = unicodeDocument(), page = doc.pages[0];
    await prepareTextForExport(doc.objects, [{ text: 'क ष ्' }], fontSources);
    const before = await serializeDocument(doc);
    expect(() => insertTextRun(new Uint8Array(), page, doc.objects, 'क्ष', 40, 650, 12, [0, 0, 0]))
      .toThrow(UnsupportedGlyphsError);
    expect(await serializeDocument(doc)).toEqual(before);
    await prepareTextForExport(doc.objects, [{ text: 'क्ष' }], fontSources);
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, 'क्ष', 40, 650, 12, [0, 0, 0]), doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveQuick(doc)), 0)).toBe('क्ष');
  });

  it('preserves reopened shaped runs when editing or styling is rejected, and appends without rewriting the old graph', async () => {
    const original = unicodeDocument(), page = original.pages[0], text = 'नमस्ते दुनिया क्षत्रिय';
    await prepareTextForExport(original.objects, [{ text }], fontSources);
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, original.objects, text, 40, 650, 12, [0, 0, 0]), original.objects);
    const doc = await parsePDF(await saveQuick(original)), reopened = doc.pages[0];
    const bytes = getPageContentBytes(reopened, doc.objects), before = await serializeDocument(doc);
    const runs = interpretPage(bytes, reopened, doc.objects).textRuns, target = runs.find(run => run.actualText)!;
    expect(() => applyTextEdits(bytes, reopened, doc.objects, [{ targetRun: target, newText: 'कि' }])).toThrow('cannot be edited in place');
    const flow = buildDocumentFlow(runs), line = flow.lines[0];
    expect(() => applyLineTextEdit(bytes, reopened, doc.objects, line, 'कि', flow)).toThrow('cannot be edited in place');
    expect(() => applyStyleToSelection(bytes, reopened, doc.objects, line, 0, line.text.length, { bold: true })).toThrow('Per-glyph styles');
    expect(await serializeDocument(doc)).toEqual(before);
    const oldFonts = [...doc.objects.values()].filter((value): value is PDFDict => value instanceof PDFDict && value.getName('Subtype') === 'Type0');
    await prepareTextForExport(doc.objects, [{ text: 'कि' }], fontSources);
    expect([...doc.objects.values()].filter(value => value instanceof PDFDict && value.getName('Subtype') === 'Type0')).toHaveLength(oldFonts.length + 1);
    await updatePageContent(reopened.contentRefs, insertTextRun(bytes, reopened, doc.objects, 'कि', 40, 620, 12, [0, 0, 0]), doc.objects);
    const saved = await parsePDF(await saveOptimized(doc));
    expect(extractPagePlainText(saved, 0)).toBe(`${text}\nकि`);
  });

  it('respects nested ActualText and unmarked BDC spans without duplicating glyph text', () => {
    const doc = unicodeDocument(), content = new TextEncoder().encode(
      'BT /F1 12 Tf 1 0 0 1 40 650 Tm /Span << /ActualText <FEFF0915093F> >> BDC /P << /MCID 1 >> BDC (A) Tj EMC /Span << /ActualText <FEFF0042> >> BDC (C) Tj EMC EMC (D) Tj ET');
    const runs = interpretPage(content, doc.pages[0], doc.objects).textRuns;
    expect(runs.map(run => run.text).join('')).toBe('किD');
    expect(runs[0].glyphs.map(glyph => glyph.charCode)).toEqual([65, 67]);
  });
});
