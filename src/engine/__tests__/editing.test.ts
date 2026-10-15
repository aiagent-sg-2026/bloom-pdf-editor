import { describe, it, expect } from 'vitest';
import {
  composeTransform,
  invertAffine,
  transformObject,
  snapToGuides,
} from '../editing/transform-editor';
import { buildPageGuides, buildObjectGuides, type SnapGuide } from '../editing/snap-guides';
import { buildSceneGraph, type EditableObject } from '../editing/scene-graph';
import { applyObjectTransform, deleteObject } from '../editor/object-editor';
import { markRedaction, applyRedactions, unionRects, rectsOverlap } from '../editor/redaction';
import {
  lineSelectionToQuadPoints,
  multiLineSelectionToQuadPoints,
  addHighlightFromSelection,
} from '../flow/selection-quads';
import { interpretPage } from '../content/interpreter';
import type { DisplayItem, TextRun, ImageItem, PathItem } from '../content/interpreter';
import { getPageContentBytes } from '../parser/parser';
import { createAnnotationDict, type Annotation } from '../editor/annotation-engine';
import type { TextLine } from '../flow/types';
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

// ─── Test doc builders ──────────────────────────────────────────────────────

function textEncode(s: string): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(s);
}

/** A minimal single-page document with an editable content stream, ready for object/redaction editing. */
function buildTestDoc(contentSource: string): { doc: PDFDocumentData; page: PDFPageInfo } {
  const pageRef = new PDFRef(3, 0);
  const contentRef = new PDFRef(4, 0);
  const fontRef = new PDFRef(5, 0);
  const imageRef = new PDFRef(6, 0);

  const fontDict = new PDFDict();
  fontDict.set('Type', new PDFName('Font'));
  fontDict.set('Subtype', new PDFName('Type1'));
  fontDict.set('BaseFont', new PDFName('Helvetica'));

  const imageDict = new PDFDict();
  imageDict.set('Type', new PDFName('XObject'));
  imageDict.set('Subtype', new PDFName('Image'));
  imageDict.set('Width', new PDFNumber(10));
  imageDict.set('Height', new PDFNumber(10));
  imageDict.set('ColorSpace', new PDFName('DeviceRGB'));
  imageDict.set('BitsPerComponent', new PDFNumber(8));
  const imageStream = new PDFStream(imageDict, new Uint8Array(300));

  const fontsRes = new PDFDict();
  fontsRes.set('F1', fontRef);
  const xobjRes = new PDFDict();
  xobjRes.set('Im1', imageRef);

  const resources = new PDFDict();
  resources.set('Font', fontsRes);
  resources.set('XObject', xobjRes);

  const pageDict = new PDFDict();
  pageDict.set('Type', new PDFName('Page'));
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  pageDict.set('Resources', resources);
  pageDict.set('Contents', contentRef);

  const contentBytes = textEncode(contentSource);
  const contentStream = new PDFStream(new PDFDict(), contentBytes, contentBytes);

  const objects = new Map<string, import('../types').PDFObject>();
  objects.set(pageRef.toKey(), pageDict);
  objects.set(contentRef.toKey(), contentStream);
  objects.set(fontRef.toKey(), fontDict);
  objects.set(imageRef.toKey(), imageStream);

  const page: PDFPageInfo = {
    index: 0,
    dict: pageDict,
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    rotate: 0,
    ref: pageRef,
    resources,
    contentRefs: [contentRef],
  };

  const doc: PDFDocumentData = {
    version: '1.7',
    objects,
    xref: { entries: new Map(), trailerDict: new PDFDict() },
    catalog: new PDFDict(),
    pages: [page],
    info: {},
    rawBytes: new Uint8Array(0),
  };

  return { doc, page };
}

function interpretDoc(doc: PDFDocumentData, page: PDFPageInfo): DisplayItem[] {
  const bytes = getPageContentBytes(page, doc.objects);
  return interpretPage(bytes, page, doc.objects).displayList;
}

// ─── Transform math ─────────────────────────────────────────────────────────

describe('transform-editor: composeTransform / invertAffine', () => {
  it('invertAffine inverts the identity to itself', () => {
    expect(invertAffine([1, 0, 0, 1, 0, 0])).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('invertAffine returns null for a singular matrix', () => {
    expect(invertAffine([0, 0, 0, 0, 5, 5])).toBeNull();
  });

  it('invertAffine(M) composed with M cancels out (round trip)', () => {
    const m = composeTransform([1, 0, 0, 1, 10, 20], { dx: 5, dy: -5 }, { sx: 2, sy: 0.5 }, 30, { x: 50, y: 50 });
    const inv = invertAffine(m)!;
    // M * inv(M) == identity, using the same row-vector convention as PDF `cm`.
    const [a1, b1, c1, d1, e1, f1] = m;
    const [a2, b2, c2, d2, e2, f2] = inv;
    const result = [
      a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
      c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
      e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2,
    ];
    for (let i = 0; i < 6; i++) expect(result[i]).toBeCloseTo([1, 0, 0, 1, 0, 0][i], 6);
  });

  it('composeTransform applies a pure translation', () => {
    const m = composeTransform([1, 0, 0, 1, 0, 0], { dx: 15, dy: -8 });
    expect(m).toEqual([1, 0, 0, 1, 15, -8]);
  });

  it('composeTransform rotates 90deg about a pivot without translating the pivot', () => {
    // Rotating a point at the pivot by 90deg about itself should stay put.
    const pivot = { x: 100, y: 100 };
    const m = composeTransform([1, 0, 0, 1, 0, 0], undefined, undefined, 90, pivot);
    const px = pivot.x * m[0] + pivot.y * m[2] + m[4];
    const py = pivot.x * m[1] + pivot.y * m[3] + m[5];
    expect(px).toBeCloseTo(pivot.x, 5);
    expect(py).toBeCloseTo(pivot.y, 5);
  });
});

describe('transform-editor: transformObject', () => {
  const obj: EditableObject = {
    id: 'path-0',
    kind: 'path',
    bbox: { x: 10, y: 10, width: 100, height: 50 },
    ctm: [1, 0, 0, 1, 0, 0],
  };

  it('translates the bbox by dx/dy', () => {
    const moved = transformObject(obj, { dx: 20, dy: -5 });
    expect(moved.bbox.x).toBeCloseTo(30, 5);
    expect(moved.bbox.y).toBeCloseTo(5, 5);
    expect(moved.bbox.width).toBeCloseTo(100, 5);
    expect(moved.bbox.height).toBeCloseTo(50, 5);
  });

  it('scales the bbox around its own center', () => {
    const scaled = transformObject(obj, { scaleX: 2, scaleY: 1 });
    expect(scaled.bbox.width).toBeCloseTo(200, 5);
    expect(scaled.bbox.height).toBeCloseTo(50, 5);
    // Center should stay put: original center x = 60
    expect(scaled.bbox.x + scaled.bbox.width / 2).toBeCloseTo(60, 5);
  });

  it('rotating 180deg around center keeps the same bbox', () => {
    const rotated = transformObject(obj, { rotateDeg: 180 });
    expect(rotated.bbox.x).toBeCloseTo(obj.bbox.x, 5);
    expect(rotated.bbox.y).toBeCloseTo(obj.bbox.y, 5);
    expect(rotated.bbox.width).toBeCloseTo(obj.bbox.width, 5);
    expect(rotated.bbox.height).toBeCloseTo(obj.bbox.height, 5);
  });
});

describe('transform-editor: snapToGuides', () => {
  const guides: SnapGuide[] = buildPageGuides(600, 800);

  it('snaps to the nearest guide within threshold', () => {
    const bbox = { x: 4, y: 4, width: 50, height: 50 };
    const snapped = snapToGuides(bbox, guides, 8);
    expect(snapped.x).toBe(0); // left edge snaps to page-left
    expect(snapped.y).toBe(0); // bottom edge snaps to page-bottom
  });

  it('does not snap when outside threshold', () => {
    const bbox = { x: 100, y: 100, width: 50, height: 50 };
    const snapped = snapToGuides(bbox, guides, 8);
    expect(snapped.x).toBe(100);
    expect(snapped.y).toBe(100);
  });

  it('builds alignment guides from sibling objects', () => {
    const objects: EditableObject[] = [
      { id: 'a', kind: 'path', bbox: { x: 0, y: 0, width: 20, height: 20 }, ctm: [1, 0, 0, 1, 0, 0] },
      { id: 'b', kind: 'path', bbox: { x: 100, y: 100, width: 20, height: 20 }, ctm: [1, 0, 0, 1, 0, 0] },
    ];
    const objGuides = buildObjectGuides(objects, 'b');
    expect(objGuides.some((g) => g.label === 'a-left' && g.position === 0)).toBe(true);
    expect(objGuides.some((g) => (g.label ?? '').startsWith('b-'))).toBe(false);
  });
});

// ─── Scene graph ────────────────────────────────────────────────────────────

describe('scene-graph: buildSceneGraph', () => {
  it('extracts images, paths, and text with correct kind/bbox', () => {
    const image: ImageItem = {
      type: 'image', name: 'Im1',
      ctm: { a: 50, b: 0, c: 0, d: 50, e: 100, f: 200 },
      x: 100, y: 200, width: 50, height: 50,
      fillAlpha: 1,
      blendMode: 'Normal', softMask: null, clipPaths: [],
    };
    const path: PathItem = {
      type: 'path', segments: [], strokeColor: null, fillColor: [1, 0, 0],
      strokeAlpha: 1, fillAlpha: 1, lineWidth: 1, paintType: 'fill',
      x: 10, y: 10, width: 30, height: 20,
      blendMode: 'Normal', softMask: null, clipPaths: [],
    };
    const text: TextRun = {
      type: 'text', text: 'Hi', glyphs: [], sourceInstructionIndices: [3],
      x: 5, y: 5, width: 12, height: 10, fontName: 'F1', fontSize: 12,
      textMatrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 },
      fillColor: [0, 0, 0], fillAlpha: 1, blendMode: 'Normal', softMask: null, clipPaths: [],
    };

    const scene = buildSceneGraph([image, path, text]);
    expect(scene).toHaveLength(3);

    expect(scene[0].kind).toBe('image');
    expect(scene[0].ctm).toEqual([50, 0, 0, 50, 100, 200]);
    expect(scene[0].bbox).toEqual({ x: 100, y: 200, width: 50, height: 50 });

    expect(scene[1].kind).toBe('path');
    expect(scene[1].ctm).toEqual([1, 0, 0, 1, 0, 0]);

    expect(scene[2].kind).toBe('text');
    expect(scene[2].contentRange).toEqual({ startOp: 3, endOp: 3 });
  });
});

// ─── Selection quads ────────────────────────────────────────────────────────

function makeLine(text: string, y: number, fontSize = 12): TextLine {
  const glyphs = [];
  let x = 0;
  for (let i = 0; i < text.length; i++) {
    glyphs.push({
      charCode: text.charCodeAt(i),
      unicode: text[i],
      x, y, width: 6, fontSize,
      textSpaceWidth: 0.5,
      tRm: { a: fontSize, b: 0, c: 0, d: fontSize, e: x, f: y },
    });
    x += 6;
  }
  const run: TextRun = {
    type: 'text', text, glyphs, x: 0, y, width: x, height: fontSize,
    fontName: 'F1', fontSize,
    textMatrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: y },
    fillColor: [0, 0, 0], fillAlpha: 1, blendMode: 'Normal', softMask: null, clipPaths: [],
  };
  return {
    id: `line-${y}`, runs: [run], text,
    segments: [{ run, startIndex: 0, endIndex: text.length, text }],
    baseline: y, x: 0, y, width: x, height: fontSize,
    leftMargin: 0, rightEdge: x, fontSize, isJustified: false, tabSplitIndex: -1,
  };
}

describe('selection-quads: lineSelectionToQuadPoints', () => {
  it('returns a single quad spanning the selected character range', () => {
    const line = makeLine('Hello World', 700);
    const quad = lineSelectionToQuadPoints(line, 0, 5); // "Hello"
    expect(quad).toHaveLength(8);
    const [x1, y1, x2] = quad;
    expect(x1).toBe(0); // left edge of first glyph
    expect(x2).toBeCloseTo(5 * 6, 5); // right edge of 5th glyph
    expect(y1).toBeCloseTo(700 + 12 * 0.85, 5); // top from glyph ascent
  });

  it('returns an empty array for an empty range', () => {
    const line = makeLine('Hello', 700);
    expect(lineSelectionToQuadPoints(line, 3, 3)).toEqual([]);
  });
});

describe('selection-quads: multiLineSelectionToQuadPoints', () => {
  it('produces one quad per spanned line, normalizing reversed selections', () => {
    const line1 = makeLine('First line', 700);
    const line2 = makeLine('Second line', 686);
    const quadsForward = multiLineSelectionToQuadPoints([line1, line2], 0, 2, 1, 3);
    const quadsReversed = multiLineSelectionToQuadPoints([line1, line2], 1, 3, 0, 2);
    expect(quadsForward.length).toBe(16); // two quads of 8 numbers each
    expect(quadsForward).toEqual(quadsReversed);
  });
});

// ─── Object editor (content-stream mutation) ───────────────────────────────

describe('object-editor: applyObjectTransform', () => {
  it('moves an image XObject placement in the content stream', async () => {
    const { doc, page } = buildTestDoc('q\n50 0 0 50 100 200 cm\n/Im1 Do\nQ\n');

    const before = interpretDoc(doc, page);
    const scene = buildSceneGraph(before);
    const imageObj = scene.find((o) => o.kind === 'image')!;
    expect(imageObj.bbox).toEqual({ x: 100, y: 200, width: 50, height: 50 });

    const moved = transformObject(imageObj, { dx: 20, dy: -30 });
    await applyObjectTransform(doc, 0, imageObj, moved.ctm);

    const after = interpretDoc(doc, page);
    const movedImage = after.find((d): d is ImageItem => d.type === 'image')!;
    expect(movedImage.x).toBeCloseTo(120, 1);
    expect(movedImage.y).toBeCloseTo(170, 1);
    expect(movedImage.width).toBeCloseTo(50, 1);
  });

  it('moves a filled path in the content stream', async () => {
    const { doc, page } = buildTestDoc('1 0 0 rg\n50 50 100 60 re\nf\n');

    const before = interpretDoc(doc, page);
    const scene = buildSceneGraph(before);
    const pathObj = scene.find((o) => o.kind === 'path')!;
    expect(pathObj.bbox).toEqual({ x: 50, y: 50, width: 100, height: 60 });

    const moved = transformObject(pathObj, { dx: 10, dy: 10 });
    await applyObjectTransform(doc, 0, pathObj, moved.ctm);

    const after = interpretDoc(doc, page);
    const movedPath = after.find((d): d is PathItem => d.type === 'path')!;
    expect(movedPath.x).toBeCloseTo(60, 1);
    expect(movedPath.y).toBeCloseTo(60, 1);
  });
});

describe('object-editor: deleteObject', () => {
  it('removes an image from the content stream', async () => {
    const { doc, page } = buildTestDoc('q\n50 0 0 50 100 200 cm\n/Im1 Do\nQ\n');
    const scene = buildSceneGraph(interpretDoc(doc, page));
    const imageObj = scene.find((o) => o.kind === 'image')!;

    await deleteObject(doc, 0, imageObj);

    const after = interpretDoc(doc, page);
    expect(after.some((d) => d.type === 'image')).toBe(false);
  });

  it('deletes only the targeted image when two images exist', async () => {
    // Register a second image resource
    const { doc, page } = buildTestDoc(
      'q\n40 0 0 40 50 500 cm\n/Im1 Do\nQ\nq\n60 0 0 60 200 100 cm\n/Im2 Do\nQ\n',
    );
    // Add Im2 to resources
    const resources = page.dict.get('Resources') as PDFDict;
    const xobjects = resources.get('XObject') as PDFDict;
    const imageDict = new PDFDict();
    imageDict.set('Type', new PDFName('XObject'));
    imageDict.set('Subtype', new PDFName('Image'));
    imageDict.set('Width', new PDFNumber(10));
    imageDict.set('Height', new PDFNumber(10));
    imageDict.set('ColorSpace', new PDFName('DeviceRGB'));
    imageDict.set('BitsPerComponent', new PDFNumber(8));
    const imageStream = new PDFStream(imageDict, new Uint8Array(300));
    const imgRef = new PDFRef(30, 0);
    doc.objects.set(imgRef.toKey(), imageStream);
    xobjects.set('Im2', imgRef);

    const before = interpretDoc(doc, page);
    const images = before.filter((d): d is ImageItem => d.type === 'image');
    expect(images.length).toBe(2);

    const scene = buildSceneGraph(before);
    const second = scene.find((o) => o.kind === 'image' && (o.source as ImageItem).name === 'Im2')!;
    await deleteObject(doc, 0, second);

    const after = interpretDoc(doc, page);
    const remaining = after.filter((d): d is ImageItem => d.type === 'image');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Im1');
  });

  it('refuses to delete when image cannot be located (no blanking)', async () => {
    const { doc, page } = buildTestDoc('q\n50 0 0 50 100 200 cm\n/Im1 Do\nQ\n');
    const fake: EditableObject = {
      id: 'bogus',
      kind: 'image',
      bbox: { x: 999, y: 999, width: 10, height: 10 },
      ctm: [10, 0, 0, 10, 999, 999],
      source: {
        type: 'image',
        name: 'DoesNotExist',
        ctm: { a: 10, b: 0, c: 0, d: 10, e: 999, f: 999 },
        x: 999, y: 999, width: 10, height: 10,
        fillAlpha: 1,
        blendMode: 'Normal', softMask: null, clipPaths: [],
      },
    };
    await expect(deleteObject(doc, 0, fake)).rejects.toThrow(/Could not locate/);
    const after = interpretDoc(doc, page);
    expect(after.some((d) => d.type === 'image')).toBe(true);
  });

  it('deletes only the image Do — not other content inside the same q/Q', async () => {
    // Outer q/Q wraps text AND an image. Old bug peeled q…Q and wiped the page.
    const { doc, page } = buildTestDoc(
      'q\nBT\n/F1 12 Tf\n100 700 Td\n(Keep me) Tj\nET\n40 0 0 40 200 100 cm\n/Im1 Do\nQ\n',
    );
    const before = interpretDoc(doc, page);
    expect(before.some((d) => d.type === 'text')).toBe(true);
    expect(before.some((d) => d.type === 'image')).toBe(true);

    const scene = buildSceneGraph(before);
    const imageObj = scene.find((o) => o.kind === 'image')!;
    await deleteObject(doc, 0, imageObj);

    const after = interpretDoc(doc, page);
    expect(after.some((d) => d.type === 'image')).toBe(false);
    expect(after.some((d) => d.type === 'text')).toBe(true);
    const text = after.find((d): d is TextRun => d.type === 'text')!;
    expect(text.text).toContain('Keep me');
  });

  it('removes a text run from the content stream', async () => {
    const { doc, page } = buildTestDoc('BT\n/F1 12 Tf\n100 700 Td\n(Hello) Tj\nET\n');
    const scene = buildSceneGraph(interpretDoc(doc, page));
    const textObj = scene.find((o) => o.kind === 'text')!;

    await deleteObject(doc, 0, textObj);

    const after = interpretDoc(doc, page);
    expect(after.some((d) => d.type === 'text')).toBe(false);
  });
});

describe('object-editor: resize image', () => {
  it('scales an image placement via applyObjectTransform', async () => {
    const { doc, page } = buildTestDoc('q\n50 0 0 50 100 200 cm\n/Im1 Do\nQ\n');
    const before = interpretDoc(doc, page);
    const scene = buildSceneGraph(before);
    const imageObj = scene.find((o) => o.kind === 'image')!;

    await applyObjectTransform(doc, 0, imageObj, [100, 0, 0, 80, 100, 170]);

    const after = interpretDoc(doc, page);
    const img = after.find((d): d is ImageItem => d.type === 'image')!;
    expect(img.width).toBeCloseTo(100, 1);
    expect(img.height).toBeCloseTo(80, 1);
    expect(img.x).toBeCloseTo(100, 1);
    expect(img.y).toBeCloseTo(170, 1);
  });

  it('moves a clipped image by re-placing it unclipped (leaves shared clips alone)', async () => {
    // Classic certificate pattern: clip rect then image cm/Do inside q/Q
    const { doc, page } = buildTestDoc(
      'q\n100 200 50 50 re\nW\nn\n50 0 0 50 100 200 cm\n/Im1 Do\nQ\n',
    );
    const before = interpretDoc(doc, page);
    const scene = buildSceneGraph(before);
    const imageObj = scene.find((o) => o.kind === 'image')!;
    expect(imageObj.bbox.x).toBeCloseTo(100, 1);

    const moved = transformObject(imageObj, { dx: 40, dy: -20 });
    await applyObjectTransform(doc, 0, imageObj, moved.ctm);

    const after = interpretDoc(doc, page);
    const img = after.find((d): d is ImageItem => d.type === 'image')!;
    expect(img.x).toBeCloseTo(140, 1);
    expect(img.y).toBeCloseTo(180, 1);
    // Extract-and-reinsert places the image without the old clip so it cannot
    // sit under a stale rect (and we never mutate clips that also crop text).
    expect(img.clipPaths.length).toBe(0);
  });

  it('moves an image on a page whose content opens with a flip cm (cairo/Firefox style)', async () => {
    // Synthetic page: `1 0 0 -1 0 842 cm` stays live to the end of the stream,
    // so the appended placement must be expressed relative to it. Regression:
    // the image used to jump to the page bottom and render mirrored.
    const { doc, page } = buildTestDoc(
      '1 0 0 -1 0 842 cm\n' +
      'q\n50 0 0 -50 100 300 cm\n/Im1 Do\nQ\n' +
      'BT\n/F1 12 Tf\n1 0 0 -1 72 100 Tm\n(Keep me) Tj\nET\n',
    );
    const before = interpretDoc(doc, page);
    const imgBefore = before.find((d): d is ImageItem => d.type === 'image')!;
    const scene = buildSceneGraph(before);
    const imageObj = scene.find((o) => o.kind === 'image')!;

    const moved = transformObject(imageObj, { dx: 20, dy: -30 });
    await applyObjectTransform(doc, 0, imageObj, moved.ctm);

    const after = interpretDoc(doc, page);
    const img = after.find((d): d is ImageItem => d.type === 'image')!;
    expect(img.x).toBeCloseTo(imgBefore.x + 20, 1);
    expect(img.y).toBeCloseTo(imgBefore.y - 30, 1);
    expect(img.width).toBeCloseTo(imgBefore.width, 1);
    expect(img.height).toBeCloseTo(imgBefore.height, 1);
    // Orientation preserved (not mirrored).
    expect(Math.sign(img.ctm.d)).toBe(Math.sign(imgBefore.ctm.d));
    expect(Math.sign(img.ctm.a)).toBe(Math.sign(imgBefore.ctm.a));
    // Other content untouched.
    const text = after.find((d): d is TextRun => d.type === 'text')!;
    expect(text.text).toContain('Keep me');
  });

  it('moves an image when a scale cm is left open at the end of the stream', async () => {
    // Unbalanced q: the live CTM at the end of the stream is the 2x scale, so
    // the appended placement must be divided by it.
    const { doc, page } = buildTestDoc(
      'q\n2 0 0 2 0 0 cm\nq\n25 0 0 25 50 100 cm\n/Im1 Do\nQ\n',
    );
    const before = interpretDoc(doc, page);
    const imgBefore = before.find((d): d is ImageItem => d.type === 'image')!;
    const imageObj = buildSceneGraph(before).find((o) => o.kind === 'image')!;

    const moved = transformObject(imageObj, { dx: 40, dy: 10 });
    await applyObjectTransform(doc, 0, imageObj, moved.ctm);

    const img = interpretDoc(doc, page).find((d): d is ImageItem => d.type === 'image')!;
    expect(img.x).toBeCloseTo(imgBefore.x + 40, 1);
    expect(img.y).toBeCloseTo(imgBefore.y + 10, 1);
    expect(img.width).toBeCloseTo(imgBefore.width, 1);
    expect(img.height).toBeCloseTo(imgBefore.height, 1);
  });

  it('does not disturb text when moving an image inside a shared clip', async () => {
    const { doc, page } = buildTestDoc(
      'q\n50 50 400 700 re\nW\nn\n' +
      'BT\n/F1 12 Tf\n100 600 Td\n(INSTITUTE NAME ACADEMY) Tj\nET\n' +
      '50 0 0 50 200 500 cm\n/Im1 Do\n' +
      'Q\n',
    );
    const before = interpretDoc(doc, page);
    const scene = buildSceneGraph(before);
    const imageObj = scene.find((o) => o.kind === 'image')!;
    const textBefore = before.find((d) => d.type === 'text') as { text: string } | undefined;
    expect(textBefore?.text).toContain('INSTITUTE');

    const moved = transformObject(imageObj, { dx: 30, dy: 10 });
    await applyObjectTransform(doc, 0, imageObj, moved.ctm);

    const after = interpretDoc(doc, page);
    const textAfter = after.find((d) => d.type === 'text') as { text: string } | undefined;
    expect(textAfter?.text).toBe(textBefore?.text);
    const img = after.find((d): d is ImageItem => d.type === 'image')!;
    expect(img.x).toBeCloseTo(230, 1);
    expect(img.y).toBeCloseTo(510, 1);
  });
});
// ─── Redaction ──────────────────────────────────────────────────────────────

describe('redaction: unionRects / rectsOverlap', () => {
  it('detects overlap correctly', () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it('merges overlapping rects into a bounding union', () => {
    const merged = unionRects([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });

  it('leaves disjoint rects separate', () => {
    const merged = unionRects([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 100, y: 100, width: 10, height: 10 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('redaction: markRedaction + applyRedactions', () => {
  it('excises overlapping text and burns in a fill rect', async () => {
    const { doc, page } = buildTestDoc('BT\n/F1 12 Tf\n100 700 Td\n(Secret) Tj\nET\n');

    const before = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    const run = before.textRuns[0];
    expect(run).toBeDefined();

    const quadPoints = [
      run.x, run.y + run.height, run.x + run.width, run.y + run.height,
      run.x, run.y, run.x + run.width, run.y,
    ];
    const ref = markRedaction(doc, 0, quadPoints, [0, 0, 0]);

    const annotsBefore = page.dict.get('Annots');
    expect(annotsBefore instanceof PDFArray && annotsBefore.length).toBe(1);

    const result = await applyRedactions(doc, 0);
    expect(result.redactedCount).toBe(1);
    expect(result.removedOperatorCount).toBeGreaterThan(0);

    const after = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(after.textRuns.some((r) => r.text.includes('Secret'))).toBe(false);
    expect(after.displayList.some((d) => d.type === 'path' && d.fillColor?.every((c) => c === 0))).toBe(true);

    const annotsAfter = page.dict.get('Annots');
    expect(annotsAfter instanceof PDFArray ? annotsAfter.length : 0).toBe(0);
    expect(doc.objects.has(ref.toKey())).toBe(false);
  });
});

describe('selection-quads: addHighlightFromSelection', () => {
  it('adds a Highlight annotation covering the selection', () => {
    const { doc } = buildTestDoc('BT\n/F1 12 Tf\n100 700 Td\n(Hello World) Tj\nET\n');
    const line = makeLine('Hello World', 700);

    const ref = addHighlightFromSelection(
      doc, 0, [line],
      { lineIndex: 0, charIndex: 0 },
      { lineIndex: 0, charIndex: 5 },
      [1, 1, 0],
    );

    expect(ref).not.toBeNull();
    const annotDict = doc.objects.get(ref!.toKey()) as PDFDict;
    expect(annotDict.getName('Subtype')).toBe('Highlight');
    const quadPoints = annotDict.get('QuadPoints');
    expect(quadPoints instanceof PDFArray && quadPoints.length).toBe(8);
  });

  it('returns null for an empty selection', () => {
    const { doc } = buildTestDoc('BT\n/F1 12 Tf\n100 700 Td\n(Hello) Tj\nET\n');
    const line = makeLine('Hello', 700);
    const ref = addHighlightFromSelection(
      doc, 0, [line],
      { lineIndex: 0, charIndex: 2 },
      { lineIndex: 0, charIndex: 2 },
    );
    expect(ref).toBeNull();
  });
});

describe('annotation appearances', () => {
  it('stores shape, ink, and highlight appearances as indirect non-empty streams', () => {
    const objects = new Map<string, import('../types').PDFObject>();
    const annotations: Annotation[] = [
      { type: 'Square', rect: { x: 10, y: 20, width: 40, height: 30 }, color: [1, 0, 0], opacity: 1, lineWidth: 2 },
      { type: 'Ink', rect: { x: 10, y: 20, width: 40, height: 30 }, color: [0, 0, 1], opacity: 1, lineWidth: 2, inkPaths: [[10, 20, 30, 40]] },
      { type: 'Highlight', rect: { x: 10, y: 20, width: 40, height: 10 }, color: [1, 1, 0], opacity: 0.4, quadPoints: [10, 30, 50, 30, 50, 20, 10, 20] },
    ];

    annotations.forEach((annotation, index) => {
      const objNum = 20 + index * 2;
      const { dict } = createAnnotationDict(annotation, objNum, objects);
      const ap = dict.get('AP');
      expect(ap instanceof PDFDict).toBe(true);
      const streamRef = (ap as PDFDict).get('N');
      expect(streamRef instanceof PDFRef).toBe(true);
      const stream = objects.get((streamRef as PDFRef).toKey());
      expect(stream instanceof PDFStream).toBe(true);
      expect((stream as PDFStream).rawBytes.length).toBeGreaterThan(0);
      expect((stream as PDFStream).dict.get('BBox')).toBeInstanceOf(PDFArray);
    });
  });
});
