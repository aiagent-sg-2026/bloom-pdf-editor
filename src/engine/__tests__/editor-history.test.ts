import { describe, expect, it } from 'vitest';
import {
  EditorHistory,
  captureHistoryEntry,
  makeOverlaySnapshot,
  type EditorHistoryEntry,
} from '../editing/editor-history';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
  type PDFPageInfo,
} from '../types';

function page(index: number, content: string): { page: PDFPageInfo; ref: PDFRef; stream: PDFStream } {
  const ref = new PDFRef(10 + index, 0);
  const contentRef = new PDFRef(20 + index, 0);
  const dict = new PDFDict();
  dict.set('Type', new PDFName('Page'));
  dict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  dict.set('Contents', contentRef);
  const bytes = new TextEncoder().encode(content);
  const stream = new PDFStream(new PDFDict(), bytes, bytes);
  return {
    ref,
    stream,
    page: {
      index,
      dict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      ref,
      resources: new PDFDict(),
      contentRefs: [contentRef],
    },
  };
}

function documentWithPages(...contents: string[]): PDFDocumentData {
  const built = contents.map((content, index) => page(index, content));
  const objects = new Map<string, import('../types').PDFObject>();
  for (const item of built) {
    objects.set(item.page.ref.toKey(), item.page.dict);
    objects.set(item.page.contentRefs[0].toKey(), item.stream);
  }
  return {
    version: '1.7',
    objects,
    xref: { entries: new Map(), trailerDict: new PDFDict() },
    catalog: new PDFDict(),
    pages: built.map(item => item.page),
    info: {},
    rawBytes: new Uint8Array(),
  } as unknown as PDFDocumentData;
}

const emptyOverlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };

function entry(label: string): EditorHistoryEntry {
  return {
    label,
    timestamp: 0,
    pageIndex: 0,
    contentBytes: new Uint8Array(),
    annotSnapshot: { annotRefKeys: [], objects: new Map() },
    overlays: makeOverlaySnapshot(emptyOverlays),
  };
}

describe('editor history', () => {
  it('captures the current content of every page for multi-page undo', () => {
    const doc = documentWithPages('page zero', 'page one');
    const snapshot = captureHistoryEntry(
      doc,
      1,
      new TextEncoder().encode('edited page one'),
      emptyOverlays,
      'text-edit',
    );

    // getPageContentBytes may append a stream separator, so compare decoded text.
    expect(snapshot.pages?.map(p => new TextDecoder().decode(p.contentBytes).trim())).toEqual([
      'page zero',
      'edited page one',
    ]);
    expect(snapshot.pageIndex).toBe(1);
  });

  it('keeps overlay additions as one undoable state and replaces only a baked state', () => {
    const history = new EditorHistory();
    history.seed(entry('initial'));
    history.push({
      ...entry('add-text-box'),
      overlays: makeOverlaySnapshot({ ...emptyOverlays, floatingTexts: [{ text: 'SESSION BOX' }] }),
    });

    expect(history.canUndo()).toBe(true);
    expect(history.undo()?.label).toBe('initial');
    expect(history.canUndo()).toBe(false);

    history.seed(entry('initial'));
    history.push(entry('edit'));
    history.replace(entry('edit-with-overlay-baked'));
    expect(history.undo()?.label).toBe('initial');
  });

  it('can replace an exported snapshot without clearing redo', () => {
    const history = new EditorHistory();
    history.seed(entry('initial'));
    history.push(entry('draw-rect'));
    history.push(entry('draw-ellipse'));
    expect(history.undo()?.label).toBe('draw-rect');
    history.replace(entry('exported-draw-rect'), true);
    expect(history.canRedo()).toBe(true);
    expect(history.redo()?.label).toBe('draw-ellipse');
  });
});
