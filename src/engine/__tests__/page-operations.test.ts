import { describe, expect, it } from 'vitest';
import { deletePage } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { canvasToPdf, pdfToCanvas } from '../editing/coordinates';

function syntheticDocument(): PDFDocumentData {
  const objects = new Map<string, import('../types').PDFObject>();
  const pagesRef = new PDFRef(1, 0);
  const catalogRef = new PDFRef(8, 0);
  const pagesRoot = new PDFDict();
  pagesRoot.set('Type', new PDFName('Pages'));
  const pageRefs = [2, 3, 4].map((n) => new PDFRef(n, 0));
  pagesRoot.set('Kids', new PDFArray(pageRefs));
  pagesRoot.set('Count', new PDFNumber(3));
  objects.set(pagesRef.toKey(), pagesRoot);

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', pagesRef);
  const outline = new PDFDict();
  outline.set('Title', new PDFName('Section-1'));
  outline.set('Dest', new PDFArray([pageRefs[0], new PDFName('Fit')]));
  objects.set('30_0', outline);
  catalog.set('Outlines', new PDFRef(30, 0));
  objects.set(catalogRef.toKey(), catalog);

  pageRefs.forEach((ref, index) => {
    const contentRef = new PDFRef(10 + index, 0);
    const page = new PDFDict();
    page.set('Type', new PDFName('Page'));
    page.set('Parent', pagesRef);
    page.set('MediaBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792)]));
    page.set('Contents', contentRef);
    objects.set(ref.toKey(), page);
    const bytes = new TextEncoder().encode(index === 0 ? 'ONLY_PAGE_ONE_SECRET' : `PAGE_${index + 1}`);
    const streamDict = new PDFDict();
    streamDict.set('Length', new PDFNumber(bytes.length));
    objects.set(contentRef.toKey(), new PDFStream(streamDict, bytes, bytes));
  });

  const link = new PDFDict();
  link.set('Type', new PDFName('Annot'));
  link.set('Subtype', new PDFName('Link'));
  link.set('Dest', new PDFArray([pageRefs[0], new PDFName('Fit')]));
  objects.set('40_0', link);
  (objects.get('3_0') as PDFDict).set('Annots', new PDFArray([new PDFRef(40, 0)]));

  return {
    version: '1.7', objects, catalog,
    pages: pageRefs.map((ref, index) => ({
      index, dict: objects.get(ref.toKey()) as PDFDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0, ref,
      resources: new PDFDict(), contentRefs: [new PDFRef(10 + index, 0)],
    })),
    xref: { entries: new Map(), trailerDict: new PDFDict([['Root', catalogRef]]) },
    info: {}, rawBytes: new Uint8Array(),
  };
}

describe('page deletion privacy', () => {
  it('removes deleted destinations and unreachable page streams from a full export', async () => {
    const doc = syntheticDocument();
    deletePage(doc, 0);
    const bytes = await serializeDocument(doc);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('ONLY_PAGE_ONE_SECRET');
    expect(doc.catalog.get('Outlines')).toBeUndefined();
    expect((doc.pages[0].dict.get('Annots'))).toBeUndefined();
  });
});

describe('rotated/cropped viewport coordinates', () => {
  it.each([0, 90, 180, 270])('round-trips rotation %i with a CropBox offset', (rotation) => {
    const transform = { scale: 2, rotation, pageWidth: 540, pageHeight: 720, pageX: 36, pageY: 36 };
    const source = { x: 120, y: 240 };
    const canvas = pdfToCanvas(source.x, source.y, transform);
    expect(canvasToPdf(canvas.x, canvas.y, transform)).toEqual(source);
  });
});
