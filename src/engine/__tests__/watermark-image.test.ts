import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { updatePageContent } from '../editor/stream-compiler';
import { applyFilters } from '../parser/filters';
import { getPageContentBytes, getResource, parsePDF, resolveRef } from '../parser/parser';
import { decodeImage } from '../render/image-decoder';
import { renderPage } from '../render/renderer';
import { PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { applyWatermarks, type ImageWatermark } from '../watermark/watermark-engine';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { getNextObjNum } from '../writer/serializer';
import { pngChunk, rawPDF, tinyJPEG, tinyPNG } from './audit-p1-fixtures';

function png(colorType: number, depth: number, rows: number[], palette?: number[], alpha?: number[]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = depth;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(palette ? [pngChunk('PLTE', Uint8Array.from(palette))] : []),
    ...(alpha ? [pngChunk('tRNS', Uint8Array.from(alpha))] : []),
    pngChunk('IDAT', deflateSync(Uint8Array.from(rows))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

const transparentPNGs = [
  {
    name: '8-bit RGBA',
    bytes: () => png(6, 8, [0, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 255, 0, 51, 102, 153, 255]),
    rgb: [255, 0, 0, 0, 255, 0, 0, 0, 255, 51, 102, 153],
    alpha: [255, 128, 0, 255],
  },
  ...([2, 8] as const).map(depth => ({
    name: `${depth}-bit palette + tRNS`,
    bytes: () => png(3, depth, depth === 2 ? [0, 0x10, 0, 0x80] : [0, 0, 1, 0, 2, 0],
      [255, 0, 0, 0, 255, 0, 0, 0, 255], [0, 128]),
    rgb: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0],
    alpha: [0, 128, 255, 0], // Missing tRNS entries are opaque.
  })),
];

async function applyInSession(imageBytes: Uint8Array, mimeType: ImageWatermark['mimeType'], opacity = 0.4) {
  const background = '0 0 1 rg 0 0 200 200 re f\n';
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${background.length} >>\nstream\n${background}endstream`,
  ]));
  const wm: ImageWatermark = {
    id: 'alpha001', type: 'image', imageBytes, mimeType,
    width: 60, height: 40, position: 'center',
    opacity, blendMode: 'Multiply', rotation: 0, tile: false, layer: 'above',
  };
  // Match the editor's non-reserving allocator, not just a monotonically increasing counter.
  const results = await applyWatermarks(doc, [wm], () => getNextObjNum(doc));
  for (const [index, bytes] of results) {
    await updatePageContent(doc.pages[index].contentRefs, bytes, doc.objects);
  }
  return doc;
}

async function applyAndReopen(imageBytes: Uint8Array, mimeType: ImageWatermark['mimeType'], save: typeof saveQuick) {
  const doc = await applyInSession(imageBytes, mimeType);
  const reopened = await parsePDF(await save(doc));
  const page = reopened.pages[0];
  const resources = resolveRef(page.dict.get('Resources')!, reopened.objects) as PDFDict;
  const xobjects = resolveRef(resources.get('XObject')!, reopened.objects) as PDFDict;
  const imageRef = xobjects.getRef('ImWM_alpha001');
  expect(imageRef).toBeInstanceOf(PDFRef);
  const image = resolveRef(imageRef!, reopened.objects) as PDFStream;
  expect(image).toBeInstanceOf(PDFStream);
  expect(image.dict.getName('Subtype')).toBe('Image');

  const content = getPageContentBytes(page, reopened.objects);
  const displayed = interpretPage(content, page, reopened.objects).displayList.find(item => item.type === 'image');
  expect(displayed).toMatchObject({ type: 'image', name: 'ImWM_alpha001', width: 60, height: 40, blendMode: 'Multiply' });
  const states = resolveRef(resources.get('ExtGState')!, reopened.objects) as PDFDict;
  const stateName = [...states.keys()][0];
  const state = getResource(resources, 'ExtGState', stateName, reopened.objects) as PDFDict;
  expect(state.getNumber('ca')).toBe(0.4);
  expect(state.getNumber('CA')).toBe(0.4);
  expect(state.getName('BM')).toBe('Multiply');
  expect(new TextDecoder().decode(content)).toContain(`/${stateName} gs`);
  return { reopened, image, imageRef };
}

for (const save of [saveQuick, saveOptimized]) {
  describe(`${save.name} image watermarks`, () => {
    for (const fixture of transparentPNGs) {
      it(`preserves ${fixture.name} alpha through a reachable indirect soft mask`, async () => {
        const { reopened, image, imageRef } = await applyAndReopen(fixture.bytes(), 'image/png', save);
        expect(image.dict.getNumber('Width')).toBe(2);
        expect(image.dict.getNumber('Height')).toBe(2);
        expect(image.dict.getName('ColorSpace')).toBe('DeviceRGB');
        expect(Array.from(await applyFilters(image.rawBytes, image.getFilters(), image.getDecodeParams()))).toEqual(fixture.rgb);
        const maskRef = image.dict.getRef('SMask');
        expect(maskRef).toBeInstanceOf(PDFRef);
        expect(maskRef!.toKey()).not.toBe(imageRef!.toKey());
        const mask = resolveRef(maskRef!, reopened.objects) as PDFStream;
        expect(mask).toBeInstanceOf(PDFStream);
        expect(mask.dict.getName('Subtype')).toBe('Image');
        expect(mask.dict.getName('ColorSpace')).toBe('DeviceGray');
        expect(mask.dict.getNumber('BitsPerComponent')).toBe(8);
        expect(mask.dict.getNumber('Width')).toBe(2);
        expect(mask.dict.getNumber('Height')).toBe(2);
        expect(Array.from(await applyFilters(mask.rawBytes, mask.getFilters(), mask.getDecodeParams()))).toEqual(fixture.alpha);
      });
    }

    it('keeps opaque PNG pixels without a soft mask', async () => {
      const dataUrl = tinyPNG([201, 102, 53, 255, 17, 99, 231, 255]);
      const { image } = await applyAndReopen(Buffer.from(dataUrl.split(',')[1], 'base64'), 'image/png', save);
      expect(image.dict.has('SMask')).toBe(false);
      expect(image.dict.getNumber('Width')).toBe(2);
      expect(image.dict.getNumber('Height')).toBe(1);
      expect(Array.from(await applyFilters(image.rawBytes, image.getFilters(), image.getDecodeParams()))).toEqual([201, 102, 53, 17, 99, 231]);
    });

    it('keeps JPEG bytes under DCTDecode without a soft mask', async () => {
      const bytes = tinyJPEG();
      const { image } = await applyAndReopen(bytes, 'image/jpeg', save);
      expect(image.dict.has('SMask')).toBe(false);
      expect(image.dict.getName('Filter')).toBe('DCTDecode');
      expect(Array.from(image.rawBytes)).toEqual(Array.from(bytes));
    });
  });
}

describe('in-session image watermarks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(transparentPNGs)('decodes $name pixel alpha before saving or reopening', async fixture => {
    const doc = await applyInSession(fixture.bytes(), 'image/png', 0.5);
    const image = getResource(doc.pages[0].resources, 'XObject', 'ImWM_alpha001', doc.objects) as PDFStream;
    // Use the live object map as-is: no parser/filter pass to repair the new streams.
    const decoded = await decodeImage(image, doc.objects);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.data)).toEqual(fixture.alpha.flatMap((alpha, i) => [
      ...fixture.rgb.slice(i * 3, i * 3 + 3), alpha,
    ]));
  });

  it.each([0, 0.5, 1])('draws with fill alpha %s without leaking it to the next image', async opacity => {
    const doc = await applyInSession(transparentPNGs[0].bytes(), 'image/png', opacity);
    const page = doc.pages[0];
    const state = getResource(page.resources, 'ExtGState', 'GS_wm_alpha001', doc.objects);
    // Image painting uses non-stroking /ca, not /CA.
    if (state instanceof PDFDict) state.set('CA', new PDFNumber(0.9));
    const content = getPageContentBytes(page, doc.objects);
    const nextImage = new TextEncoder().encode('\nq 2 0 0 2 0 0 cm /ImWM_alpha001 Do Q\n');
    const combined = new Uint8Array(content.length + nextImage.length);
    combined.set(content);
    combined.set(nextImage, content.length);
    await updatePageContent(page.contentRefs, combined, doc.objects);

    const drawnAlphas: number[] = [];
    const stack: number[] = [];
    const ctx = {
      globalAlpha: 1,
      save() { stack.push(this.globalAlpha); },
      restore() { this.globalAlpha = stack.pop()!; },
      fillRect() {},
      scale() {},
      transform() {},
      translate() {},
      drawImage() { drawnAlphas.push(this.globalAlpha); },
    };
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx }),
    });
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { putImageData() {} }; }
    });

    await renderPage(doc, 0, { scale: 1, renderText: false, renderPaths: false });
    expect(drawnAlphas).toEqual([opacity, 1]);
  });
});
