/**
 * PDF Image Decoder
 *
 * Decodes PDF image XObjects into ImageData for canvas rendering.
 * Handles:
 *   - DeviceRGB, DeviceGray, DeviceCMYK color spaces
 *   - Indexed (palette) images
 *   - Image masks and stencil masks
 *   - Soft masks (SMask)
 *   - DCTDecode (JPEG) — delegates to browser
 *   - Various bits-per-component (1, 2, 4, 8, 16)
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFStream,
} from '../types';
import { resolveRef } from '../parser/parser';
import { parseColorSpace, type ColorSpace, type RGBColor } from './color-space';

// ─── Image decoding ─────────────────────────────────────────────────────────

export interface DecodedImage {
  /** RGBA pixel data */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Decode a PDF Image XObject into RGBA pixel data.
 */
export async function decodeImage(
  imageStream: PDFStream,
  objects: Map<string, PDFObject>,
): Promise<DecodedImage | null> {
  const dict = imageStream.dict;
  const width = dict.getNumber('Width') ?? dict.getNumber('W') ?? 0;
  const height = dict.getNumber('Height') ?? dict.getNumber('H') ?? 0;

  if (width <= 0 || height <= 0) return null;

  const bpc = dict.getNumber('BitsPerComponent') ?? dict.getNumber('BPC') ?? 8;
  const isImageMask = dict.getBool('ImageMask') ?? dict.getBool('IM') ?? false;

  // Check if it's a JPEG (DCTDecode) — let the browser decode it
  const filters = imageStream.getFilters();
  if (filters.includes('DCTDecode') || filters.includes('DCT')) {
    // Use getBytes() because if there was FlateDecode+DCTDecode,
    // our parser already applied Flate — getBytes() gives us the JPEG data
    const image = await decodeJPEG(imageStream.getBytes(), width, height);
    return applySoftMask(image, dict, objects);
  }

  // Get decoded stream bytes
  const imageBytes = imageStream.getBytes();

  if (isImageMask) {
    return applySoftMask(decodeImageMask(imageBytes, width, height, bpc), dict, objects);
  }

  // Parse color space
  const csObj = dict.get('ColorSpace') ?? dict.get('CS');
  let colorSpace: ColorSpace;
  if (csObj) {
    colorSpace = parseColorSpace(csObj, objects);
  } else {
    colorSpace = { name: 'DeviceRGB', numComponents: 3, toRGB: (c) => [c[0], c[1], c[2]] };
  }

  // Parse Decode array (maps raw values to color component range)
  const decodeArr = dict.getArray('Decode') ?? dict.getArray('D');
  const decode = decodeArr ? decodeArr.asNumbers() : getDefaultDecode(colorSpace.numComponents, bpc);

  // Decode pixels
  const rgba = new Uint8ClampedArray(width * height * 4);
  const numComponents = colorSpace.numComponents;

  if (bpc === 8 && numComponents === 3 && colorSpace.name === 'DeviceRGB') {
    // Fast path: 8-bit RGB
    decodeRGB8(imageBytes, rgba, width, height, decode);
  } else if (bpc === 8 && numComponents === 1 && colorSpace.name === 'DeviceGray') {
    // Fast path: 8-bit Grayscale
    decodeGray8(imageBytes, rgba, width, height, decode);
  } else if (bpc === 8 && numComponents === 4 && colorSpace.name === 'DeviceCMYK') {
    // Fast path: 8-bit CMYK
    decodeCMYK8(imageBytes, rgba, width, height, decode);
  } else {
    // Generic path: handles all BPC/color space combinations
    decodeGeneric(imageBytes, rgba, width, height, bpc, numComponents, colorSpace, decode);
  }

  return applySoftMask({ data: rgba, width, height }, dict, objects);
}

// ─── Soft masks ─────────────────────────────────────────────────────────────

/** Matte components are in the base colour space, not the mask's DeviceGray. */
function getRGBMatte(dict: PDFDict, mask: PDFDict, objects: Map<string, PDFObject>): number[] | null {
  const entry = mask.get('Matte');
  if (!entry || (dict.getBool('ImageMask') ?? dict.getBool('IM') ?? false)) return null;
  const csEntry = dict.get('ColorSpace') ?? dict.get('CS');
  const cs = csEntry ? resolveRef(csEntry, objects) : undefined;
  // Unblending converted RGB is unsafe for Indexed, ICC, and other colour spaces.
  if (!(cs instanceof PDFName) || (cs.name !== 'DeviceRGB' && cs.name !== 'RGB')) return null;
  const array = resolveRef(entry, objects);
  if (!(array instanceof PDFArray) || array.length !== 3) return null;
  const matte = array.asNumbers();
  if (matte.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return null;
  for (let c = 0; c < 3; c++) matte[c] *= 255;
  return matte;
}

function applySoftMask(
  image: DecodedImage | null,
  dict: PDFDict,
  objects: Map<string, PDFObject>,
): DecodedImage | null {
  if (!image) return null;
  const smaskRef = dict.get('SMask');
  if (!smaskRef) return image;
  const smask = resolveRef(smaskRef, objects);
  if (!(smask instanceof PDFStream)) return image;

  const maskWidth = smask.dict.getNumber('Width') ?? smask.dict.getNumber('W') ?? 0;
  const maskHeight = smask.dict.getNumber('Height') ?? smask.dict.getNumber('H') ?? 0;
  const bpc = smask.dict.getNumber('BitsPerComponent') ?? smask.dict.getNumber('BPC') ?? 8;
  if (maskWidth <= 0 || maskHeight <= 0) return image;
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8 && bpc !== 16) return image;

  const decode = smask.dict.getArray('Decode') ?? smask.dict.getArray('D');
  const decodeMin = decode?.get(0);
  const decodeMax = decode?.get(1);
  const dMin = decodeMin instanceof PDFNumber ? decodeMin.value : 0;
  const dMax = decodeMax instanceof PDFNumber ? decodeMax.value : 1;
  const maxSample = (1 << bpc) - 1;
  const alphaScale = (dMax - dMin) * 255 / maxSample;
  const alphaOffset = dMin * 255;
  const rowBytes = Math.ceil(maskWidth * bpc / 8);
  const src = smask.getBytes();
  const scaleX = maskWidth / image.width;
  const scaleY = maskHeight / image.height;
  const matte = getRGBMatte(dict, smask.dict, objects);

  // Sample directly into RGBA: no intermediate unpacked or resized mask buffer.
  for (let y = 0, k = 3; y < image.height; y++) {
    const rowOffset = Math.floor(y * scaleY) * rowBytes;
    for (let x = 0; x < image.width; x++, k += 4) {
      const bitOffset = Math.floor(x * scaleX) * bpc;
      const byteOffset = rowOffset + (bitOffset >> 3);
      // Preserve the existing opaque fallback for truncated mask streams.
      if (byteOffset + (bpc === 16 ? 1 : 0) >= src.length) {
        image.data[k] = 255;
        continue;
      }
      const sample = bpc === 16
        ? src[byteOffset] * 256 + src[byteOffset + 1]
        : (src[byteOffset] >> (8 - bpc - (bitOffset & 7))) & maxSample;
      const alphaByte = alphaOffset + sample * alphaScale;
      image.data[k] = Math.round(alphaByte);
      if (matte && alphaByte > 0 && alphaByte < 255) {
        // ISO 32000-1 §11.6.5.3: c = m + (c' - m) / alpha.
        // Use unrounded mask alpha; Uint8ClampedArray clamps recovered RGB.
        const inverseAlpha = 255 / alphaByte;
        for (let c = 0; c < 3; c++) {
          const index = k - 3 + c;
          image.data[index] = Math.round(matte[c] + (image.data[index] - matte[c]) * inverseAlpha);
        }
      }
    }
  }

  return image;
}

// ─── Fast path decoders ─────────────────────────────────────────────────────

function decodeRGB8(
  src: Uint8Array, dst: Uint8ClampedArray,
  w: number, h: number, decode: number[],
): void {
  const [dMin0, dMax0, dMin1, dMax1, dMin2, dMax2] = decode;
  const needsDecode = dMin0 !== 0 || dMax0 !== 1 || dMin1 !== 0 || dMax1 !== 1 || dMin2 !== 0 || dMax2 !== 1;

  for (let i = 0, j = 0, k = 0; i < w * h; i++, j += 3, k += 4) {
    let r = src[j] ?? 0;
    let g = src[j + 1] ?? 0;
    let b = src[j + 2] ?? 0;

    if (needsDecode) {
      r = Math.round((dMin0 + (r / 255) * (dMax0 - dMin0)) * 255);
      g = Math.round((dMin1 + (g / 255) * (dMax1 - dMin1)) * 255);
      b = Math.round((dMin2 + (b / 255) * (dMax2 - dMin2)) * 255);
    }

    dst[k] = r;
    dst[k + 1] = g;
    dst[k + 2] = b;
    dst[k + 3] = 255;
  }
}

function decodeGray8(
  src: Uint8Array, dst: Uint8ClampedArray,
  w: number, h: number, decode: number[],
): void {
  const [dMin, dMax] = decode;

  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    let gray = src[i] ?? 0;
    if (dMin !== 0 || dMax !== 1) {
      gray = Math.round((dMin + (gray / 255) * (dMax - dMin)) * 255);
    }
    dst[k] = gray;
    dst[k + 1] = gray;
    dst[k + 2] = gray;
    dst[k + 3] = 255;
  }
}

function decodeCMYK8(
  src: Uint8Array, dst: Uint8ClampedArray,
  w: number, h: number, decode: number[],
): void {
  for (let i = 0, j = 0, k = 0; i < w * h; i++, j += 4, k += 4) {
    let c = (src[j] ?? 0) / 255;
    let m = (src[j + 1] ?? 0) / 255;
    let y = (src[j + 2] ?? 0) / 255;
    let kk = (src[j + 3] ?? 0) / 255;

    // Apply decode array
    c = decode[0] + c * (decode[1] - decode[0]);
    m = decode[2] + m * (decode[3] - decode[2]);
    y = decode[4] + y * (decode[5] - decode[4]);
    kk = decode[6] + kk * (decode[7] - decode[6]);

    // CMYK → RGB
    const r = (1 - c) * (1 - kk);
    const g = (1 - m) * (1 - kk);
    const b = (1 - y) * (1 - kk);

    dst[k] = Math.round(r * 255);
    dst[k + 1] = Math.round(g * 255);
    dst[k + 2] = Math.round(b * 255);
    dst[k + 3] = 255;
  }
}

// ─── Generic decoder ────────────────────────────────────────────────────────

function decodeGeneric(
  src: Uint8Array, dst: Uint8ClampedArray,
  w: number, h: number, bpc: number,
  numComponents: number, colorSpace: ColorSpace,
  decode: number[],
): void {
  const maxVal = (1 << bpc) - 1;
  const reader = new BitReader(src);

  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    const components: number[] = [];

    for (let c = 0; c < numComponents; c++) {
      const raw = reader.readBits(bpc);
      // Apply decode: interpolate raw value to [decode[2c], decode[2c+1]]
      const dMin = decode[c * 2] ?? 0;
      const dMax = decode[c * 2 + 1] ?? 1;
      const normalized = dMin + (raw / maxVal) * (dMax - dMin);
      components.push(normalized);
    }

    const rgb = colorSpace.toRGB(components);
    dst[k] = Math.round(rgb[0] * 255);
    dst[k + 1] = Math.round(rgb[1] * 255);
    dst[k + 2] = Math.round(rgb[2] * 255);
    dst[k + 3] = 255;
  }
}

// ─── Image mask ─────────────────────────────────────────────────────────────

function decodeImageMask(
  src: Uint8Array, w: number, h: number, bpc: number,
): DecodedImage {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const reader = new BitReader(src);

  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    const bit = reader.readBits(bpc);
    // In an image mask: 1 = transparent (unmasked), 0 = opaque (masked/painted)
    const alpha = bit === 0 ? 255 : 0;
    dst_setPixel(rgba, k, 0, 0, 0, alpha);
  }

  return { data: rgba, width: w, height: h };
}

function dst_setPixel(dst: Uint8ClampedArray, k: number, r: number, g: number, b: number, a: number) {
  dst[k] = r;
  dst[k + 1] = g;
  dst[k + 2] = b;
  dst[k + 3] = a;
}

// ─── JPEG decoder (delegates to browser) ────────────────────────────────────

async function decodeJPEG(
  rawBytes: Uint8Array,
  width: number,
  height: number,
): Promise<DecodedImage | null> {
  // In a browser environment, use createImageBitmap
  if (typeof createImageBitmap !== 'undefined') {
    try {
      const blob = new Blob([rawBytes as unknown as BlobPart], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);

      // Save dimensions BEFORE closing the bitmap
      const bw = bitmap.width;
      const bh = bitmap.height;

      if (bw <= 0 || bh <= 0) {
        bitmap.close();
        return null;
      }

      // Draw to an offscreen canvas to get pixel data
      const canvas = new OffscreenCanvas(bw, bh);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close();
        return null;
      }

      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bw, bh);
      bitmap.close();

      return {
        data: imageData.data,
        width: bw,
        height: bh,
      };
    } catch {
      return null;
    }
  }

  // In Node.js / SSR environments, return null (not renderable)
  return null;
}

// ─── Bit reader utility ─────────────────────────────────────────────────────

class BitReader {
  private data: Uint8Array;
  private bytePos: number;
  private bitPos: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.bytePos = 0;
    this.bitPos = 0;
  }

  readBits(count: number): number {
    let value = 0;

    for (let i = 0; i < count; i++) {
      if (this.bytePos >= this.data.length) return value;

      // Read MSB first
      const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1;
      value = (value << 1) | bit;

      this.bitPos++;
      if (this.bitPos >= 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }

    return value;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDefaultDecode(numComponents: number, bpc: number): number[] {
  const decode: number[] = [];
  for (let i = 0; i < numComponents; i++) {
    decode.push(0, 1); // Default: [0 1] per component
  }
  return decode;
}
