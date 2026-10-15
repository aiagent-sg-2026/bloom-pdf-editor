import { describe, it, expect } from 'vitest';
import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  type PDFPageInfo,
} from '../types';
import {
  applyWatermarkToPage,
  buildTextWatermarkContent,
  type TextWatermark,
} from '../watermark/watermark-engine';

function makePage(objects: Map<string, PDFObject>, content: string): PDFPageInfo {
  const contentRef = new PDFRef(2, 0);
  const dict = new PDFDict();
  dict.set('Type', new PDFName('Page'));
  dict.set('Contents', contentRef);
  dict.set('Resources', new PDFDict());
  objects.set(contentRef.toKey(), new PDFStream(
    (() => {
      const d = new PDFDict();
      d.set('Length', new PDFNumber(content.length));
      return d;
    })(),
    new TextEncoder().encode(content),
  ));

  return {
    index: 0,
    dict,
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    rotate: 0,
    ref: new PDFRef(1, 0),
    resources: dict.get('Resources') as PDFDict,
    contentRefs: [contentRef],
  };
}

function textWm(overrides: Partial<TextWatermark> = {}): TextWatermark {
  return {
    id: 'wm-test-01',
    type: 'text',
    text: 'DRAFT',
    opacity: 0.5,
    rotation: 0,
    tile: false,
    layer: 'above',
    fontName: 'Helvetica',
    fontSize: 48,
    color: [0.5, 0.5, 0.5],
    position: 'center',
    ...overrides,
  };
}

describe('watermark CTM isolation', () => {
  it('wraps existing content in q/Q so leftover CTM cannot tilt the watermark', async () => {
    const objects = new Map<string, PDFObject>();
    // Unbalanced cm left active — common in buggy / generated PDFs
    const dirty = '0.7071 0.7071 -0.7071 0.7071 100 200 cm\nBT /F1 12 Tf 0 0 Td (Hello) Tj ET\n';
    const page = makePage(objects, dirty);
    let next = 10;

    const out = await applyWatermarkToPage(
      new TextEncoder().encode(dirty),
      page,
      objects,
      textWm({ rotation: 0 }),
      612,
      792,
      () => next++,
    );

    const s = new TextDecoder().decode(out);
    // Existing content must be wrapped so CTM is restored before watermark
    expect(s.startsWith('q\n')).toBe(true);
    expect(s).toContain('(Hello)');
    expect(s).toContain('(DRAFT)');

    // Structure: q … original … Q … watermark(DRAFT)
    const helloIdx = s.indexOf('(Hello)');
    const draftIdx = s.indexOf('(DRAFT)');
    expect(helloIdx).toBeGreaterThan(0);
    expect(draftIdx).toBeGreaterThan(helloIdx);

    // The wrap restore must sit between original content and the watermark text
    const between = s.slice(helloIdx, draftIdx);
    expect(between).toContain('\nQ\n');

    // rotation 0 → no leftover page CTM coefficients in the watermark section
    const afterRestore = s.slice(s.indexOf('\nQ\n', helloIdx));
    expect(afterRestore).not.toMatch(/0\.7071/);
  });

  it('places below-layer watermark before wrapped content', async () => {
    const objects = new Map<string, PDFObject>();
    const page = makePage(objects, 'BT /F1 12 Tf 100 700 Td (Hi) Tj ET\n');
    let next = 10;

    const out = await applyWatermarkToPage(
      new TextEncoder().encode('BT /F1 12 Tf 100 700 Td (Hi) Tj ET\n'),
      page,
      objects,
      textWm({ layer: 'below', rotation: 0 }),
      612,
      792,
      () => next++,
    );

    const s = new TextDecoder().decode(out);
    expect(s.indexOf('(DRAFT)')).toBeLessThan(s.indexOf('(Hi)'));
  });

  it('offsets positions by MediaBox origin', () => {
    const bytes = buildTextWatermarkContent(
      textWm({ rotation: 0, position: 'center' }),
      612,
      792,
      100,
      50,
    );
    const s = new TextDecoder().decode(bytes);
    // center = origin + size/2 → (100+306, 50+396) = (406, 446)
    expect(s).toContain('1 0 0 1 406 446 cm');
  });
});
