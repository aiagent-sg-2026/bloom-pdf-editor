import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorHistory, captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { insertImageRun } from '../editor/image-editor';
import { getPageContentBytes, getResource, parsePDF, resolveRef } from '../parser/parser';
import { applyFilters } from '../parser/filters';
import { deletePage } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream,
  type PDFDocumentData, type PDFObject,
} from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const overlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };

function setContent(objects: Map<string, PDFObject>, ref: PDFRef, bytes: Uint8Array): void {
  objects.set(ref.toKey(), new PDFStream(new PDFDict([
    ['Length', new PDFNumber(bytes.length)],
  ]), bytes, bytes));
}

function syntheticDocument(indirectKids = false): PDFDocumentData {
  const objects = new Map<string, PDFObject>();
  const rootRef = new PDFRef(1, 0);
  const branchRef = new PDFRef(2, 0);
  const catalogRef = new PDFRef(3, 0);
  const leafRefs = [4, 5, 6].map(n => new PDFRef(n, 0));
  const branchKids = new PDFArray(leafRefs.slice(0, 2));
  const root = new PDFDict([
    ['Type', new PDFName('Pages')],
    ['Kids', new PDFArray([branchRef, leafRefs[2]])],
    ['Count', new PDFNumber(3)],
    ['MediaBox', new PDFArray([0, 0, 100, 100].map(n => new PDFNumber(n)))],
  ]);
  const branch = new PDFDict([
    ['Type', new PDFName('Pages')], ['Parent', rootRef],
    ['Kids', indirectKids ? new PDFRef(7, 0) : branchKids],
    ['Count', new PDFNumber(2)],
  ]);
  if (indirectKids) objects.set('7_0', branchKids);
  const catalog = new PDFDict([['Type', new PDFName('Catalog')], ['Pages', rootRef]]);
  objects.set(rootRef.toKey(), root);
  objects.set(branchRef.toKey(), branch);
  objects.set(catalogRef.toKey(), catalog);
  const pages = leafRefs.map((ref, index) => {
    const contentRef = new PDFRef(10 + index, 0);
    const dict = new PDFDict([
      ['Type', new PDFName('Page')], ['Parent', index < 2 ? branchRef : rootRef],
      ['Contents', contentRef],
    ]);
    objects.set(ref.toKey(), dict);
    setContent(objects, contentRef, encoder.encode(`% LEAF_${index}\n`));
    return {
      index, ref, dict, contentRefs: [contentRef], resources: new PDFDict(), rotate: 0,
      mediaBox: { x: 0, y: 0, width: 100, height: 100 },
      cropBox: { x: 0, y: 0, width: 100, height: 100 },
    };
  });
  return {
    version: '1.7', objects, catalog, pages,
    xref: { entries: new Map(), trailerDict: new PDFDict([['Root', catalogRef]]) },
    info: {}, rawBytes: new Uint8Array(),
  };
}

function addResources(doc: PDFDocumentData, placement: 'indirect' | 'inherited'): void {
  const font = new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
    ['BaseFont', new PDFName('Helvetica')],
  ]);
  doc.objects.set('20_0', font);
  doc.objects.set('21_0', new PDFDict([['F1', new PDFRef(20, 0)]]));
  const formBytes = encoder.encode('q Q\n');
  doc.objects.set('22_0', new PDFStream(new PDFDict([
    ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Form')],
    ['BBox', new PDFArray([0, 0, 1, 1].map(n => new PDFNumber(n)))],
    ['Length', new PDFNumber(formBytes.length)],
  ]), formBytes, formBytes));
  doc.objects.set('23_0', new PDFDict([['Existing', new PDFRef(22, 0)]]));
  doc.objects.set('24_0', new PDFDict([['ExistingGS', new PDFDict([
    ['Type', new PDFName('ExtGState')], ['ca', new PDFNumber(0.8)],
  ])]]));
  const resources = new PDFDict([
    ['Font', new PDFRef(21, 0)], ['XObject', new PDFRef(23, 0)],
    ['ExtGState', new PDFRef(24, 0)],
    ['ColorSpace', new PDFDict([['CS1', new PDFName('DeviceRGB')]])],
    ['ProcSet', new PDFArray([new PDFName('PDF'), new PDFName('Text')])],
  ]);
  doc.objects.set('25_0', resources);
  const owner = placement === 'indirect' ? doc.pages[0].dict : doc.objects.get('2_0') as PDFDict;
  owner.set('Resources', new PDFRef(25, 0));
}

async function reopen(doc: PDFDocumentData): Promise<PDFDocumentData> {
  return parsePDF(await serializeDocument(doc));
}

function assertOriginalResources(doc: PDFDocumentData, index: number): void {
  const resources = doc.pages[index].resources;
  expect((getResource(resources, 'Font', 'F1', doc.objects) as PDFDict).getName('BaseFont')).toBe('Helvetica');
  expect((getResource(resources, 'XObject', 'Existing', doc.objects) as PDFStream).dict.getName('Subtype')).toBe('Form');
}

describe('nested page deletion exports', () => {
  it.each([false, true])('removes a nested leaf and retains its nonempty parent (indirect Kids: %s)', async indirectKids => {
    const doc = await reopen(syntheticDocument(indirectKids));
    deletePage(doc, 0);
    const saved = await reopen(doc);
    expect(saved.pages.map(p => p.ref.toKey())).toEqual(['5_0', '6_0']);
    expect(saved.pages.map(p => decoder.decode(getPageContentBytes(p, saved.objects)).trim())).toEqual(['% LEAF_1', '% LEAF_2']);
    const root = resolveRef(saved.catalog.get('Pages')!, saved.objects) as PDFDict;
    const branch = saved.objects.get('2_0') as PDFDict;
    expect(root.getNumber('Count')).toBe(2);
    expect(branch.getNumber('Count')).toBe(1);
    expect((resolveRef(root.get('Kids')!, saved.objects) as PDFArray).items).toEqual([new PDFRef(2, 0), new PDFRef(6, 0)]);
    expect((resolveRef(branch.get('Kids')!, saved.objects) as PDFArray).items).toEqual([new PDFRef(5, 0)]);
    expect(saved.pages[0].dict.getRef('Parent')?.toKey()).toBe('2_0');
    expect(saved.objects.has('4_0')).toBe(false);
    expect(saved.objects.has('10_0')).toBe(false);
  });

  it('prunes an intermediate node only after its last leaf is deleted', async () => {
    const doc = await reopen(syntheticDocument());
    deletePage(doc, 0);
    const partial = await reopen(doc);
    expect((partial.objects.get('2_0') as PDFDict).getNumber('Count')).toBe(1);
    deletePage(partial, 0);
    const saved = await reopen(partial);
    expect(saved.pages.map(p => p.ref.toKey())).toEqual(['6_0']);
    const root = resolveRef(saved.catalog.get('Pages')!, saved.objects) as PDFDict;
    expect(root.getNumber('Count')).toBe(1);
    expect((root.get('Kids') as PDFArray).items).toEqual([new PDFRef(6, 0)]);
    expect(saved.objects.has('2_0')).toBe(false);
    expect(saved.objects.has('5_0')).toBe(false);
  });
});

describe('undo effective page resources', () => {
  it.each(['indirect', 'inherited'] as const)('restores %s fonts and XObjects before and after export', async placement => {
    const fixture = syntheticDocument();
    addResources(fixture, placement);
    const doc = await reopen(fixture);
    assertOriginalResources(doc, 0);
    const originalBytes = getPageContentBytes(doc.pages[0], doc.objects);
    const history = new EditorHistory();
    history.seed(captureHistoryEntry(doc, 0, originalBytes, overlays, 'original'));
    doc.pages[0].dict.set('Resources', new PDFDict());
    doc.pages[0].resources = new PDFDict();
    setContent(doc.objects, doc.pages[0].contentRefs[0], encoder.encode('% MUTATED\n'));
    history.push(captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects), overlays, 'mutated'));
    const snapshot = history.undo();
    expect(snapshot?.label).toBe('original');
    await restoreDocumentStructure(doc, snapshot!, async (refs, bytes, objects) => {
      setContent(objects, refs[0], bytes);
    });
    assertOriginalResources(doc, 0);
    if (placement === 'inherited') expect(doc.pages[0].dict.has('Resources')).toBe(false);
    else expect(doc.pages[0].dict.get('Resources')).toEqual(new PDFRef(25, 0));
    const saved = await reopen(doc);
    assertOriginalResources(saved, 0);
    expect(decoder.decode(getPageContentBytes(saved.pages[0], saved.objects)).trim()).toBe('% LEAF_0');
  });
});

class SyntheticImage {
  naturalWidth = 1;
  naturalHeight = 1;
  onload: (() => void) | null = null;
  set src(_value: string) { this.onload?.(); }
}

describe('image insertion with inherited resources', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['jpeg', 'png'])('preserves inherited categories and isolates siblings for %s', async format => {
    vi.stubGlobal('Image', SyntheticImage);
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray([100, 150, 200, 128]) }),
        }),
      }),
    });
    const fixture = syntheticDocument();
    addResources(fixture, 'inherited');
    const doc = await reopen(fixture);
    assertOriginalResources(doc, 0);
    assertOriginalResources(doc, 1);
    let next = 30;
    const result = await insertImageRun(
      getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects,
      `data:image/${format};base64,/9j/2Q==`, 10, 30, 20, 20, () => next++, { opacity: 0.4 },
    );
    setContent(doc.objects, doc.pages[0].contentRefs[0], result.newContentBytes);
    expect(doc.pages[0].dict.get('Resources')).toBe(doc.pages[0].resources);
    for (const current of [doc, await reopen(doc)]) {
      assertOriginalResources(current, 0);
      assertOriginalResources(current, 1);
      const target = current.pages[0].resources;
      const sibling = current.pages[1].resources;
      const image = getResource(target, 'XObject', 'Im1', current.objects) as PDFStream;
      expect(image.dict.getName('Subtype')).toBe('Image');
      expect(image.dict.getNumber('Width')).toBe(1);
      expect(image.dict.getNumber('Height')).toBe(1);
      if (format === 'png') {
        expect(Array.from(image.decodedBytes ?? await applyFilters(image.rawBytes, ['FlateDecode'], []))).toEqual([100, 150, 200]);
        const mask = resolveRef(image.dict.get('SMask')!, current.objects) as PDFStream;
        expect(Array.from(mask.decodedBytes ?? await applyFilters(mask.rawBytes, ['FlateDecode'], []))).toEqual([128]);
      }
      expect((getResource(target, 'ExtGState', 'ExistingGS', current.objects) as PDFDict).getNumber('ca')).toBe(0.8);
      expect((getResource(target, 'ExtGState', 'SigGS1', current.objects) as PDFDict).getNumber('ca')).toBe(0.4);
      expect(getResource(target, 'ColorSpace', 'CS1', current.objects)).toEqual(new PDFName('DeviceRGB'));
      expect((target.get('ProcSet') as PDFArray).items).toEqual([new PDFName('PDF'), new PDFName('Text')]);
      expect(getResource(sibling, 'XObject', 'Im1', current.objects)).toBeUndefined();
      expect(getResource(sibling, 'ExtGState', 'SigGS1', current.objects)).toBeUndefined();
      expect(current.pages[1].dict.has('Resources')).toBe(false);
      expect(decoder.decode(getPageContentBytes(current.pages[0], current.objects))).toContain('/Im1 Do');
      expect(decoder.decode(getPageContentBytes(current.pages[1], current.objects)).trim()).toBe('% LEAF_1');
    }
  });
});
