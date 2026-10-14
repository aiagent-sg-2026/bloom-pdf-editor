import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { insertTextRun, applyTextEdits, prepareTextForExport, loadFontForName } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { parseCMap } from '../fonts/cmap-parser';
import { getStandardFontCharWidth } from '../fonts/standard14';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';
import { buildDocumentFlow } from '../flow';
import { applyLineTextEdit } from '../flow/flow-editor';
import { parsePDF, getPageContentBytes, resolveRef } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { saveQuick, saveOptimized } from '../writer/save-pipeline';
import { extractPagePlainText } from '../ai/compare';
import { PDFDict, PDFHexString, PDFStream } from '../types';
import { syntheticUnicodeFont, unicodeDocument } from './unicode-font-fixtures';

const cases = ['计算机科学', 'ABC 计算机科学 DEF', 'ABC 𠀀 DEF'];

describe('Unicode export through native saves', () => {
  for (const save of [saveQuick, saveOptimized]) {
    it.each(cases)(`${save.name} exports new text and reparses its Identity-H ToUnicode: %s`, async text => {
      const doc = await parsePDF(await serializeDocument(unicodeDocument())), page = doc.pages[0];
      await prepareTextForExport(doc.objects, [{ text }], syntheticUnicodeFont());
      const output = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects, text, 40, 650, 12, [0, 0, 0]);
      await updatePageContent(page.contentRefs, output, doc.objects);
      const reopened = await parsePDF(await save(doc));
      expect(extractPagePlainText(reopened, 0)).toBe(text);
      const runs = interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns;
      expect(runs.map(run => run.text).join('')).toBe(text);
      const fonts = reopened.pages[0].resources.get('Font') as PDFDict;
      const fontObject = [...fonts.values()].map(value => resolveRef(value, reopened.objects)).find(obj => obj instanceof PDFDict && obj.getName('Subtype') === 'Type0') as PDFDict;
      const cmapStream = resolveRef(fontObject.get('ToUnicode')!, reopened.objects) as PDFStream;
      const cmap = parseCMap(cmapStream.getBytes());
      const unicodeShows = parseContentStream(output).filter(inst => inst.operator === 'Tj' && inst.operands[0] instanceof PDFHexString);
      const mapped = unicodeShows.map(inst => {
        const bytes = (inst.operands[0] as PDFHexString).toBytes();
        let recovered = '';
        for (let i = 0; i < bytes.length; i += 2) recovered += cmap.toUnicode.get((bytes[i] << 8) | bytes[i + 1]);
        return recovered;
      }).join('');
      expect(mapped).toBe(text.includes('𠀀') ? '𠀀' : '计算机科学');
      if (text.startsWith('ABC')) {
        const suffix = runs.find(run => run.text === ' DEF')!;
        const latinAdvance = Array.from('ABC ').reduce((sum, ch) => sum + getStandardFontCharWidth('Helvetica', ch.charCodeAt(0)), 0);
        const unicodeAdvance = text.includes('𠀀') ? 1000 : 4800;
        expect(suffix.x).toBeCloseTo(40 + (latinAdvance + unicodeAdvance) * 12 / 1000, 6);
      }
    });
  }

  it('exports the committed Noto Chinese outlines through both save modes', async () => {
    const source = new Uint8Array(readFileSync(new URL('../../../public/fonts/NotoSansSC-Regular.ttf', import.meta.url)));
    for (const save of [saveQuick, saveOptimized]) {
      const doc = unicodeDocument(), page = doc.pages[0], text = 'ABC 计算机科学 DEF';
      await prepareTextForExport(doc.objects, [{ text }], source);
      await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, text, 40, 650, 12, [0, 0, 0]), doc.objects);
      expect(extractPagePlainText(await parsePDF(await save(doc)), 0)).toBe(text);
    }
  });

  it('registers the extended font graph for explicit incremental saves and preserves old CIDs', async () => {
    const doc = await parsePDF(await serializeDocument(unicodeDocument())), page = doc.pages[0], source = syntheticUnicodeFont();
    await prepareTextForExport(doc.objects, [{ text: '计' }], source);
    let bytes = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects, '计', 40, 650, 12, [0, 0, 0]);
    await updatePageContent(page.contentRefs, bytes, doc.objects);
    await saveQuick(doc, new Set(page.contentRefs.map(ref => ref.toKey())));
    await prepareTextForExport(doc.objects, [{ text: '机𠀀' }], source);
    bytes = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects, '机𠀀', 52, 650, 12, [0, 0, 0]);
    await updatePageContent(page.contentRefs, bytes, doc.objects);
    const saved = await saveQuick(doc, new Set(page.contentRefs.map(ref => ref.toKey())));
    const reopened = await parsePDF(saved);
    expect(interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns.map(run => run.text).join('')).toBe('计机𠀀');
    expect([...reopened.objects.values()].filter(obj => obj instanceof PDFDict && obj.getName('Subtype') === 'Type0')).toHaveLength(1);
  });

  it.each(['Tj', "'", '"'] as const)('rewrites existing %s text across fonts and restores the following Latin font', async operator => {
    const prefix = operator === '"' ? '0 0 ' : '';
    const content = `BT /F1 12 Tf 14 TL 1 0 0 1 40 700 Tm ${prefix}(old) ${operator} 1 0 0 rg (TAIL) Tj ET`;
    const doc = unicodeDocument(content), page = doc.pages[0], source = syntheticUnicodeFont();
    const bytes = getPageContentBytes(page, doc.objects), run = interpretPage(bytes, page, doc.objects).textRuns[0];
    expect(run.text).toBe('oldTAIL');
    // The interpreter merges both shows; edit only the original (old) operand.
    const glyphs = run.glyphs.slice(0, 3);
    const targetRun = {
      ...run, text: 'old', glyphs,
      width: glyphs[2].x + glyphs[2].width - glyphs[0].x,
      sourceInstructionIndices: [run.sourceInstructionIndices![0]],
    };
    const text = 'ABC 计算机科学 DEF';
    await prepareTextForExport(doc.objects, [{ text, fontData: loadFontForName(run.fontName, page, doc.objects) }], source);
    const edited = applyTextEdits(bytes, page, doc.objects, [{ targetRun, newText: text }]);
    await updatePageContent(page.contentRefs, edited.newContentBytes, doc.objects);
    const reopened = await parsePDF(await saveOptimized(doc));
    const runs = interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns;
    expect(extractPagePlainText(reopened, 0)).toBe(`${text}TAIL`);
    expect(runs.map(item => item.text).join('')).toBe(`${text}TAIL`);
    const cjk = runs.find(item => item.text === '计算机科学')!;
    const fonts = reopened.pages[0].resources.get('Font') as PDFDict;
    const embedded = resolveRef(fonts.get(cjk.fontName)!, reopened.objects) as PDFDict;
    expect(embedded.getName('Subtype')).toBe('Type0');
    expect(embedded.getName('Encoding')).toBe('Identity-H');
    const descendant = resolveRef(embedded.getArray('DescendantFonts')!.items[0], reopened.objects) as PDFDict;
    const descriptor = resolveRef(descendant.get('FontDescriptor')!, reopened.objects) as PDFDict;
    expect(resolveRef(descriptor.get('FontFile2')!, reopened.objects)).toBeInstanceOf(PDFStream);
    const suffix = runs.at(-1)!;
    expect(suffix.fontName).toBe('F1');
    // The final Latin replacement and untouched TAIL can also merge after saving.
    const tail = suffix.glyphs.slice(-4);
    expect(tail.map(glyph => glyph.unicode).join('')).toBe('TAIL');
    const latinAdvance = Array.from('ABC  DEF').reduce((sum, ch) => sum + getStandardFontCharWidth('Helvetica', ch.charCodeAt(0)), 0);
    expect(tail[0].x).toBeCloseTo(40 + (latinAdvance + 4800) * 12 / 1000, 6);
    expect(tail[0].y).toBeCloseTo(operator === 'Tj' ? 700 : 686, 6);
  });

  it('handles grouped existing operands without repeating text', async () => {
    const doc = unicodeDocument('BT /F1 12 Tf 1 0 0 1 40 700 Tm (o) Tj [(ld)] TJ ET'), page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects), runs = interpretPage(bytes, page, doc.objects).textRuns;
    const indices = parseContentStream(bytes).flatMap((inst, i) => ['Tj', 'TJ'].includes(inst.operator) ? [i] : []);
    await prepareTextForExport(doc.objects, [{ text: '计𠀀' }], syntheticUnicodeFont());
    const edited = applyTextEdits(bytes, page, doc.objects, [{ targetRun: { ...runs[0], text: 'old', sourceInstructionIndices: indices }, newText: '计𠀀' }]);
    await updatePageContent(page.contentRefs, edited.newContentBytes, doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveQuick(doc)), 0)).toBe('计𠀀');
  });

  it('uses Unicode widths instead of Latin estimates when shifting a following line segment', async () => {
    const doc = unicodeDocument('BT /F1 12 Tf 1 0 0 1 40 700 Tm (ABC) Tj /F1 12 Tf ( DEF) Tj ET'), page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects), original = interpretPage(bytes, page, doc.objects).textRuns;
    const flow = buildDocumentFlow(original), line = flow.lines[0];
    await prepareTextForExport(doc.objects, [{ text: '计算机科学 DEF' }], syntheticUnicodeFont());
    const result = applyLineTextEdit(bytes, page, doc.objects, line, '计算机科学 DEF', flow, { oldText: 'ABC DEF', caretAfter: 5 });
    const after = interpretPage(result.newContentBytes, page, doc.objects).textRuns;
    expect(after.map(run => run.text).join('')).toBe('计算机科学 DEF');
    const suffix = after.find(run => run.text.includes('DEF'))!;
    expect(suffix.x).toBeGreaterThanOrEqual(40 + 4800 * 12 / 1000 - 0.01);
  });

  it.each([false, true])('adds Latin to an already embedded Unicode run without a new load (inherited: %s)', async inherited => {
    const original = unicodeDocument(), source = syntheticUnicodeFont();
    await prepareTextForExport(original.objects, [{ text: '计' }], source);
    await updatePageContent(original.pages[0].contentRefs,
      insertTextRun(new Uint8Array(), original.pages[0], original.objects, '计', 40, 650, 12, [0, 0, 0]), original.objects);
    if (inherited) {
      (original.objects.get('2_0') as PDFDict).set('Resources', original.pages[0].resources);
      original.pages[0].dict.delete('Resources');
    }
    const doc = await parsePDF(await saveQuick(original)), page = doc.pages[0];
    const oldResources = page.resources;
    const bytes = getPageContentBytes(page, doc.objects), run = interpretPage(bytes, page, doc.objects).textRuns[0];
    await prepareTextForExport(doc.objects, [{ text: 'ABC 计 DEF', fontData: loadFontForName(run.fontName, page, doc.objects) }],
      async () => { throw new Error('Original Unicode glyph must not need a load'); });
    const edited = applyTextEdits(bytes, page, doc.objects, [{ targetRun: run, newText: 'ABC 计 DEF' }]);
    await updatePageContent(page.contentRefs, edited.newContentBytes, doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveOptimized(doc)), 0)).toBe('ABC 计 DEF');
    if (inherited) expect((oldResources.get('Font') as PDFDict).has('HelvAug')).toBe(false);
  });

  it('extends the same Type0 graph after saving and reopening with new Unicode scalars', async () => {
    const original = unicodeDocument(), source = syntheticUnicodeFont(), firstPage = original.pages[0];
    await prepareTextForExport(original.objects, [{ text: '计' }], source);
    await updatePageContent(firstPage.contentRefs, insertTextRun(new Uint8Array(), firstPage, original.objects, '计', 40, 650, 12, [0, 0, 0]), original.objects);
    const doc = await parsePDF(await saveQuick(original)), page = doc.pages[0];
    const fontKey = [...doc.objects].find(([, value]) => value instanceof PDFDict && value.getName('Subtype') === 'Type0')![0];
    await prepareTextForExport(doc.objects, [{ text: '机' }], source);
    await updatePageContent(page.contentRefs,
      insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects, '机', 52, 650, 12, [0, 0, 0]), doc.objects);
    const reopened = await parsePDF(await saveOptimized(doc));
    const type0Keys = [...reopened.objects].filter(([, value]) => value instanceof PDFDict && value.getName('Subtype') === 'Type0').map(([key]) => key);
    expect(type0Keys).toEqual([fontKey]);
    expect(extractPagePlainText(reopened, 0)).toBe('计机');
  });

  it('wraps CJK using actual advances and keeps the next explicit line below wrapped rows', async () => {
    const doc = unicodeDocument(), page = doc.pages[0];
    await prepareTextForExport(doc.objects, [{ text: '计算机科学' }], syntheticUnicodeFont());
    const bytes = insertTextRun(new Uint8Array(), page, doc.objects, '计算机科学\nDEF', 40, 650, 12, [0, 0, 0], { width: 25 });
    const runs = interpretPage(bytes, page, doc.objects).textRuns;
    expect(runs.map(run => run.text)).toEqual(['计算', '机科', '学', 'DEF']);
    expect(runs.map(run => run.y)).toEqual([650, 635.6, 621.2, 606.8]);
  });

  it('does not apply single-byte word spacing to Identity-H CID 32', async () => {
    const doc = unicodeDocument('BT 50 Tw ET'), page = doc.pages[0];
    const scalars = Array.from({ length: 33 }, (_, i) => 0x20000 + i);
    const source = syntheticUnicodeFont('both', false, 0, 32);
    await prepareTextForExport(doc.objects, [{ text: String.fromCodePoint(...scalars) }], source);
    const bytes = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects,
      `${String.fromCodePoint(scalars[31])}A`, 40, 650, 12, [0, 0, 0]);
    const runs = interpretPage(bytes, page, doc.objects).textRuns;
    expect(runs[0].glyphs[0].charCode).toBe(32);
    expect(runs[1].text).toBe('A'); expect(runs[1].x).toBeCloseTo(52, 6);
  });


  it('does not acquire a font for Latin text and preserves pending edits on unsupported scalars', async () => {
    const doc = unicodeDocument();
    await prepareTextForExport(doc.objects, [{ text: 'ABC café' }], async () => { throw new Error('Must not load'); });
    const before = await serializeDocument(doc);
    await expect(prepareTextForExport(doc.objects, [{ text: '计😀' }], syntheticUnicodeFont())).rejects.toBeInstanceOf(UnsupportedGlyphsError);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
