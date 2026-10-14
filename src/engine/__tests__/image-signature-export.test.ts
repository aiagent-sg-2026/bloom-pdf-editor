import { describe, expect, it, afterEach } from 'vitest';
import { insertImageRun } from '../editor/image-editor';
import { PDFDict, PDFName, PDFNumber, PDFRef, type PDFObject, type PDFPageInfo } from '../types';

class MockImage {
  naturalWidth = 20;
  naturalHeight = 10;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { this.onload?.(); }
}

const originalImage = globalThis.Image;

function makePage(resources = new PDFDict()): { page: PDFPageInfo; objects: Map<string, PDFObject> } {
  const dict = new PDFDict();
  dict.set('Resources', resources);
  return {
    page: {
      index: 0, dict, resources, ref: new PDFRef(1, 0), contentRefs: [], rotate: 0,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 }, cropBox: { x: 0, y: 0, width: 612, height: 792 },
    },
    objects: new Map(),
  };
}

async function insert(p: ReturnType<typeof makePage>, options?: { rotationDegrees?: number; opacity?: number }) {
  return insertImageRun(new Uint8Array(), p.page, p.objects, 'data:image/jpeg;base64,AA==', 10, 70, 60, 40, () => 10, options);
}

describe('signature image export transforms', () => {
  afterEach(() => { globalThis.Image = originalImage; });

  it('keeps the rotation-zero content stream byte-identical', async () => {
    globalThis.Image = MockImage as unknown as typeof Image;
    const withoutOptions = makePage();
    const withOptions = makePage();
    const a = await insert(withoutOptions);
    const b = await insert(withOptions, { rotationDegrees: 0, opacity: 1 });
    expect(Array.from(b.newContentBytes)).toEqual(Array.from(a.newContentBytes));
    expect(new TextDecoder().decode(b.newContentBytes)).toBe('\nq\n60 0 0 40 10 30 cm\n/Im1 Do\nQ\n');
  });

  it.each([
    [90, '1 0 0 1 40 50 cm\n0 1 -1 0 0 0 cm\n1 0 0 1 -40 -50 cm'],
    [30, '1 0 0 1 40 50 cm\n0.8660254038 0.5 -0.5 0.8660254038 0 0 cm\n1 0 0 1 -40 -50 cm'],
  ])('emits the expected center rotation matrix for %i degrees', async (degrees, expected) => {
    globalThis.Image = MockImage as unknown as typeof Image;
    const p = makePage();
    const result = await insert(p, { rotationDegrees: degrees });
    expect(new TextDecoder().decode(result.newContentBytes)).toContain(`${expected}\n60 0 0 40 10 30 cm`);
  });

  it('adds opacity without clobbering an indirect existing ExtGState dictionary', async () => {
    globalThis.Image = MockImage as unknown as typeof Image;
    const resources = new PDFDict();
    const ext = new PDFDict();
    ext.set('Existing', new PDFDict([['Type', new PDFName('ExtGState')]]));
    const extRef = new PDFRef(20, 0);
    resources.set('ExtGState', extRef);
    const p = makePage(resources);
    p.objects.set(extRef.toKey(), ext);
    const result = await insert(p, { opacity: 0.4 });
    const source = new TextDecoder().decode(result.newContentBytes);
    expect(source).toContain('/SigGS1 gs');
    expect((ext.get('SigGS1') as PDFDict).getNumber('ca')).toBe(0.4);
    expect((ext.get('SigGS1') as PDFDict).getNumber('CA')).toBe(0.4);
    expect(ext.has('Existing')).toBe(true);
  });

  it('does not add an ExtGState for fully opaque images', async () => {
    globalThis.Image = MockImage as unknown as typeof Image;
    const p = makePage();
    await insert(p, { opacity: 1 });
    expect(p.page.dict.get('Resources')).toBeInstanceOf(PDFDict);
    expect((p.page.dict.get('Resources') as PDFDict).has('ExtGState')).toBe(false);
  });
});
