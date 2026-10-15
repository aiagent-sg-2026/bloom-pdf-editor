import { deflateSync, inflateSync } from 'node:zlib';
import { vi } from 'vitest';

/** Generate a small, offset-correct PDF without external fixture files. */
export function rawPDF(objects: string[]): Uint8Array {
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, char => char.charCodeAt(0));
}

export function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** One-row RGBA PNG; the pixel bytes travel through PNG compression/decompression. */
export function tinyPNG(pixels: number[]): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels.length / 4, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, ...pixels]))),
    pngChunk('IEND', new Uint8Array()),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/** Baseline 1x1 gray JPEG: zero DCT coefficients in each Y/Cb/Cr block. */
export function tinyJPEG(): Uint8Array {
  const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const counts = [1, ...new Array<number>(15).fill(0)];
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...segment(0xc0, [8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...segment(0xc4, [0, ...counts, 0, 0x10, ...counts, 0]),
    ...segment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]),
    0x03, 0xff, 0xd9,
  ]);
}

/** Supply only the browser PNG/canvas boundary; PDF encoding/decoding remains real. */
export function installPNGEnvironment(): void {
  class PNGImage {
    naturalWidth = 0;
    naturalHeight = 0;
    pixels = new Uint8ClampedArray();
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(url: string) {
      try {
        const bytes = Buffer.from(url.split(',')[1], 'base64');
        this.naturalWidth = bytes.readUInt32BE(16);
        this.naturalHeight = bytes.readUInt32BE(20);
        const data: Buffer[] = [];
        for (let offset = 8; offset < bytes.length;) {
          const length = bytes.readUInt32BE(offset);
          if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
          offset += length + 12;
        }
        const row = inflateSync(Buffer.concat(data));
        if (row[0] !== 0 || this.naturalHeight !== 1) throw new Error('Unsupported synthetic PNG');
        this.pixels = new Uint8ClampedArray(row.subarray(1));
        this.onload?.();
      } catch {
        this.onerror?.();
      }
    }
  }
  vi.stubGlobal('Image', PNGImage);
  vi.stubGlobal('document', {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`Unexpected element ${tag}`);
      let image: PNGImage;
      return {
        width: 0, height: 0,
        getContext() {
          return {
            drawImage(value: PNGImage) { image = value; },
            getImageData() { return { data: image.pixels }; },
          };
        },
      };
    },
  });
}
