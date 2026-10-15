import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractPagePlainText } from '../ai/compare';
import { interpretPage } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { applyTextEdits, insertTextRun, loadFontForName, prepareTextForExport } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { parseCMap } from '../fonts/cmap-parser';
import { SCRIPT_FONTS, scriptFontId, type ScriptFontId, type ScriptFontOptions } from '../fonts/script-fonts';
import { getStandardFontCharWidth } from '../fonts/standard14';
import { parseTTF, type TTFFont } from '../fonts/truetype-parser';
import { subsetTrueType } from '../fonts/ttf-subsetter';
import { UnsupportedGlyphsError } from '../fonts/unsupported-glyphs';
import { getPageContentBytes, parsePDF, resolveRef } from '../parser/parser';
import { PDFDict, PDFHexString, PDFName, PDFStream, type PDFDocumentData } from '../types';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';
import { syntheticUnicodeFont, unicodeDocument } from './unicode-font-fixtures';

const bytes: Partial<Record<ScriptFontId, Uint8Array>> = {};
const metrics: Partial<Record<ScriptFontId, TTFFont>> = {};
function fontBytes(id: ScriptFontId): Uint8Array {
  bytes[id] ??= new Uint8Array(readFileSync(new URL(`../../../public/fonts/${basename(SCRIPT_FONTS[id].assetPath)}`, import.meta.url)));
  return bytes[id]!;
}
function sources() {
  return {
    sc: vi.fn(async () => fontBytes('sc')), tc: vi.fn(async () => fontBytes('tc')),
    jp: vi.fn(async () => fontBytes('jp')), kr: vi.fn(async () => fontBytes('kr')),
    latin: vi.fn(async () => fontBytes('latin')),
  };
}
function embeddedFonts(doc: PDFDocumentData): Map<ScriptFontId, PDFDict> {
  const result = new Map<ScriptFontId, PDFDict>();
  const resources = resolveRef(doc.pages[0].resources.get('Font')!, doc.objects) as PDFDict;
  for (const value of resources.values()) {
    const font = resolveRef(value, doc.objects);
    if (!(font instanceof PDFDict) || font.getName('Subtype') !== 'Type0') continue;
    const id = scriptFontId(font.getName('BaseFont')!);
    expect(id).toBeDefined();
    expect(result.has(id!)).toBe(false);
    result.set(id!, font);
  }
  return result;
}

const cases: { text: string; ids: ScriptFontId[]; options?: ScriptFontOptions }[] = [
  { text: '電腦科學與工程', ids: ['tc'], options: { preferredHanFont: 'tc' } },
  { text: '计算机科学', ids: ['sc'] },
  { text: 'こんにちは世界カタカナ', ids: ['jp'] },
  { text: '안녕하세요 한국어', ids: ['kr'] },
  { text: 'Tiếng Việt: Nguyễn Thị Hồng Ánh', ids: ['latin'] },
  { text: 'Hello 你好 こんにちは 안녕하세요 Xin chào Việt Nam', ids: ['sc', 'jp', 'kr', 'latin'] },
];

describe('multi-script Unicode export', () => {
  for (const save of [saveQuick, saveOptimized]) {
    it.each(cases)(`${save.name} embeds only needed fonts and round trips $text`, async ({ text, ids, options }) => {
      const doc = unicodeDocument(), page = doc.pages[0], loaders = sources();
      // Existing resources must survive multiple Unicode resource allocations.
      const resources = page.resources.get('Font') as PDFDict;
      const occupied = resources.get('F1')!;
      resources.set('UnicodeAug', occupied); resources.set('UnicodeAug1', occupied);
      await prepareTextForExport(doc.objects, [{ text }], loaders, options);
      const content = insertTextRun(new Uint8Array(), page, doc.objects, text, 40, 650, 12, [0, 0, 0]);
      await updatePageContent(page.contentRefs, content, doc.objects);
      const reopened = await parsePDF(await save(doc));
      expect(extractPagePlainText(reopened, 0)).toBe(text);
      const graphs = embeddedFonts(reopened);
      expect([...graphs.keys()].sort()).toEqual([...ids].sort());
      for (const id of Object.keys(loaders) as (keyof typeof loaders)[]) {
        expect(loaders[id]).toHaveBeenCalledTimes(ids.includes(id) ? 1 : 0);
      }
      for (const [id, font] of graphs) {
        expect(font.getName('BaseFont')).toMatch(new RegExp(`^[A-Z]{6}\\+${SCRIPT_FONTS[id].baseFont}$`));
        expect(font.getName('Encoding')).toBe('Identity-H');
        const descendant = resolveRef(font.getArray('DescendantFonts')!.items[0], reopened.objects) as PDFDict;
        expect(descendant.getName('Subtype')).toBe('CIDFontType2');
        const descriptor = resolveRef(descendant.get('FontDescriptor')!, reopened.objects) as PDFDict;
        expect(resolveRef(descriptor.get('FontFile2')!, reopened.objects)).toBeInstanceOf(PDFStream);
        expect(resolveRef(descendant.get('CIDToGIDMap')!, reopened.objects)).toBeInstanceOf(PDFStream);
        const unicode = resolveRef(font.get('ToUnicode')!, reopened.objects) as PDFStream;
        const mappings = parseCMap(unicode.getBytes());
        for (const scalar of mappings.toUnicode.values()) expect(text).toContain(scalar);
      }
      const fonts = reopened.pages[0].resources.get('Font') as PDFDict;
      for (const name of ['UnicodeAug', 'UnicodeAug1', 'Helv']) {
        expect((resolveRef(fonts.get(name)!, reopened.objects) as PDFDict).getName('Subtype')).toBe('Type1');
      }
      // Independent source hmtx metrics must match both graph advances and positions.
      const runs = interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns;
      let x = 40;
      for (const run of runs) {
        expect(run.x).toBeCloseTo(x, 6);
        const font = resolveRef(fonts.get(run.fontName)!, reopened.objects) as PDFDict;
        const id = scriptFontId(font.getName('BaseFont')!);
        for (const glyph of run.glyphs) {
          const cp = glyph.unicode.codePointAt(0)!;
          let advance: number;
          if (id) {
            metrics[id] ??= parseTTF(fontBytes(id));
            const source = metrics[id]!;
            advance = source.advanceWidths[source.cmapEntries.get(cp)!] / source.unitsPerEm * 12;
          } else advance = getStandardFontCharWidth('Helvetica', cp) / 1000 * 12;
          expect(glyph.x).toBeCloseTo(x, 6);
          expect(glyph.width).toBeCloseTo(advance, 6);
          x += advance;
        }
      }
      const instructions = parseContentStream(content);
      expect(instructions.filter(inst => inst.operator === 'BT')).toHaveLength(1);
      expect(instructions.filter(inst => inst.operator === 'ET')).toHaveLength(1);
      // Decode each two-byte operand with its active font, not another font's CIDs.
      let active = '', decoded = '';
      for (const inst of instructions) {
        if (inst.operator === 'Tf') active = (inst.operands[0] as PDFName).name;
        if (inst.operator !== 'Tj' || !(inst.operands[0] instanceof PDFHexString)) continue;
        const font = resolveRef(fonts.get(active)!, reopened.objects) as PDFDict;
        const unicode = resolveRef(font.get('ToUnicode')!, reopened.objects) as PDFStream;
        const cmap = parseCMap(unicode.getBytes()), codes = inst.operands[0].toBytes();
        for (let i = 0; i < codes.length; i += 2) decoded += cmap.toUnicode.get((codes[i] << 8) | codes[i + 1]);
      }
      const embeddedText = runs.filter(run => scriptFontId((resolveRef(fonts.get(run.fontName)!, reopened.objects) as PDFDict).getName('BaseFont')!))
        .map(run => run.text).join('');
      expect(decoded).toBe(embeddedText);
      if (ids.length > 1) {
        const keys = instructions.filter(inst => inst.operator === 'Tf').map(inst => (inst.operands[0] as PDFName).name);
        expect(new Set(keys).size).toBe(ids.length + 1);
      }
    });
  }

  it.each(['العربية', 'עברית', '😀'])('rejects unsupported scripts with exact characters and no PDF mutations: %s', async text => {
    const doc = unicodeDocument(), before = await serializeDocument(doc);
    await expect(prepareTextForExport(doc.objects, [{ text }], sources())).rejects.toMatchObject({
      name: 'UnsupportedGlyphsError', characters: [...new Set(Array.from(text))],
      codePoints: [...new Set(Array.from(text, ch => ch.codePointAt(0)!))],
    });
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('keeps every graph unpublished when a required font cannot load', async () => {
    const doc = unicodeDocument(), before = await serializeDocument(doc), loaders = sources();
    loaders.kr.mockRejectedValueOnce(new Error('offline'));
    await expect(prepareTextForExport(doc.objects, [{ text: '你好 안녕하세요' }], loaders)).rejects.toBeInstanceOf(UnsupportedGlyphsError);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('exports a Han scalar through the next cmap without loading unused fonts', async () => {
    const doc = unicodeDocument(), page = doc.pages[0], complete = syntheticUnicodeFont();
    const sc = vi.fn(async () => subsetTrueType(complete, [0x8ba1]).data);
    const tc = vi.fn(async () => complete);
    const unused = vi.fn(async (): Promise<Uint8Array> => { throw new Error('Unused font'); });
    await prepareTextForExport(doc.objects, [{ text: '计机' }], { sc, tc, jp: unused, kr: unused, latin: unused });
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, '计机', 40, 650, 12, [0, 0, 0]), doc.objects);
    const reopened = await parsePDF(await saveQuick(doc));
    expect(extractPagePlainText(reopened, 0)).toBe('计机');
    expect([...embeddedFonts(reopened).keys()].sort()).toEqual(['sc', 'tc']);
    expect(sc).toHaveBeenCalledTimes(1); expect(tc).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'tc' as const, original: '電', replacement: '電腦' },
    { id: 'jp' as const, original: 'こ', replacement: 'こんにちは世界' },
    { id: 'kr' as const, original: '안', replacement: '안녕하세요' },
    { id: 'latin' as const, original: 'ệ', replacement: 'ệễ' },
  ])('extends the reopened $id graph while editing and retains old CID assignments', async ({ id, original, replacement }) => {
    const doc = unicodeDocument(), loaders = sources(), options = id === 'latin' ? {} : { preferredHanFont: id };
    await prepareTextForExport(doc.objects, [{ text: original }], loaders, options);
    await updatePageContent(doc.pages[0].contentRefs,
      insertTextRun(new Uint8Array(), doc.pages[0], doc.objects, original, 40, 650, 12, [0, 0, 0]), doc.objects);
    const reopened = await parsePDF(await saveQuick(doc)), page = reopened.pages[0];
    const oldGraph = embeddedFonts(reopened).get(id)!;
    const oldKey = [...reopened.objects].find(([, value]) => value === oldGraph)![0];
    const oldMappings = parseCMap((resolveRef(oldGraph.get('ToUnicode')!, reopened.objects) as PDFStream).getBytes()).toUnicode;
    const content = getPageContentBytes(page, reopened.objects), targetRun = interpretPage(content, page, reopened.objects).textRuns[0];
    await prepareTextForExport(reopened.objects, [{ text: replacement, fontData: loadFontForName(targetRun.fontName, page, reopened.objects) }], loaders);
    const result = applyTextEdits(content, page, reopened.objects, [{ targetRun, newText: replacement }]);
    await updatePageContent(page.contentRefs, result.newContentBytes, reopened.objects);
    const saved = await parsePDF(await saveOptimized(reopened));
    expect(extractPagePlainText(saved, 0)).toBe(replacement);
    const graph = embeddedFonts(saved).get(id)!;
    // Object numbers survive quick saves; optimized saves may renumber them.
    expect((reopened.objects.get(oldKey) as PDFDict).getName('BaseFont')).toBe(oldGraph.getName('BaseFont'));
    expect(graph.getName('BaseFont')).toBe(oldGraph.getName('BaseFont'));
    const mappings = parseCMap((resolveRef(graph.get('ToUnicode')!, saved.objects) as PDFStream).getBytes()).toUnicode;
    for (const [cid, scalar] of oldMappings) expect(mappings.get(cid)).toBe(scalar);
    expect([...embeddedFonts(saved).keys()]).toEqual([id]);
  });

  it('extends JP coverage for Han previously prepared in SC when kana context changes', async () => {
    const doc = unicodeDocument(), page = doc.pages[0], loaders = sources();
    await prepareTextForExport(doc.objects, [{ text: '世界' }, { text: 'こ' }], loaders);
    const text = '世界 こんにちは世界';
    await prepareTextForExport(doc.objects, [{ text }], loaders);
    const content = insertTextRun(new Uint8Array(), page, doc.objects, text, 40, 650, 12, [0, 0, 0]);
    const runs = interpretPage(content, page, doc.objects).textRuns;
    const fonts = page.resources.get('Font') as PDFDict;
    expect(runs.map(run => ({
      text: run.text,
      id: scriptFontId((resolveRef(fonts.get(run.fontName)!, doc.objects) as PDFDict).getName('BaseFont')!),
    }))).toEqual([{ text: '世界', id: 'sc' }, { text: ' ', id: undefined }, { text: 'こんにちは世界', id: 'jp' }]);
    await updatePageContent(page.contentRefs, content, doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveQuick(doc)), 0)).toBe(text);
    expect(loaders.sc).toHaveBeenCalledTimes(1); expect(loaders.jp).toHaveBeenCalledTimes(1);
  });

  it('preserves decomposed Vietnamese text rather than normalizing Unicode', async () => {
    const doc = unicodeDocument(), page = doc.pages[0], text = 'Vie\u0323\u0302t Nam';
    await prepareTextForExport(doc.objects, [{ text }], sources());
    await updatePageContent(page.contentRefs, insertTextRun(new Uint8Array(), page, doc.objects, text, 40, 650, 12, [0, 0, 0]), doc.objects);
    expect(extractPagePlainText(await parsePDF(await saveQuick(doc)), 0)).toBe(text);
  });
});
