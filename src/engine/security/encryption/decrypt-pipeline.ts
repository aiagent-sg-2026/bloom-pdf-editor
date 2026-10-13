/**
 * Decrypt all encrypted strings and streams in a PDF document.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFNumber,
  PDFObject,
  PDFStream,
  PDFString,
  type PDFDocumentData,
} from '../../types';
import { applyFilters } from '../../parser/filters';
import type { EncryptionContext } from '../types';
import {
  algorithmForEncrypt,
  algorithmForFilter,
  computeObjectKey,
  decryptBytes,
  shouldEncryptStream,
  shouldEncryptString,
} from './object-cipher';
import { pdfBytesToString, bytesToHex } from '../crypto/bytes';

/**
 * Walk the object graph and decrypt strings/streams in place.
 * Then apply compression filters to streams.
 */
export async function decryptDocumentObjects(
  doc: PDFDocumentData,
  ctx: EncryptionContext,
): Promise<void> {
  if (!ctx.fileKey) throw new Error('No file encryption key — authenticate first');

  const algorithm = ctx.algorithm;
  const enc = ctx.encrypt;
  const encryptRefKey = enc.ref?.toKey();

  for (const [key, obj] of doc.objects.entries()) {
    // Never decrypt the Encrypt dictionary itself
    if (encryptRefKey && key === encryptRefKey) continue;

    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);

    if (obj instanceof PDFStream) {
      await decryptStream(obj, objNum, genNum, ctx);
      continue;
    }

    if (shouldEncryptString(enc)) {
      const decrypted = await decryptObjectValue(obj, objNum, genNum, ctx, new Set());
      if (decrypted !== obj) {
        doc.objects.set(key, decrypted);
      }
    }
  }

  // Trailer strings (rarely encrypted for ID)
  // Re-decode page content is handled by stream decrypt + filters
}

async function decryptStream(
  stream: PDFStream,
  objNum: number,
  genNum: number,
  ctx: EncryptionContext,
): Promise<void> {
  const type = stream.dict.getName('Type');
  const subtype = stream.dict.getName('Subtype');

  if (type === 'XRef') return;

  if (!shouldEncryptStream(ctx.encrypt, { type, subtype })) {
    // Still apply filters
    await decodeFilters(stream);
    return;
  }

  const algorithm = algorithmForFilter(ctx.encrypt, ctx.encrypt.stmF);
  if (!algorithm) return;
  const key = computeObjectKey(ctx.fileKey!, objNum, genNum, algorithm);
  const plain = await decryptBytes(stream.rawBytes, key, algorithm);
  stream.rawBytes = plain;
  stream.dict.set('Length', new PDFNumber(plain.length));
  await decodeFilters(stream);
}

async function decodeFilters(stream: PDFStream): Promise<void> {
  const filters = stream.getFilters();
  if (filters.length === 0) {
    stream.decodedBytes = stream.rawBytes;
    return;
  }
  // Skip Crypt filter — already handled at document level
  const filtered = filters.filter((f) => f !== 'Crypt');
  if (filtered.length === 0) {
    stream.decodedBytes = stream.rawBytes;
    return;
  }
  try {
    stream.decodedBytes = await applyFilters(stream.rawBytes, filtered, stream.getDecodeParams());
  } catch (e) {
    console.warn('[Security] Filter decode failed after decrypt:', e);
    stream.decodedBytes = stream.rawBytes;
  }
}

async function decryptObjectValue(
  obj: PDFObject,
  objNum: number,
  genNum: number,
  ctx: EncryptionContext,
  seen: Set<PDFObject>,
): Promise<PDFObject> {
  if (seen.has(obj)) return obj;
  seen.add(obj);

  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const algorithm = algorithmForFilter(ctx.encrypt, ctx.encrypt.strF);
    if (!algorithm) return obj;
    const key = computeObjectKey(ctx.fileKey!, objNum, genNum, algorithm);
    const plain = await decryptBytes(obj.toBytes(), key, algorithm);
    return new PDFString(pdfBytesToString(plain));
  }

  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      // Encrypt dict entries O/U/OE/UE/Perms must stay encrypted
      if (k === 'O' || k === 'U' || k === 'OE' || k === 'UE' || k === 'Perms') continue;
      obj.set(k, await decryptObjectValue(v, objNum, genNum, ctx, seen));
    }
    return obj;
  }

  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.items.length; i++) {
      obj.items[i] = await decryptObjectValue(obj.items[i], objNum, genNum, ctx, seen);
    }
    return obj;
  }

  return obj;
}

/**
 * Decrypt a single string given object numbers (for incremental use).
 */
export async function decryptStringBytes(
  data: Uint8Array,
  fileKey: Uint8Array,
  objNum: number,
  genNum: number,
  algorithm: EncryptionContext['algorithm'],
): Promise<Uint8Array> {
  const key = computeObjectKey(fileKey, objNum, genNum, algorithm);
  return decryptBytes(data, key, algorithm);
}

export { algorithmForEncrypt, bytesToHex };
