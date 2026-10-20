import { describe, expect, it, vi } from 'vitest';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
import { getPageContentBytes, parsePDF, resolveRef } from '../parser/parser';
import * as parser from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { PDFArray, PDFDict, PDFNumber, PDFRef, type PDFDocumentData } from '../types';
import { deletePage, insertBlankPage, insertPagesFromDocument, movePage, rotatePageBy } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

function fixture(indirect: boolean): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids ${indirect ? '8 0 R' : '[3 0 R 6 0 R]'} /Count ${indirect ? '9 0 R' : '3'} /MediaBox [10 20 210 320] /CropBox [20 30 200 300] /Rotate 90 /Resources << /ProcSet [/PDF] >> >>`,
    `<< /Type /Pages /Parent 2 0 R /Kids ${indirect ? '10 0 R' : '[4 0 R 5 0 R]'} /Count ${indirect ? '11 0 R' : '2'} /Rotate 180 /MediaBox [-5 10 95 160] /Resources << /ProcSet [/PDF /Text] >> >>`,
    '<< /Type /Page /Parent 3 0 R /Contents 12 0 R >>',
    '<< /Type /Page /Parent 3 0 R /Contents 13 0 R /Rotate 0 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>',
    'null',
    '[3 0 R 6 0 R]',
    '3',
    '[4 0 R 5 0 R]',
    '2',
    '<< /Length 4 >>\nstream\n% A\nendstream',
    '<< /Length 4 >>\nstream\n% B\nendstream',
    '<< /Length 4 >>\nstream\n% C\nendstream',
  ]);
}

function labels(doc: PDFDocumentData): string[] {
  return doc.pages.map(page => new TextDecoder().decode(getPageContentBytes(page, doc.objects)).trim());
}

function count(doc: PDFDocumentData, dict: PDFDict): number {
  return (resolveRef(dict.get('Count')!, doc.objects) as PDFNumber).value;
}

function assertPages(doc: PDFDocumentData, expected: string[], rotations: number[]): void {
  expect(labels(doc)).toEqual(expected);
  expect(doc.pages.map(page => page.index)).toEqual(expected.map((_, index) => index));
  expect(doc.pages.map(page => page.rotate)).toEqual(rotations);
  const root = resolveRef(doc.catalog.get('Pages')!, doc.objects) as PDFDict;
  expect(count(doc, root)).toBe(expected.length);
  for (const page of doc.pages) {
    expect(doc.objects.get(page.ref.toKey())).toBe(page.dict);
    const parent = resolveRef(page.dict.get('Parent')!, doc.objects) as PDFDict;
    const kids = resolveRef(parent.get('Kids')!, doc.objects) as PDFArray;
    expect(kids.items.some(ref => ref instanceof PDFRef && ref.equals(page.ref))).toBe(true);
  }
}

const operations: {
  name: string;
  apply: (doc: PDFDocumentData, source: PDFDocumentData) => void;
  labels: string[];
  rotations: number[];
}[] = [
  { name: 'delete', apply: doc => deletePage(doc, 0), labels: ['% B', '% C'], rotations: [0, 90] },
  { name: 'reorder', apply: doc => movePage(doc, 0, 2), labels: ['% B', '% C', '% A'], rotations: [0, 90, 180] },
  { name: 'rotate', apply: doc => rotatePageBy(doc, 0, 90), labels: ['% A', '% B', '% C'], rotations: [270, 0, 90] },
  { name: 'blank', apply: doc => insertBlankPage(doc, 1), labels: ['% A', '', '% B', '% C'], rotations: [180, 0, 0, 90] },
  { name: 'import', apply: (doc, source) => insertPagesFromDocument(doc, source, 1),
    labels: ['% A', '% A', '% B', '% C', '% B', '% C'], rotations: [180, 180, 0, 90, 0, 90] },
];

const overlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };

describe.each([false, true])('session page operations (indirect Kids/Count: %s)', indirect => {
  it.each(operations)('isolates failed $name staging and restores exact bytes repeatedly', async operation => {
    const doc = await parsePDF(fixture(indirect));
    const source = await parsePDF(fixture(true));
    const sourceBytes = await serializeDocument(source);
    const original = await serializeDocument(doc);
    const originalPages = [...doc.pages];
    const geometry = doc.pages.map(page => ({ ...page.mediaBox }));
    const editor = new SessionDocumentEditor();
    const failure = new Error('page staging failed');
    await expect(editor.edit(doc, operation.name, async staged => {
      operation.apply(staged, source);
      staged.pages[0].mediaBox.width = 999;
      throw failure;
    })).rejects.toBe(failure);
    expect(await serializeDocument(doc)).toEqual(original);
    expect(doc.pages).toEqual(originalPages);
    expect(doc.pages.map(page => page.mediaBox)).toEqual(geometry);
    expect(editor.canUndo).toBe(false);
    await editor.edit(doc, operation.name, async staged => { operation.apply(staged, source); });
    const applied = await serializeDocument(doc);
    assertPages(doc, operation.labels, operation.rotations);
    for (const page of doc.pages) {
      const originalPage = originalPages.find(candidate => candidate.ref.equals(page.ref));
      if (originalPage) expect(page).toBe(originalPage);
    }
    const reopened = await parsePDF(applied);
    assertPages(reopened, operation.labels, operation.rotations);
    for (const page of reopened.pages) {
      const label = labels(reopened)[page.index];
      if (label === '% A' || label === '% B') {
        expect(page.mediaBox).toEqual({ x: -5, y: 10, width: 100, height: 150 });
        expect(page.cropBox).toEqual({ x: 20, y: 30, width: 180, height: 270 });
        expect(page.resources.getArray('ProcSet')?.items).toHaveLength(2);
      }
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await editor.undo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(original);
      assertPages(doc, ['% A', '% B', '% C'], [180, 0, 90]);
      expect(doc.pages[0].dict.has('Rotate')).toBe(false);
      expect(await editor.redo(doc)).toBe(true);
      expect(await serializeDocument(doc)).toEqual(applied);
      assertPages(doc, operation.labels, operation.rotations);
    }
    expect(await serializeDocument(source)).toEqual(sourceBytes);
  });

  it('updates ancestor counts and prunes only the branch whose last page is removed', async () => {
    const doc = await parsePDF(fixture(indirect));
    const editor = new SessionDocumentEditor();
    const original = await serializeDocument(doc);
    await editor.edit(doc, 'delete-first', async staged => { deletePage(staged, 0); });
    expect(count(doc, doc.objects.get('3_0') as PDFDict)).toBe(1);
    const partial = await serializeDocument(doc);
    await editor.edit(doc, 'delete-second', async staged => { deletePage(staged, 0); });
    const deleted = await serializeDocument(doc);
    assertPages(await parsePDF(deleted), ['% C'], [90]);
    expect((await parsePDF(deleted)).objects.has('3_0')).toBe(false);
    await editor.undo(doc);
    expect(await serializeDocument(doc)).toEqual(partial);
    await editor.undo(doc);
    expect(await serializeDocument(doc)).toEqual(original);
    await editor.redo(doc);
    await editor.redo(doc);
    expect(await serializeDocument(doc)).toEqual(deleted);
  });

  it('extracts inherited geometry transactionally without changing source bytes or history', async () => {
    const doc = await parsePDF(fixture(indirect));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'rotate', async staged => { rotatePageBy(staged, 2, 90); });
    await editor.undo(doc);
    const before = await serializeDocument(doc);
    const bytes = await editor.extractPages(doc, [2, 0]);
    const extracted = await parsePDF(bytes);
    assertPages(extracted, ['% C', '% A'], [90, 180]);
    expect(extracted.pages[1].mediaBox).toEqual(doc.pages[0].mediaBox);
    expect(extracted.pages[1].cropBox).toEqual(doc.pages[0].cropBox);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(editor.canRedo).toBe(true);
    expect(await editor.extractPages(doc, [2, 0])).toEqual(bytes);
    await editor.redo(doc);
    expect(doc.pages[2].rotate).toBe(180);
  });

  it.each(['undo', 'redo'] as const)('retains the page boundary after a failed %s parse', async direction => {
    const doc = await parsePDF(fixture(indirect));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'blank', async staged => { insertBlankPage(staged, 0); });
    if (direction === 'redo') await editor.undo(doc);
    const before = await serializeDocument(doc);
    const beforeLabels = labels(doc);
    const failure = new Error('snapshot parse failed');
    const parse = vi.spyOn(parser, 'parsePDF').mockRejectedValueOnce(failure);
    try {
      await expect(editor[direction](doc)).rejects.toBe(failure);
    } finally {
      parse.mockRestore();
    }
    expect(await serializeDocument(doc)).toEqual(before);
    expect(labels(doc)).toEqual(beforeLabels);
    expect(direction === 'undo' ? editor.canUndo : editor.canRedo).toBe(true);
    expect(await editor[direction](doc)).toBe(true);
    assertPages(doc, direction === 'undo' ? ['% A', '% B', '% C'] : ['', '% A', '% B', '% C'],
      direction === 'undo' ? [180, 0, 90] : [0, 180, 0, 90]);
  });

  it('keeps source bytes and redo available after failed extraction', async () => {
    const doc = await parsePDF(fixture(indirect));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'blank', async staged => { insertBlankPage(staged, 0); });
    await editor.undo(doc);
    const before = await serializeDocument(doc);
    const failure = new Error('extraction parse failed');
    const parse = vi.spyOn(parser, 'parsePDF').mockRejectedValueOnce(failure);
    try {
      await expect(editor.extractPages(doc, [0])).rejects.toBe(failure);
    } finally {
      parse.mockRestore();
    }
    expect(await serializeDocument(doc)).toEqual(before);
    expect(editor.canRedo).toBe(true);
    assertPages(await parsePDF(await editor.extractPages(doc, [0])), ['% A'], [180]);
  });

  it('does not reuse retained object numbers when branching after blank insertion undo', async () => {
    const doc = await parsePDF(fixture(indirect));
    const first = new SessionDocumentEditor();
    await first.edit(doc, 'blank', async staged => { insertBlankPage(staged, 1); });
    const abandonedRefs = [doc.pages[1].ref, ...doc.pages[1].contentRefs].map(ref => ref.toKey());
    await first.undo(doc);
    const branch = new SessionDocumentEditor();
    await branch.edit(doc, 'import', async staged => {
      insertPagesFromDocument(staged, await parsePDF(fixture(true)), 2);
      insertBlankPage(staged, 0);
    });
    expect(doc.pages.map(page => page.ref.toKey()).filter(key => abandonedRefs.includes(key))).toEqual([]);
    const applied = await serializeDocument(doc);
    assertPages(await parsePDF(applied), ['', '% A', '% B', '% A', '% B', '% C', '% C'], [0, 180, 0, 180, 0, 90, 90]);
    await branch.undo(doc);
    await branch.redo(doc);
    expect(await serializeDocument(doc)).toEqual(applied);
  });
});

describe('ordered page toolbar history', () => {
  it('interleaves legacy overlays with page transactions, selection, and failed redo/branch edits', async () => {
    const doc = await parsePDF(fixture(true));
    const history = new SessionEditorHistory();
    let selected = 1;
    const capture = (label: string, text = '') => captureHistoryEntry(
      doc, selected, getPageContentBytes(doc.pages[selected], doc.objects),
      { ...overlays, floatingTexts: text ? [{ text }] : [] }, label,
    );
    const move = async (direction: 'undo' | 'redo') => {
      const result = await history[direction](doc);
      if (!result) throw new Error('Expected a history boundary');
      if (!result.restoredDocument) await restoreDocumentStructure(doc, result.entry, updatePageContent);
      const index = doc.pages.findIndex(page => page.ref.toKey() === result.entry.pageKey);
      selected = index >= 0 ? index : Math.min(result.entry.pageIndex, doc.pages.length - 1);
      return result.entry;
    };
    history.seed(capture('initial'));
    history.push(capture('legacy-overlay', 'before'));
    const original = await serializeDocument(doc);
    const reorder = new SessionDocumentEditor();
    await reorder.edit(doc, 'reorder', async staged => { movePage(staged, 1, 0); });
    selected = 0;
    history.push(capture('reorder', 'before'), reorder);
    const reordered = await serializeDocument(doc);
    history.push(capture('legacy-overlay-2', 'after'));
    const insert = new SessionDocumentEditor();
    await insert.edit(doc, 'blank', async staged => { insertBlankPage(staged, 0); });
    selected = 1;
    history.push(capture('blank', 'after'), insert);
    const inserted = await serializeDocument(doc);
    const remove = new SessionDocumentEditor();
    await remove.edit(doc, 'delete', async staged => { deletePage(staged, 1); });
    selected = 1;
    history.push(capture('delete', 'after'), remove);
    const deleted = await serializeDocument(doc);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect((await move('undo')).label).toBe('blank');
      expect(selected).toBe(1);
      expect(doc.pages).toHaveLength(4);
      expect(await serializeDocument(doc)).toEqual(inserted);
      expect((await move('undo')).label).toBe('legacy-overlay-2');
      expect(selected).toBe(0);
      expect(await serializeDocument(doc)).toEqual(reordered);
      expect((await move('undo')).label).toBe('reorder');
      expect(labels(doc)).toEqual(['% B', '% A', '% C']);
      expect((await move('undo')).overlays.floatingTextsJson).toBe('[{"text":"before"}]');
      expect(selected).toBe(1);
      expect(await serializeDocument(doc)).toEqual(original);
      expect((await move('redo')).label).toBe('reorder');
      expect(await serializeDocument(doc)).toEqual(reordered);
      expect((await move('redo')).overlays.floatingTextsJson).toBe('[{"text":"after"}]');
      expect((await move('redo')).label).toBe('blank');
      expect(await serializeDocument(doc)).toEqual(inserted);
      expect((await move('redo')).label).toBe('delete');
      expect(await serializeDocument(doc)).toEqual(deleted);
    }
    await move('undo');
    const failure = new Error('restore failed');
    const restore = vi.spyOn(remove, 'redo').mockRejectedValueOnce(failure);
    await expect(history.redo(doc)).rejects.toBe(failure);
    restore.mockRestore();
    expect(history.peek()?.label).toBe('blank');
    expect(history.canRedo()).toBe(true);
    expect(await serializeDocument(doc)).toEqual(inserted);
    const branch = new SessionDocumentEditor();
    await expect(branch.edit(doc, 'rotate', async staged => {
      rotatePageBy(staged, 1, 90);
      throw failure;
    })).rejects.toBe(failure);
    expect(history.canRedo()).toBe(true);
    expect(await serializeDocument(doc)).toEqual(inserted);
    await branch.edit(doc, 'rotate', async staged => { rotatePageBy(staged, 1, 90); });
    history.push(capture('rotate'), branch);
    const rotated = await serializeDocument(doc);
    expect(history.canRedo()).toBe(false);
    await move('undo');
    expect(await serializeDocument(doc)).toEqual(inserted);
    await move('redo');
    expect(await serializeDocument(doc)).toEqual(rotated);
    expect(doc.pages[1].rotate).toBe(90);
  });
});
