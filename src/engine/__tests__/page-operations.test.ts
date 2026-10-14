import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deletePage, insertPagesFromDocument, reorderPages } from '../writer/page-operations';
import { parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData } from '../types';
import { canvasToPdf, pdfToCanvas } from '../editing/coordinates';
import { EditorHistory, captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { canvasToPdf as appCanvasToPdf, pdfToCanvas as appPdfToCanvas } from '../../app/editor/utils';

const qpdfAvailable = (() => {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function syntheticDocument(pageCount = 3): PDFDocumentData {
  const objects = new Map<string, import('../types').PDFObject>();
  const pagesRef = new PDFRef(1, 0);
  const catalogRef = new PDFRef(8, 0);
  const pagesRoot = new PDFDict();
  pagesRoot.set('Type', new PDFName('Pages'));
  const pageRefs = Array.from({ length: pageCount }, (_, index) => new PDFRef(index + 2, 0));
  pagesRoot.set('Kids', new PDFArray(pageRefs));
  pagesRoot.set('Count', new PDFNumber(pageCount));
  objects.set(pagesRef.toKey(), pagesRoot);

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', pagesRef);
  const outlineRoot = new PDFDict();
  const outlineRefs = [30, 31, 32].map((n) => new PDFRef(n, 0));
  outlineRoot.set('First', outlineRefs[0]);
  outlineRoot.set('Last', outlineRefs[2]);
  outlineRoot.set('Count', new PDFNumber(3));
  objects.set('29_0', outlineRoot);
  outlineRefs.forEach((ref, index) => {
    const outline = new PDFDict();
    outline.set('Title', new PDFName(`Section-${index + 1}`));
    outline.set('Parent', new PDFRef(29, 0));
    outline.set('Dest', new PDFArray([pageRefs[index], new PDFName('Fit')]));
    if (index > 0) outline.set('Prev', outlineRefs[index - 1]);
    if (index < outlineRefs.length - 1) outline.set('Next', outlineRefs[index + 1]);
    objects.set(ref.toKey(), outline);
  });
  catalog.set('Outlines', new PDFRef(29, 0));
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
  const linkedPage = pageRefs[1] ? objects.get(pageRefs[1].toKey()) : undefined;
  if (linkedPage instanceof PDFDict) linkedPage.set('Annots', new PDFArray([new PDFRef(40, 0)]));

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
    writeFileSync('/tmp/bloom-page-delete-serialization-test.pdf', bytes);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('ONLY_PAGE_ONE_SECRET');
    const reparsed = await parsePDF(bytes);
    const rootRef = reparsed.catalog.get('Outlines');
    expect(rootRef).toBeInstanceOf(PDFRef);
    const root = reparsed.objects.get((rootRef as PDFRef).toKey()) as PDFDict;
    const titles: string[] = [];
    let ref = root.get('First');
    while (ref instanceof PDFRef) {
      const item = reparsed.objects.get(ref.toKey()) as PDFDict;
      titles.push(item.getName('Title') ?? '');
      ref = item.get('Next');
    }
    expect(titles).toEqual(['Section-2', 'Section-3']);
    expect((reparsed.objects.get('30_0') as PDFDict | undefined)?.get('Dest')).toBeUndefined();
    expect((reparsed.objects.get('31_0') as PDFDict).get('Dest')).toBeInstanceOf(PDFArray);
    expect((doc.pages[0].dict.get('Annots'))).toBeUndefined();
  });

  it('keeps surviving outlines after reorder and delete, including children of a dropped parent', async () => {
    const doc = syntheticDocument();
    const pageRefs = doc.pages.map((page) => page.ref);
    const childRef = new PDFRef(33, 0);
    const child = new PDFDict([
      ['Title', new PDFName('Surviving child')],
      ['Parent', new PDFRef(30, 0)],
      ['Dest', new PDFArray([pageRefs[1], new PDFName('Fit')])],
    ]);
    child.set('Prev', new PDFRef(30, 0));
    child.set('Next', new PDFRef(31, 0));
    doc.objects.set(childRef.toKey(), child);
    const root = doc.objects.get('29_0') as PDFDict;
    // Add a surviving child under Section 1; deleting Section 1 must promote it.
    const firstItemRef = root.get('First');
    if (firstItemRef instanceof PDFRef) {
      const firstItem = doc.objects.get(firstItemRef.toKey());
      if (firstItem instanceof PDFDict) {
        firstItem.set('First', childRef);
        firstItem.set('Last', childRef);
        firstItem.set('Count', new PDFNumber(1));
        child.set('Parent', firstItemRef);
      }
    }

    reorderPages(doc, [2, 1, 0]);
    deletePage(doc, 2);
    const bytes = await serializeDocument(doc);
    const reparsed = await parsePDF(bytes);
    const outlinesRef = reparsed.catalog.get('Outlines');
    expect(outlinesRef).toBeInstanceOf(PDFRef);
    const outlineRoot = reparsed.objects.get((outlinesRef as PDFRef).toKey()) as PDFDict;
    const titles: string[] = [];
    let ref = outlineRoot.get('First');
    while (ref instanceof PDFRef) {
      const item = reparsed.objects.get(ref.toKey()) as PDFDict;
      titles.push(item.getName('Title') ?? item.getString('Title') ?? '');
      ref = item.get('Next');
    }
    // A dropped outline parent promotes surviving children at its position.
    expect(titles).toEqual(['Surviving child', 'Section-2', 'Section-3']);
    expect(new TextDecoder().decode(bytes)).not.toContain('ONLY_PAGE_ONE_SECRET');
  });

  it.each([false, true])('preserves surviving flat destinations and other name trees (indirect: %s)', async (indirect) => {
    const doc = syntheticDocument();
    const deletedRef = doc.pages[0].ref;
    const survivingRef = doc.pages[1].ref;
    const survivingDestination = new PDFDict([['D', new PDFArray([survivingRef, new PDFName('Fit')])]]);
    doc.objects.set('50_0', survivingDestination);
    const destTree = new PDFDict([
      ['Names', new PDFArray([
        new PDFString('deleted'), new PDFArray([deletedRef, new PDFName('Fit')]),
        new PDFString('surviving'), new PDFRef(50, 0),
      ])],
      ['Limits', new PDFArray([new PDFString('deleted'), new PDFString('surviving')])],
    ]);
    const files = new PDFDict([['Names', new PDFArray([
      new PDFString('attachment.txt'), new PDFDict([
        ['Type', new PDFName('Filespec')], ['F', new PDFString('attachment.txt')],
      ]),
    ])]]);
    const scripts = new PDFDict([['Names', new PDFArray([
      new PDFString('script'), new PDFDict([
        ['S', new PDFName('JavaScript')], ['JS', new PDFString('app.alert("kept")')],
      ]),
    ])]]);
    const names = new PDFDict([['Dests', destTree], ['EmbeddedFiles', files], ['JavaScript', scripts]]);
    doc.objects.set('51_0', names);
    doc.catalog.set('Names', indirect ? new PDFRef(51, 0) : names);
    doc.catalog.set('Dests', new PDFDict([
      ['deleted', new PDFArray([deletedRef, new PDFName('Fit')])],
      ['surviving', new PDFRef(50, 0)],
    ]));

    deletePage(doc, 0);
    const reparsed = await parsePDF(await serializeDocument(doc));
    const namesObject = reparsed.catalog.get('Names');
    const keptNames = (namesObject instanceof PDFRef ? reparsed.objects.get(namesObject.toKey()) : namesObject) as PDFDict;
    expect(keptNames).toBeInstanceOf(PDFDict);
    const keptTree = keptNames.getDict('Dests')!;
    expect(keptTree.getArray('Names')!.items.map((item) => item instanceof PDFString ? item.value : null))
      .toEqual(['surviving', null]);
    const keptDestination = keptTree.getArray('Names')!.items[1] as PDFRef;
    const destination = reparsed.objects.get(keptDestination.toKey()) as PDFDict;
    expect((destination.getArray('D')!.items[0] as PDFRef).equals(survivingRef)).toBe(true);
    const limits = keptTree.getArray('Limits');
    if (limits) expect(limits.items.map((item) => (item as PDFString).value)).toEqual(['surviving', 'surviving']);
    expect(keptNames.getDict('EmbeddedFiles')!.getArray('Names')!.items[0]).toEqual(new PDFString('attachment.txt'));
    expect((keptNames.getDict('EmbeddedFiles')!.getArray('Names')!.items[1] as PDFDict).getString('F')).toBe('attachment.txt');
    expect((keptNames.getDict('JavaScript')!.getArray('Names')!.items[1] as PDFDict).getString('JS')).toBe('app.alert("kept")');
    expect(reparsed.catalog.getDict('Dests')!.get('deleted')).toBeUndefined();
    expect(reparsed.catalog.getDict('Dests')!.get('surviving')).toBeInstanceOf(PDFRef);
    expect(reparsed.pages).toHaveLength(2);
  });

  it('prunes nested destination leaves and repairs limits without losing surviving siblings', async () => {
    const doc = syntheticDocument();
    const destination = (pageIndex: number) => new PDFArray([doc.pages[pageIndex].ref, new PDFName('Fit')]);
    const limits = (first: string, last: string) => new PDFArray([new PDFString(first), new PDFString(last)]);
    doc.objects.set('50_0', new PDFDict([
      ['Names', new PDFArray([new PDFString('a'), destination(0)])], ['Limits', limits('a', 'a')],
    ]));
    doc.objects.set('51_0', new PDFDict([
      ['Names', new PDFArray([new PDFString('b'), destination(0), new PDFString('c'), destination(1)])],
      ['Limits', limits('b', 'c')],
    ]));
    doc.objects.set('52_0', new PDFDict([
      ['Kids', new PDFArray([new PDFRef(50, 0), new PDFRef(51, 0)])], ['Limits', limits('a', 'c')],
    ]));
    doc.objects.set('53_0', new PDFDict([
      ['Names', new PDFArray([new PDFString('d'), destination(2)])], ['Limits', limits('d', 'd')],
    ]));
    const tree = new PDFDict([['Kids', new PDFArray([new PDFRef(52, 0), new PDFRef(53, 0)])]]);
    doc.catalog.set('Names', new PDFDict([['Dests', tree]]));

    deletePage(doc, 0);
    const reparsed = await parsePDF(await serializeDocument(doc));
    const root = reparsed.catalog.getDict('Names')!.getDict('Dests')!;
    expect(root.getArray('Kids')!.items).toEqual([new PDFRef(52, 0), new PDFRef(53, 0)]);
    const branch = reparsed.objects.get('52_0') as PDFDict;
    expect(branch.getArray('Kids')!.items).toEqual([new PDFRef(51, 0)]);
    expect(branch.getArray('Limits')!.items).toEqual(limits('c', 'c').items);
    const leaf = reparsed.objects.get('51_0') as PDFDict;
    expect(leaf.getArray('Names')!.items[0]).toEqual(new PDFString('c'));
    expect(leaf.getArray('Names')!.items).toHaveLength(2);
    const leafLimits = leaf.getArray('Limits');
    if (leafLimits) expect(leafLimits.items).toEqual(limits('c', 'c').items);
    expect((leaf.getArray('Names')!.items[1] as PDFArray).items[0]).toEqual(reparsed.pages[0].ref);
    expect((reparsed.objects.get('53_0') as PDFDict).getArray('Names')!.items)
      .toEqual([new PDFString('d'), new PDFArray([reparsed.pages[1].ref, new PDFName('Fit')])]);
    expect(reparsed.objects.has('50_0')).toBe(false);
  });

  it.each([false, true])('removes empty destination trees but only removes an empty Names dictionary (other tree: %s)', async (otherTree) => {
    const doc = syntheticDocument();
    const destTree = new PDFDict([['Names', new PDFArray([
      new PDFString('deleted'), new PDFArray([doc.pages[0].ref, new PDFName('Fit')]),
    ])]]);
    const names = new PDFDict([['Dests', new PDFDict([['Kids', new PDFArray([destTree])]])]]);
    if (otherTree) names.set('EmbeddedFiles', new PDFDict([['Names', new PDFArray([
      new PDFString('attachment.txt'), new PDFDict([['F', new PDFString('attachment.txt')]]),
    ])]]));
    doc.catalog.set('Names', names);
    doc.catalog.set('Dests', new PDFDict([['deleted', new PDFArray([doc.pages[0].ref, new PDFName('Fit')])]]));

    deletePage(doc, 0);
    const reparsed = await parsePDF(await serializeDocument(doc));
    expect(reparsed.catalog.get('Dests')).toBeUndefined();
    if (otherTree) {
      expect(reparsed.catalog.getDict('Names')!.get('Dests')).toBeUndefined();
      expect(reparsed.catalog.getDict('Names')!.getDict('EmbeddedFiles')!.getArray('Names')!.items[0])
        .toEqual(new PDFString('attachment.txt'));
    } else {
      expect(reparsed.catalog.get('Names')).toBeUndefined();
    }
  });

  it('restores a deleted page from the full structural history snapshot', async () => {
    const doc = syntheticDocument();
    const before = captureHistoryEntry(doc, 0, new TextEncoder().encode('ONLY_PAGE_ONE_SECRET'), {
      drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [],
    }, 'before-delete');
    deletePage(doc, 0);

    await restoreDocumentStructure(doc, before, async (refs, bytes, objects) => {
      const content = objects.get(refs[0].toKey());
      if (content instanceof PDFStream) content.decodedBytes = bytes;
    });

    expect(doc.pages).toHaveLength(3);
    expect(doc.pages.map((page) => page.ref.toKey())).toEqual(['2_0', '3_0', '4_0']);
    expect((doc.objects.get('10_0') as PDFStream).decodedBytes).toEqual(new TextEncoder().encode('ONLY_PAGE_ONE_SECRET'));
  });

  it('undoes and redoes deleting page 1 without losing page identity or content', async () => {
    const doc = syntheticDocument(6);
    const overlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };
    const initialBytes = new TextEncoder().encode('ONLY_PAGE_ONE_SECRET');
    const before = captureHistoryEntry(doc, 0, initialBytes, overlays, 'initial');
    const history = new EditorHistory();
    history.seed(before);

    deletePage(doc, 0);
    const exportedAfterDelete = await serializeDocument(doc);
    expect(new TextDecoder().decode(exportedAfterDelete)).not.toContain('ONLY_PAGE_ONE_SECRET');
    const afterDelete = captureHistoryEntry(
      doc,
      0,
      new TextEncoder().encode('PAGE_2'),
      overlays,
      'delete-page',
    );
    history.push(afterDelete);

    const restore = async (entry: ReturnType<typeof captureHistoryEntry>) => {
      await restoreDocumentStructure(doc, entry, async (refs, bytes, objects) => {
        const content = objects.get(refs[0].toKey());
        if (content instanceof PDFStream) content.decodedBytes = new Uint8Array(bytes);
      });
    };
    const pageState = () => doc.pages.map((page) => ({
      ref: page.ref.toKey(),
      bytes: Array.from((doc.objects.get(page.contentRefs[0].toKey()) as PDFStream).decodedBytes ?? []),
    }));

    expect(pageState()).toEqual([
      { ref: '3_0', bytes: Array.from(new TextEncoder().encode('PAGE_2')) },
      { ref: '4_0', bytes: Array.from(new TextEncoder().encode('PAGE_3')) },
      { ref: '5_0', bytes: Array.from(new TextEncoder().encode('PAGE_4')) },
      { ref: '6_0', bytes: Array.from(new TextEncoder().encode('PAGE_5')) },
      { ref: '7_0', bytes: Array.from(new TextEncoder().encode('PAGE_6')) },
    ]);

    await restore(history.undo()!);
    expect(pageState()).toEqual([
      { ref: '2_0', bytes: Array.from(new TextEncoder().encode('ONLY_PAGE_ONE_SECRET')) },
      { ref: '3_0', bytes: Array.from(new TextEncoder().encode('PAGE_2')) },
      { ref: '4_0', bytes: Array.from(new TextEncoder().encode('PAGE_3')) },
      { ref: '5_0', bytes: Array.from(new TextEncoder().encode('PAGE_4')) },
      { ref: '6_0', bytes: Array.from(new TextEncoder().encode('PAGE_5')) },
      { ref: '7_0', bytes: Array.from(new TextEncoder().encode('PAGE_6')) },
    ]);
    expect(new Set(doc.pages.map((page) => page.ref.toKey())).size).toBe(6);

    await restore(history.redo()!);
    deletePage(doc, 0);
    history.push(captureHistoryEntry(doc, 0, new TextEncoder().encode('PAGE_2'), overlays, 'delete-page-again'));
    await restore(history.undo()!);
    expect(pageState().map(({ ref }) => ref)).toEqual(['3_0', '4_0', '5_0', '6_0', '7_0']);
    expect(new Set(doc.pages.map((page) => page.ref.toKey())).size).toBe(5);
  });

  it.skipIf(!qpdfAvailable)('writes qpdf-clean output without the deleted page marker', async () => {
    const doc = syntheticDocument(6);
    deletePage(doc, 0);
    const bytes = await serializeDocument(doc);
    const path = join(mkdtempSync(join(tmpdir(), 'bloom-page-delete-')), 'deleted-page.pdf');
    writeFileSync(path, bytes);
    expect(new TextDecoder().decode(bytes)).not.toContain('ONLY_PAGE_ONE_SECRET');
    const result = spawnSync('qpdf', ['--check', path], { encoding: 'utf8' });
    const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(diagnostics).not.toMatch(/WARNING|ERROR/);
  });

});

describe('page insertion forms', () => {
  it('keeps widgets fillable by merging only fields on inserted pages', async () => {
    const target = syntheticDocument(1);
    const source = syntheticDocument(2);
    const insertedPage = source.pages[0];
    const notInsertedPage = source.pages[1];
    const insertedFieldRef = new PDFRef(100, 0);
    const insertedWidgetRefs = [101, 102, 103].map((n) => new PDFRef(n, 0));
    const excludedFieldRef = new PDFRef(110, 0);
    const excludedWidgetRef = new PDFRef(111, 0);
    const insertedField = new PDFDict([
      ['FT', new PDFName('Tx')], ['T', new PDFString('InsertedField')],
      ['Kids', new PDFArray(insertedWidgetRefs)],
    ]);
    const excludedField = new PDFDict([
      ['FT', new PDFName('Tx')], ['T', new PDFString('ExcludedField')],
      ['Kids', new PDFArray([excludedWidgetRef])],
    ]);
    source.objects.set(insertedFieldRef.toKey(), insertedField);
    source.objects.set(excludedFieldRef.toKey(), excludedField);
    for (const [index, ref] of insertedWidgetRefs.entries()) {
      source.objects.set(ref.toKey(), new PDFDict([
        ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Widget')],
        ['Parent', insertedFieldRef], ['Rect', new PDFArray([new PDFNumber(10), new PDFNumber(index * 20), new PDFNumber(100), new PDFNumber(index * 20 + 15)])],
      ]));
    }
    source.objects.set(excludedWidgetRef.toKey(), new PDFDict([
      ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Widget')],
      ['Parent', excludedFieldRef], ['Rect', new PDFArray([new PDFNumber(10), new PDFNumber(0), new PDFNumber(100), new PDFNumber(15)])],
    ]));
    insertedPage.dict.set('Annots', new PDFArray(insertedWidgetRefs));
    notInsertedPage.dict.set('Annots', new PDFArray([excludedWidgetRef]));
    // Only the first page is supplied to the insertion operation; the second page
    // and its field remain source-only objects and must not enter the target.
    source.pages.splice(1, 1);
    source.catalog.set('AcroForm', new PDFDict([
      ['Fields', new PDFArray([insertedFieldRef, excludedFieldRef])],
      ['DR', new PDFDict()],
      ['DA', new PDFString('/Helv 10 Tf 0 g')],
      ['NeedAppearances', new PDFBoolean(true)],
    ]));

    insertPagesFromDocument(target, source, 1);
    const bytes = await serializeDocument(target);
    const reparsed = await parsePDF(bytes);
    const acro = reparsed.catalog.get('AcroForm');
    expect(acro).toBeInstanceOf(PDFDict);
    const fields = (acro as PDFDict).get('Fields');
    expect(fields).toBeInstanceOf(PDFArray);
    expect((fields as PDFArray).items).toHaveLength(1);
    const copiedField = reparsed.objects.get(((fields as PDFArray).items[0] as PDFRef).toKey());
    expect(copiedField).toBeInstanceOf(PDFDict);
    expect((copiedField as PDFDict).getString('T')).toBe('InsertedField');
    const kids = (copiedField as PDFDict).get('Kids');
    expect(kids).toBeInstanceOf(PDFArray);
    // All three widgets belong to the retained first source page, so all three
    // must remain reachable even though the second page and its field are excluded.
    expect((kids as PDFArray).items).toHaveLength(3);
    expect((kids as PDFArray).items.every((item) => item instanceof PDFRef)).toBe(true);
    expect((kids as PDFArray).items.map((item) =>
      reparsed.objects.get((item as PDFRef).toKey()) instanceof PDFDict
        ? (reparsed.objects.get((item as PDFRef).toKey()) as PDFDict).get('Parent')
        : undefined,
    ).every((parent) => parent instanceof PDFRef && parent.toKey() === ((fields as PDFArray).items[0] as PDFRef).toKey())).toBe(true);
    expect((acro as PDFDict).get('DR')).toBeInstanceOf(PDFDict);
    expect((acro as PDFDict).getString('DA')).toBe('/Helv 10 Tf 0 g');
    expect((acro as PDFDict).getBool('NeedAppearances')).toBe(true);

    if (qpdfAvailable) {
      const path = join(mkdtempSync(join(tmpdir(), 'bloom-page-insert-form-')), 'inserted-form.pdf');
      writeFileSync(path, bytes);
      const result = spawnSync('qpdf', ['--check', path], { encoding: 'utf8' });
      const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status).toBe(0);
      expect(diagnostics).not.toMatch(/WARNING|ERROR/);
    }
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

describe('editor rotated-page coordinate transforms', () => {
  it.each([0, 90, 180, 270])('round-trips rotation %i with explicit page width and CropBox offset', (rotation) => {
    const source = { x: 120, y: 240 };
    const canvas = appPdfToCanvas(source.x, source.y, 2, 720, 18, 27, rotation, 36, 45, 540);
    expect(appCanvasToPdf(canvas.cssX, canvas.cssY, 2, 540, 720, 18, 27, rotation, 36, 45)).toEqual({
      pdfX: source.x,
      pdfY: source.y,
    });
  });
});
