import { describe, expect, it } from 'vitest';
import { insertTextRun } from '../editor/text-editor';
import { createRGBAImageObjects } from '../editor/image-editor';
import { resolveRef } from '../parser/parser';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject, type PDFPageInfo } from '../types';

function page(): { page: PDFPageInfo; objects: Map<string, PDFObject> } {
  const dict = new PDFDict();
  const resources = new PDFDict();
  dict.set('Resources', resources);
  return {
    page: {
      index: 0, dict, resources, ref: new PDFRef(1, 0), contentRefs: [], rotate: 0,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 }, cropBox: { x: 0, y: 0, width: 612, height: 792 },
    },
    objects: new Map(),
  };
}

describe('object insertion exports', () => {
  it('uses WinAnsi, preserves newlines, and emits Standard-14 styling', () => {
    const p = page();
    const bytes = insertTextRun(new TextEncoder().encode(''), p.page, p.objects, 'café ü\nlineSecond', 10, 100, 12, [0, 0, 0], {
      fontFamily: 'Times New Roman', bold: true, italic: true, underline: true, opacity: 0.5, width: 120,
    });
    const source = new TextDecoder().decode(bytes);
    expect(source).toContain('/TimesBoldItalic');
    expect(source).toContain('caf');
    expect(source).toContain('1 0 0 1 10 85.6 Tm');
    expect(source).not.toContain('NaN');
    expect(source).not.toMatch(/\d m S/);
    expect(source).toMatch(/ET\n[\d.]+ w\n[\d.-]+ [\d.-]+ m [\d.-]+ [\d.-]+ l S/);
    const fonts = resolveRef(p.page.resources.get('Font')!, p.objects) as PDFDict;
    const fontRef = fonts.get('TimesBoldItalic')!;
    expect(fontRef).toBeInstanceOf(PDFRef);
    const font = resolveRef(fontRef, p.objects);
    expect(font).toBeInstanceOf(PDFDict);
    expect((font as PDFDict).getName('Encoding')).toBe('WinAnsiEncoding');
    const extGState = ((p.page.dict.get('Resources') as PDFDict).get('ExtGState') as PDFDict).get('TxGS') as PDFDict;
    expect(extGState.getNumber('ca')).toBe(0.5);
    expect(extGState.getNumber('CA')).toBe(0.5);
  });

  it('exports a new text box at the opacity selected before insertion', () => {
    const p = page();
    insertTextRun(new Uint8Array(), p.page, p.objects, '30 percent', 10, 100, 12, [0, 0, 0], { opacity: 0.3 });
    const extGState = ((p.page.dict.get('Resources') as PDFDict).get('ExtGState') as PDFDict).get('TxGS') as PDFDict;
    expect(extGState.getNumber('ca')).toBe(0.3);
  });

  it('creates indirect Flate RGB and alpha image streams', async () => {
    const p = page(); let n = 10;
    const result = await createRGBAImageObjects(new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255]), 2, 1, () => ++n);
    expect(result.image.dict.getName('Filter')).toBe('FlateDecode');
    expect(result.image.dict.get('SMask')).toEqual(result.smaskRef);
    expect(result.imageRef).toBeInstanceOf(PDFRef);
    expect(result.smaskRef).toBeInstanceOf(PDFRef);
    expect(result.image.rawBytes.length).toBeGreaterThan(0);
    expect(result.smask!.rawBytes.length).toBeGreaterThan(0);
  });

  it('keeps opaque PNGs as plain Flate RGB without a soft mask', async () => {
    let n = 10;
    const result = await createRGBAImageObjects(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1, () => ++n);
    expect(result.smaskRef).toBeNull();
    expect(result.smask).toBeNull();
    expect(result.image.dict.has('SMask')).toBe(false);
    expect(result.image.dict.getName('Filter')).toBe('FlateDecode');
  });
});
