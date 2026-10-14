import { describe, expect, it } from 'vitest';
import { ensureFallbackFont } from '../fonts/font-augmentation';
import { ensureBuiltInFallbackFont } from '../fonts/symbol-fallback';
import { insertTextRun } from '../editor/text-editor';
import { insertInvisibleTextLayer } from '../editor/invisible-text';
import { createAnnotationDict, addAnnotationToPage, type Annotation } from '../editor/annotation-engine';
import { applyStyleToSelection } from '../flow/style-edit';
import { buildDocumentFlow } from '../flow';
import { interpretPage } from '../content/interpreter';
import { AppearanceResourceManager, serializeAppearanceStream } from '../signatures/fields/appearance-stream';
import { ensureAcroFormCatalog } from '../signatures/fields/signature-field';
import { getPageContentBytes, parsePDF, resolveRef } from '../parser/parser';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { saveQuick, saveOptimized } from '../writer/save-pipeline';
import { saveQuick as saveQuickWorker } from '../worker/client';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { unicodeDocument } from './unicode-font-fixtures';

function expectIndirectFonts(resources: PDFDict, doc: PDFDocumentData, expected: Record<string, string>) {
  const fonts = resolveRef(resources.get('Font')!, doc.objects) as PDFDict;
  for (const [name, baseFont] of Object.entries(expected)) {
    const ref = fonts.get(name);
    expect(ref).toBeInstanceOf(PDFRef);
    const font = resolveRef(ref!, doc.objects);
    expect(font).toBeInstanceOf(PDFDict);
    expect((font as PDFDict).getName('Type')).toBe('Font');
    expect((font as PDFDict).getName('BaseFont')).toBe(baseFont);
  }
}

const styles = [{}, { bold: true }, { italic: true }, { bold: true, italic: true }];
const fallbackFonts = {
  HelvAug: 'Helvetica', HelvAugBold: 'Helvetica-Bold',
  HelvAugOblique: 'Helvetica-Oblique', HelvAugBoldOblique: 'Helvetica-BoldOblique',
  SymAug: 'Symbol', DingAug: 'ZapfDingbats',
};

describe('indirect editor font resources', () => {
  for (const save of [saveQuick, saveOptimized]) {
    it(`${save.name} preserves references for all augmented and inserted Standard 14 fonts`, async () => {
      const doc = unicodeDocument(), page = doc.pages[0];
      for (const style of styles) ensureFallbackFont(page, doc.objects, style);
      ensureBuiltInFallbackFont(page, doc.objects, 'Symbol');
      ensureBuiltInFallbackFont(page, doc.objects, 'ZapfDingbats');
      let bytes: Uint8Array = new Uint8Array();
      const expected: Record<string, string> = { ...fallbackFonts };
      for (const fontFamily of ['Helvetica', 'Times', 'Courier']) {
        for (const style of styles) {
          bytes = insertTextRun(bytes, page, doc.objects, 'ABC', 40, 650, 12, [0, 0, 0], { fontFamily, ...style });
          const baseFont = fontFamily === 'Times'
            ? (style.bold && style.italic ? 'Times-BoldItalic' : style.bold ? 'Times-Bold' : style.italic ? 'Times-Italic' : 'Times-Roman')
            : `${fontFamily}${style.bold && style.italic ? '-BoldOblique' : style.bold ? '-Bold' : style.italic ? '-Oblique' : ''}`;
          expected[baseFont === 'Helvetica' ? 'Helv' : baseFont.replace(/[^A-Za-z]/g, '')] = baseFont;
        }
      }
      await updatePageContent(page.contentRefs, bytes, doc.objects);
      expectIndirectFonts(page.resources, doc, expected);
      const reopened = await parsePDF(await save(doc));
      expectIndirectFonts(reopened.pages[0].resources, reopened, expected);
    });
  }

  for (const save of [saveQuick, saveQuickWorker]) {
    it(`${save === saveQuick ? 'direct' : 'worker bridge'} incremental save includes newly indirect fonts`, async () => {
      const doc = await parsePDF(await serializeDocument(unicodeDocument())), page = doc.pages[0];
      const bytes = insertTextRun(getPageContentBytes(page, doc.objects), page, doc.objects, 'ABC', 40, 650, 12, [0, 0, 0]);
      ensureFallbackFont(page, doc.objects, { bold: true });
      await updatePageContent(page.contentRefs, bytes, doc.objects);
      const reopened = await parsePDF(await save(doc, new Set([page.ref.toKey(), ...page.contentRefs.map(ref => ref.toKey())])));
      expectIndirectFonts(reopened.pages[0].resources, reopened, { Helv: 'Helvetica', HelvAugBold: 'Helvetica-Bold' });
    });
  }

  it('keeps OCR and style-created fonts indirect after saving', async () => {
    const doc = unicodeDocument('BT /F1 12 Tf 40 650 Td (ABC) Tj ET'), page = doc.pages[0];
    await insertInvisibleTextLayer(doc, 0, [{ text: 'OCR', bbox: { x: 40, y: 600, width: 30, height: 12 } }]);
    const bytes = getPageContentBytes(page, doc.objects);
    const line = buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns).lines[0];
    const result = applyStyleToSelection(bytes, page, doc.objects, line, 0, line.text.length, { fontFamily: 'Courier', bold: true });
    await updatePageContent(page.contentRefs, result.newContentBytes, doc.objects);
    expectIndirectFonts(page.resources, doc, { Helv: 'Helvetica', CourierBold: 'Courier-Bold' });
    const reopened = await parsePDF(await saveOptimized(doc));
    expectIndirectFonts(reopened.pages[0].resources, reopened, { Helv: 'Helvetica', CourierBold: 'Courier-Bold' });
  });

  it('stores annotation and signature appearance fonts as resolvable indirect objects', async () => {
    const doc = unicodeDocument(), page = doc.pages[0];
    const common = { rect: { x: 40, y: 600, width: 120, height: 40 }, color: [0, 0, 0] as [number, number, number], opacity: 1 };
    const annotations: Annotation[] = [
      { ...common, type: 'FreeText', text: 'ABC', fontSize: 12, fontName: 'Helvetica', textColor: [0, 0, 0], borderWidth: 0 },
      { ...common, type: 'Stamp', stampName: 'Approved' },
    ];
    for (const annotation of annotations) {
      const objNum = getNextObjNum(doc);
      const { dict, appearanceStream } = createAnnotationDict(annotation, objNum, doc.objects);
      addAnnotationToPage(page.dict, dict, new PDFRef(objNum, 0), doc.objects);
      expectIndirectFonts(appearanceStream!.dict.get('Resources') as PDFDict, doc, { Helv: 'Helvetica' });
    }
    const manager = new AppearanceResourceManager();
    manager.ensureType1Font('Helvetica');
    const appearance = serializeAppearanceStream(doc, 'BT /Helv 12 Tf (ABC) Tj ET', common.rect, manager);
    page.resources.set('XObject', new PDFDict([['SignatureAppearance', appearance.streamRef]]));
    const acro = ensureAcroFormCatalog(doc);
    expectIndirectFonts(acro.get('DR') as PDFDict, doc, { Helv: 'Helvetica' });
    const reopened = await parsePDF(await saveOptimized(doc));
    const annots = reopened.pages[0].dict.getArray('Annots')!;
    for (const ref of annots.items) {
      const annot = resolveRef(ref, reopened.objects) as PDFDict;
      const ap = resolveRef(annot.get('AP')!, reopened.objects) as PDFDict;
      const stream = resolveRef(ap.get('N')!, reopened.objects) as PDFStream;
      expectIndirectFonts(stream.dict.get('Resources') as PDFDict, reopened, { Helv: 'Helvetica' });
    }
    const xobjects = reopened.pages[0].resources.get('XObject') as PDFDict;
    const stream = resolveRef(xobjects.get('SignatureAppearance')!, reopened.objects) as PDFStream;
    expectIndirectFonts(stream.dict.get('Resources') as PDFDict, reopened, { Helv: 'Helvetica' });
    const reopenedAcro = resolveRef(reopened.catalog.get('AcroForm')!, reopened.objects) as PDFDict;
    expectIndirectFonts(reopenedAcro.get('DR') as PDFDict, reopened, { Helv: 'Helvetica' });
  });
});
