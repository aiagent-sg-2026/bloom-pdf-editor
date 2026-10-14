import { describe, expect, it } from 'vitest';
import { decodeImage, type DecodedImage } from '../render/image-decoder';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject } from '../types';

function image(width: number, height: number, bpc: number, bytes: number[], colorSpace = 'DeviceGray'): PDFStream {
  return new PDFStream(new PDFDict([
    ['Width', new PDFNumber(width)],
    ['Height', new PDFNumber(height)],
    ['BitsPerComponent', new PDFNumber(bpc)],
    ['ColorSpace', new PDFName(colorSpace)],
  ]), new Uint8Array(bytes));
}

async function decoded(base: PDFStream, mask?: PDFStream): Promise<DecodedImage> {
  const objects = new Map<string, PDFObject>();
  if (mask) {
    const ref = new PDFRef(2, 0);
    base.dict.set('SMask', ref);
    objects.set(ref.toKey(), mask);
  }
  const result = await decodeImage(base, objects);
  expect(result).not.toBeNull();
  return result!;
}

function alpha(result: DecodedImage): number[] {
  return Array.from(result.data.filter((_, i) => i % 4 === 3));
}

const basePaths = [
  { name: 'gray', colorSpace: 'DeviceGray', bpc: 8, bytes: [123, 123, 123, 123] },
  { name: 'RGB', colorSpace: 'DeviceRGB', bpc: 8, bytes: [123, 45, 67, 123, 45, 67, 123, 45, 67, 123, 45, 67] },
  { name: 'CMYK', colorSpace: 'DeviceCMYK', bpc: 8, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'generic', colorSpace: 'DeviceGray', bpc: 4, bytes: [0x77, 0x77] },
];

describe('image soft masks', () => {
  it('unpacks a 10x3 one-bit mask with byte-padded rows into exact RGBA', async () => {
    // Padding bits are deliberately set; they must not become the next row's samples.
    const mask = image(10, 3, 1, [0xaa, 0xbf, 0x55, 0x7f, 0xff, 0xff]);
    const result = await decoded(image(10, 3, 8, new Array(30).fill(123)), mask);
    const expectedAlpha = [
      255, 0, 255, 0, 255, 0, 255, 0, 255, 0,
      0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ];
    expect(result.width).toBe(10);
    expect(result.height).toBe(3);
    expect(Array.from(result.data)).toEqual(expectedAlpha.flatMap(a => [123, 123, 123, a]));
  });

  it.each(basePaths)('applies packed masks on the $name base decode path', async ({ colorSpace, bpc, bytes }) => {
    const result = await decoded(image(4, 1, bpc, bytes, colorSpace), image(4, 1, 1, [0xa0]));
    expect(alpha(result)).toEqual([255, 0, 255, 0]);
  });

  it('preserves eight-bit mask alpha values', async () => {
    const result = await decoded(image(4, 1, 8, [123, 123, 123, 123]), image(4, 1, 8, [0, 64, 128, 255]));
    expect(alpha(result)).toEqual([0, 64, 128, 255]);
  });

  it('inverts alpha with the mask Decode array', async () => {
    const mask = image(3, 1, 8, [0, 64, 255]);
    mask.dict.set('Decode', new PDFArray([new PDFNumber(1), new PDFNumber(0)]));
    expect(alpha(await decoded(image(3, 1, 8, [123, 123, 123]), mask))).toEqual([255, 191, 0]);
  });

  it('maps Decode endpoints and clamps alpha to the byte range', async () => {
    const mask = image(3, 1, 8, [0, 128, 255]);
    mask.dict.set('Decode', new PDFArray([new PDFNumber(-1), new PDFNumber(2)]));
    expect(alpha(await decoded(image(3, 1, 8, [123, 123, 123]), mask))).toEqual([0, 129, 255]);
  });

  it('aligns a 2x2 mask over a 4x4 base using nearest neighbours', async () => {
    const result = await decoded(image(4, 4, 8, new Array(16).fill(123)), image(2, 2, 8, [0, 85, 170, 255]));
    expect(alpha(result)).toEqual([
      0, 0, 85, 85,
      0, 0, 85, 85,
      170, 170, 255, 255,
      170, 170, 255, 255,
    ]);
  });

  it('scales four-bit mask samples and skips row padding', async () => {
    const result = await decoded(image(3, 2, 8, new Array(6).fill(123)), image(3, 2, 4, [0x08, 0xff, 0xf4, 0x0f]));
    expect(alpha(result)).toEqual([0, 136, 255, 255, 68, 0]);
  });

  it('scales two-bit mask samples and skips row padding', async () => {
    const result = await decoded(image(3, 2, 8, new Array(6).fill(123)), image(3, 2, 2, [0x1b, 0xe7]));
    expect(alpha(result)).toEqual([0, 85, 170, 255, 170, 85]);
  });

  it('reads sixteen-bit mask samples most-significant byte first', async () => {
    const result = await decoded(image(3, 1, 8, [123, 123, 123]), image(3, 1, 16, [0, 0, 0x80, 0, 0xff, 0xff]));
    expect(alpha(result)).toEqual([0, 128, 255]);
  });

  it.each(basePaths)('leaves a $name base without a mask fully opaque', async ({ colorSpace, bpc, bytes }) => {
    expect(alpha(await decoded(image(4, 1, bpc, bytes, colorSpace)))).toEqual([255, 255, 255, 255]);
  });
});
