import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interpretPage, type ImageItem } from '../content/interpreter';
import { replaceImageXObject } from '../editor/image-editor';
import { applyFilters } from '../parser/filters';
import { getPageContentBytes, getResource, parsePDF, resolveRef } from '../parser/parser';
import { decodeImage } from '../render/image-decoder';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { getNextObjNum } from '../writer/serializer';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { installPNGEnvironment, rawPDF, tinyJPEG, tinyPNG } from './audit-p1-fixtures';

const originalPixels = [10, 20, 30, 255];
const replacementPixels = [201, 102, 53, 255, 17, 99, 231, 255];

async function fixture(mode: 'pages-and-names' | 'form' | 'shared-resources' | 'inherited-resources' | 'single' = 'pages-and-names'): Promise<PDFDocumentData> {
  const shared = mode === 'shared-resources' || mode === 'inherited-resources';
  const ownResources = mode === 'inherited-resources' ? '' : shared ? '/Resources 10 0 R' : '/Resources << /XObject << /Edit 7 0 R /Alias 7 0 R /Fm 9 0 R >> >>';
  const firstContent = mode === 'pages-and-names' ? '/Edit Do /Alias Do' : '/Edit Do';
  const secondContent = shared ? '/Edit Do' : '/Original Do';
  const stream = (content: string) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 ${mode === 'inherited-resources' ? '/Resources 10 0 R' : ''} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${ownResources} /Contents 5 0 R >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${shared ? ownResources : '/Resources << /XObject << /Original 7 0 R >> >>'} /Contents 6 0 R >>`,
    stream(firstContent), stream(secondContent),
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n${String.fromCharCode(10, 20, 30)}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x40\nendstream',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Nested 7 0 R >> >> /Length 10 >>\nstream\n/Nested Do\nendstream',
    '<< /XObject << /Edit 7 0 R >> >>',
  ]));
  if (mode === 'single' || mode === 'form') {
    doc.pages[0].resources = new PDFDict([['XObject', new PDFDict([['Edit', new PDFRef(7, 0)]])]]);
    doc.pages[0].dict.set('Resources', doc.pages[0].resources);
    doc.pages[1].resources = new PDFDict();
    doc.pages[1].dict.set('Resources', doc.pages[1].resources);
    // Keep the form only when its resource entry is a second image use.
    if (mode === 'single') doc.objects.delete('9_0');
  }
  return doc;
}

function editedImage(doc: PDFDocumentData): ImageItem {
  const page = doc.pages[0];
  const item = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList.find(item => item.type === 'image' && item.name === 'Edit');
  if (!item || item.type !== 'image') throw new Error('Synthetic edited image missing');
  return item;
}

async function pixels(doc: PDFDocumentData, resources: PDFDict, name: string): Promise<number[]> {
  const image = getResource(resources, 'XObject', name, doc.objects);
  if (!(image instanceof PDFStream)) throw new Error(`Synthetic /${name} missing`);
  image.decodedBytes = await applyFilters(image.rawBytes, image.getFilters(), image.getDecodeParams());
  const decoded = await decodeImage(image, doc.objects);
  if (!decoded) throw new Error(`Synthetic /${name} did not decode`);
  return Array.from(decoded.data);
}

beforeEach(installPNGEnvironment);
afterEach(() => vi.unstubAllGlobals());

describe('image replacement isolation (P1-B)', () => {
  for (const save of [saveQuick, saveOptimized]) {
    it(`${save.name} changes only one resource name across two pages`, async () => {
      const doc = await fixture();
      await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
      const reopened = await parsePDF(await save(doc));
      expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(replacementPixels);
      expect(await pixels(reopened, reopened.pages[0].resources, 'Alias')).toEqual(originalPixels);
      expect(await pixels(reopened, reopened.pages[1].resources, 'Original')).toEqual(originalPixels);
    });
  }

  it.each(['shared-resources', 'inherited-resources'] as const)('does not repoint a sibling page sharing %s', async mode => {
    const doc = await fixture(mode);
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
    const reopened = await parsePDF(await saveQuick(doc));
    expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(replacementPixels);
    expect(await pixels(reopened, reopened.pages[1].resources, 'Edit')).toEqual(originalPixels);
  });

  it('preserves the original image referenced only by another form XObject', async () => {
    const doc = await fixture('form');
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
    const form = doc.objects.get('9_0') as PDFStream;
    expect(await pixels(doc, resolveRef(form.dict.get('Resources')!, doc.objects) as PDFDict, 'Nested')).toEqual(originalPixels);
    expect(await pixels(doc, doc.pages[0].resources, 'Edit')).toEqual(replacementPixels);
  });

  it('keeps a single-use stream and indirect reference in place', async () => {
    const doc = await fixture('single');
    const original = doc.objects.get('7_0');
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
    expect(doc.objects.get('7_0')).toBe(original);
    expect((resolveRef(doc.pages[0].resources.get('XObject')!, doc.objects) as PDFDict).getRef('Edit')?.toKey()).toBe('7_0');
    expect(await pixels(doc, doc.pages[0].resources, 'Edit')).toEqual(replacementPixels);
  });

  it('allocates replacement objects without an optional allocator', async () => {
    const doc = await fixture();
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels));
    const reopened = await parsePDF(await saveQuick(doc));
    expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(replacementPixels);
    expect(await pixels(reopened, reopened.pages[1].resources, 'Original')).toEqual(originalPixels);
  });

  it('keeps an alpha image and its mask in distinct objects when cloning', async () => {
    const doc = await fixture();
    const expected = [201, 102, 53, 73, 17, 99, 231, 255];
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(expected), () => getNextObjNum(doc));
    const replaced = getResource(doc.pages[0].resources, 'XObject', 'Edit', doc.objects) as PDFStream;
    const xobjects = resolveRef(doc.pages[0].resources.get('XObject')!, doc.objects) as PDFDict;
    expect(replaced.dict.getRef('SMask')?.toKey()).not.toBe(xobjects.getRef('Edit')?.toKey());
    const reopened = await parsePDF(await saveQuick(doc));
    expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(expected);
    expect(await pixels(reopened, reopened.pages[0].resources, 'Alias')).toEqual(originalPixels);
    expect(await pixels(reopened, reopened.pages[1].resources, 'Original')).toEqual(originalPixels);
  });
});

describe('in-session image replacement', () => {
  it('decodes new RGB and alpha on the same object after JPEG and repeated PNG replacements', async () => {
    const doc = await fixture('single');
    const image = doc.objects.get('7_0') as PDFStream;
    image.rawBytes = tinyJPEG();
    image.decodedBytes = null;
    image.dict.set('Filter', new PDFName('DCTDecode'));
    image.dict.set('Length', new PDFNumber(image.rawBytes.length));

    for (const expected of [
      [220, 30, 30, 255, 0, 0, 0, 0],
      [30, 180, 70, 255, 0, 0, 0, 0],
    ]) {
      await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(expected), () => getNextObjNum(doc));
      const replaced = getResource(doc.pages[0].resources, 'XObject', 'Edit', doc.objects) as PDFStream;
      expect(replaced).toBe(image);
      // Decode the live streams without saving, reopening, or repairing decodedBytes.
      for (let pass = 0; pass < 2; pass++) {
        const decoded = await decodeImage(replaced, doc.objects);
        expect(decoded).toMatchObject({ width: 2, height: 1 });
        expect(Array.from(decoded!.data)).toEqual(expected);
      }
    }
  });
});

describe('PNG replacement dictionaries (P1-C)', () => {
  it.each([255, 73])('replaces JPEG and obsolete masks/decoding keys with new alpha=%i', async alpha => {
    const doc = await fixture('single');
    const image = doc.objects.get('7_0') as PDFStream;
    image.rawBytes = tinyJPEG();
    image.decodedBytes = null;
    image.dict.set('Length', new PDFNumber(image.rawBytes.length));
    image.dict.set('Filter', new PDFName('DCTDecode'));
    image.dict.set('SMask', new PDFRef(8, 0));
    image.dict.set('Mask', new PDFRef(8, 0));
    image.dict.set('Decode', new PDFArray([1, 0, 1, 0, 1, 0].map(value => new PDFNumber(value))));
    image.dict.set('DecodeParms', new PDFDict([['ColorTransform', new PDFNumber(0)], ['Predictor', new PDFNumber(15)]]));
    image.dict.set('Matte', new PDFArray([new PDFNumber(1), new PDFNumber(0), new PDFNumber(0)]));
    image.dict.set('Intent', new PDFName('AbsoluteColorimetric'));
    image.dict.set('ImageMask', new PDFBoolean(true));
    image.dict.set('F', new PDFName('obsolete-file'));
    image.dict.set('FFilter', new PDFName('DCTDecode'));
    image.dict.set('FDecodeParms', new PDFDict([['ColorTransform', new PDFNumber(0)]]));
    const expected = [201, 102, 53, alpha, 17, 99, 231, 255];
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(expected), () => getNextObjNum(doc));
    const replaced = getResource(doc.pages[0].resources, 'XObject', 'Edit', doc.objects) as PDFStream;
    const validKeys = ['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'Length'];
    if (alpha !== 255) validKeys.push('SMask');
    expect([...replaced.dict.keys()].sort()).toEqual(validKeys.sort());
    if (alpha !== 255) expect(replaced.dict.getRef('SMask')?.toKey()).not.toBe('8_0');
    for (const save of [saveQuick, saveOptimized]) {
      const reopened = await parsePDF(await save(doc));
      expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(expected);
    }
  });
});
