/**
 * Prepare a plaintext object graph for a re-encrypted PDF save.
 *
 * The editor keeps authenticated documents decrypted. This helper clones the
 * graph first, so saving never mutates the editor state or consumes an object
 * twice on a subsequent save.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
} from '../../types';
import type { EncryptionAlgorithm, EncryptDictionary } from '../types';
import {
  algorithmForFilter,
  computeObjectKey,
  encryptBytes,
  shouldEncryptStream,
  shouldEncryptString,
} from './object-cipher';
import { bytesToPdfHex, getEncryptDictFromTrailer } from './encrypt-dict';
import { detectAlgorithm } from './standard-handler';

export interface ReencryptSaveContext {
  fileKey: Uint8Array;
  algorithm: EncryptionAlgorithm;
  encrypt: EncryptDictionary;
}

export function getReencryptSaveContext(doc: PDFDocumentData): ReencryptSaveContext | null {
  if (!doc.decryptedFromEncrypted || !doc.encryptionFileKey) return null;
  const encrypt = getEncryptDictFromTrailer(doc.xref.trailerDict, doc.objects);
  if (!encrypt) return null;
  return {
    fileKey: doc.encryptionFileKey,
    algorithm: doc.encryptionAlgorithm ?? detectAlgorithm(encrypt),
    encrypt,
  };
}

/** Clone and encrypt every indirect object, leaving /Encrypt untouched. */
export async function prepareEncryptedObjects(
  objects: Map<string, PDFObject>,
  encryptRefKey: string | undefined,
  context: ReencryptSaveContext,
): Promise<Map<string, PDFObject>> {
  const result = new Map<string, PDFObject>();
  for (const [key, value] of objects) {
    const [objNumText, genNumText] = key.split('_');
    const objNum = Number(objNumText);
    const genNum = Number(genNumText);
    const clone = clonePdfObject(value);
    if (key !== encryptRefKey) {
      result.set(key, await encryptIndirectObject(clone, objNum, genNum, context));
    } else {
      result.set(key, clone);
    }
  }
  return result;
}

function clonePdfObject(value: PDFObject, seen = new Map<PDFObject, PDFObject>()): PDFObject {
  const existing = seen.get(value);
  if (existing) return existing;
  let clone: PDFObject;
  if (value instanceof PDFNull) clone = PDFNull.instance;
  else if (value instanceof PDFBoolean) clone = new PDFBoolean(value.value);
  else if (value instanceof PDFNumber) clone = new PDFNumber(value.value);
  else if (value instanceof PDFString) clone = new PDFString(value.value);
  else if (value instanceof PDFHexString) clone = new PDFHexString(value.hex);
  else if (value instanceof PDFName) clone = new PDFName(value.name);
  else if (value instanceof PDFRef) clone = new PDFRef(value.objNum, value.genNum);
  else if (value instanceof PDFArray) clone = new PDFArray();
  else if (value instanceof PDFDict) clone = new PDFDict();
  else if (value instanceof PDFStream) clone = new PDFStream(new PDFDict(), value.rawBytes.slice(), value.decodedBytes?.slice() ?? null);
  else throw new Error('Unsupported PDF object while preparing encrypted output');
  seen.set(value, clone);

  if (value instanceof PDFArray) {
    (clone as PDFArray).items.push(...value.items.map((item) => clonePdfObject(item, seen)));
  } else if (value instanceof PDFDict) {
    for (const [key, item] of value.entries()) (clone as PDFDict).set(key, clonePdfObject(item, seen));
  } else if (value instanceof PDFStream) {
    const streamClone = clone as PDFStream;
    for (const [key, item] of value.dict.entries()) streamClone.dict.set(key, clonePdfObject(item, seen));
  }
  return clone;
}

async function encryptIndirectObject(
  object: PDFObject,
  objNum: number,
  genNum: number,
  context: ReencryptSaveContext,
): Promise<PDFObject> {
  if (object instanceof PDFStream) {
    await encryptValue(object.dict, objNum, genNum, context);
    const type = object.dict.getName('Type');
    const subtype = object.dict.getName('Subtype');
    if (type !== 'XRef' && shouldEncryptStream(context.encrypt, { type, subtype })) {
      const algorithm = algorithmForFilter(context.encrypt, context.encrypt.stmF);
      if (algorithm) {
        const key = computeObjectKey(context.fileKey, objNum, genNum, algorithm);
        const encrypted = await encryptBytes(object.rawBytes, key, algorithm);
        object.rawBytes = encrypted;
        object.decodedBytes = null;
        object.dict.set('Length', new PDFNumber(encrypted.length));
      }
    }
    return object;
  }
    return encryptValue(object, objNum, genNum, context);
}

async function encryptValue(
  object: PDFObject,
  objNum: number,
  genNum: number,
  context: ReencryptSaveContext,
): Promise<PDFObject> {
  if (object instanceof PDFString || object instanceof PDFHexString) {
    if (!shouldEncryptString(context.encrypt)) return object;
    const algorithm = algorithmForFilter(context.encrypt, context.encrypt.strF);
    if (!algorithm) return object;
    const key = computeObjectKey(context.fileKey, objNum, genNum, algorithm);
    return bytesToPdfHex(await encryptBytes(object.toBytes(), key, algorithm));
  }
  if (object instanceof PDFArray) {
    for (let i = 0; i < object.items.length; i++) object.items[i] = await encryptValue(object.items[i], objNum, genNum, context);
  } else if (object instanceof PDFDict) {
    for (const [key, value] of [...object.entries()]) object.set(key, await encryptValue(value, objNum, genNum, context));
  }
  return object;
}
