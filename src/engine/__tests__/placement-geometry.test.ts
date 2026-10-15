import { describe, expect, it } from 'vitest';
import { canvasToPdf as editorCanvasToPdf } from '../../app/editor/utils';
import { parseContentStream } from '../content/operator-lexer';
import { canvasToPdf, intersectPageBox, type ViewportTransform } from '../editing/coordinates';
import { addAnnotationToPage, createAnnotationDict } from '../editor/annotation-engine';
import { parsePDF, resolveRef } from '../parser/parser';
import { createSignatureFieldAtPoint, placeSignatureInField } from '../signatures/fields/signature-field';
import { applyWatermarks, type TextWatermark } from '../watermark/watermark-engine';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, type PDFDocumentData } from '../types';

type Box = [number, number, number, number];
type Rotation = 0 | 90 | 180 | 270;

const rotations: Rotation[] = [0, 90, 180, 270];
// A viewport drag from (40, 60) to (160, 100), before zoom/scroll offsets.
// These are literal PDF-space expectations, not round-trips through the engine.
const letterRects: Record<Rotation, Box> = {
  0: [40, 692, 160, 732],
  90: [60, 40, 100, 160],
  180: [452, 60, 572, 100],
  270: [512, 632, 552, 752],
};
const offsetRects: Record<Rotation, Box> = {
  0: [90, 792, 210, 832],
  90: [110, 140, 150, 260],
  180: [502, 160, 622, 200],
  270: [562, 732, 602, 852],
};
const croppedRects: Record<Rotation, Box> = {
  0: [120, 760, 240, 800],
  90: [140, 180, 180, 300],
  180: [460, 200, 580, 240],
  270: [520, 700, 560, 820],
};
const geometries: { name: string; media: Box; crop?: Box; expected: Record<Rotation, Box> }[] = [
  { name: 'zero origin', media: [0, 0, 612, 792], expected: letterRects },
  { name: 'offset origin', media: [50, 100, 662, 892], expected: offsetRects },
  { name: 'reversed MediaBox', media: [662, 892, 50, 100], expected: offsetRects },
  {
    name: 'inset reversed CropBox', media: [50, 100, 662, 892], crop: [620, 860, 80, 140],
    expected: croppedRects,
  },
];

/** A complete ASCII-only PDF, including accurate xref offsets, built entirely in memory. */
async function syntheticPage(media: Box, rotation: Rotation, inherited: boolean, crop?: Box): Promise<PDFDocumentData> {
  const geometry = `/MediaBox [${media.join(' ')}] /Rotate ${rotation}${crop ? ` /CropBox [${crop.join(' ')}]` : ''}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count 1 ${inherited ? geometry : ''} >>`,
    `<< /Type /Page /Parent 2 0 R /Resources << >> ${inherited ? '' : geometry} >>`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return parsePDF(new TextEncoder().encode(pdf));
}

function normalAppearance(doc: PDFDocumentData, dict: PDFDict): PDFStream {
  const ap = resolveRef(dict.get('AP')!, doc.objects) as PDFDict;
  return resolveRef(ap.get('N')!, doc.objects) as PDFStream;
}

const cases = geometries.flatMap(geometry => rotations.flatMap(rotation => [false, true].map(inherited => ({
  ...geometry, rotation, inherited,
  expectedRect: geometry.expected[rotation],
}))));

describe('viewport placement on parsed page geometry', () => {
  it.each(cases)('$name, Rotate $rotation, inherited $inherited: widget and annotation Rect/AP survive export', async ({ media, crop, rotation, inherited, expectedRect }) => {
    const doc = await syntheticPage(media, rotation, inherited, crop);
    const page = doc.pages[0];
    const visible = intersectPageBox(page.mediaBox, page.cropBox);
    const transform: ViewportTransform = {
      scale: 2, offsetX: 17, offsetY: 23, rotation: page.rotate,
      pageX: visible.x, pageY: visible.y, pageWidth: visible.width, pageHeight: visible.height,
    };
    const fromViewport = (x: number, y: number) => {
      const cssX = x * 2 + 17;
      const cssY = y * 2 + 23;
      const point = canvasToPdf(cssX, cssY, transform);
      const sideways = page.rotate === 90 || page.rotate === 270;
      // The editor helper takes rotated viewport dimensions, unlike the engine helper.
      expect(editorCanvasToPdf(
        cssX - 17, cssY - 23, 2,
        sideways ? visible.height : visible.width, sideways ? visible.width : visible.height,
        page.mediaBox.x, page.mediaBox.y, page.rotate, visible.x, visible.y,
      )).toEqual({ pdfX: point.x, pdfY: point.y });
      return point;
    };
    const a = fromViewport(40, 60);
    const b = fromViewport(160, 100);
    const center = fromViewport(100, 80);
    const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    const field = createSignatureFieldAtPoint(doc, 0, center.x, center.y, {
      fieldName: 'GeometrySignature', width: rect.width, height: rect.height,
    });
    placeSignatureInField(doc, field.ref, { width: rect.width, height: rect.height, typedName: 'Synthetic Signer' });
    const annotRef = new PDFRef(getNextObjNum(doc), 0);
    const { dict } = createAnnotationDict({ type: 'Square', rect, color: [1, 0, 0], opacity: 1, lineWidth: 1 }, annotRef.objNum, doc.objects);
    addAnnotationToPage(page.dict, dict, annotRef, doc.objects);

    // Check both the edited document and what a consumer reads after serialization.
    for (const result of [doc, await parsePDF(await serializeDocument(doc))]) {
      const annots = resolveRef(result.pages[0].dict.get('Annots')!, result.objects) as PDFArray;
      const widget = annots.items.map(ref => resolveRef(ref, result.objects) as PDFDict).find(d => d.getName('Subtype') === 'Widget')!;
      const annotation = annots.items.map(ref => resolveRef(ref, result.objects) as PDFDict).find(d => d.getName('Subtype') === 'Square')!;
      const [x1, y1, x2, y2] = expectedRect;
      for (const placed of [widget, annotation]) {
        expect((placed.get('Rect') as PDFArray).asNumbers()).toEqual(expectedRect);
        const appearance = normalAppearance(result, placed);
        expect((appearance.dict.get('BBox') as PDFArray).asNumbers()).toEqual([0, 0, x2 - x1, y2 - y1]);
        // Missing /Matrix has the PDF default identity; neither appearance translates by page origin.
        const matrix = appearance.dict.get('Matrix');
        expect(matrix instanceof PDFArray ? matrix.asNumbers() : [1, 0, 0, 1, 0, 0]).toEqual([1, 0, 0, 1, 0, 0]);
      }
    }
  });
});

// Watermark presets are MediaBox-relative; custom positions are already PDF user space.
describe('watermark page origins', () => {
  it.each(geometries.slice(0, 3))('$name: preserves preset and custom user-space positions', async ({ media }) => {
    const doc = await syntheticPage(media, 90, true);
    const base: TextWatermark = {
      id: 'geometry', type: 'text', text: 'Synthetic', fontName: 'Helvetica', fontSize: 12,
      color: [0, 0, 0], opacity: 1, rotation: 0, tile: false, layer: 'above', position: 'center',
    };
    const center = media[0] === 0 ? [306, 396] : [356, 496];
    const positions: { position: TextWatermark['position']; expected: number[] }[] = [
      { position: 'center', expected: center },
      { position: [123, 234], expected: [123, 234] },
    ];
    for (const { position, expected } of positions) {
      let next = getNextObjNum(doc);
      const bytes = (await applyWatermarks(doc, [{ ...base, position }], () => next++)).get(0)!;
      const translations = parseContentStream(bytes).filter(inst => inst.operator === 'cm').map(inst => inst.operands.map(n => (n as PDFNumber).value));
      expect(translations[0]).toEqual([1, 0, 0, 1, ...expected]);
    }
  });
});
