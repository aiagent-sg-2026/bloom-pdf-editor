/**
 * Save pipeline — quick (incremental) vs optimized (GC + dedup + full serialize).
 */

import { PDFArray, PDFDict, PDFHexString, PDFStream, type PDFDocumentData, type PDFObject } from '../types';
import { serializeDocument } from './serializer';
import { saveIncremental } from './incremental-writer';
import { garbageCollect, rootsFromTrailer, deduplicateStreams, applyRefMap } from '../optimize';
import { getReencryptSaveContext } from '../security/encryption/encrypt-objects';
import { parsePDF } from '../parser/parser';
import { pageContentModifiedKeys, serializeToString } from '../editor/stream-compiler';
import { decryptDocumentObjects } from '../security/encryption/decrypt-pipeline';
import { parseFileId } from '../security/encryption/encrypt-dict';
import { unicodeFontModifiedKeys } from '../fonts/unicode-font-embed';
import { registeredFontKeys } from '../fonts/font-augmentation';

export class SignedDocumentEditError extends Error {
  constructor() {
    super('This document is digitally signed; edits would invalidate the signature.');
    this.name = 'SignedDocumentEditError';
  }
}

function equalObjects(a: PDFObject | undefined, b: PDFObject | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a._tag !== b._tag) return false;
  if (a instanceof PDFStream && b instanceof PDFStream) {
    // Decoded bytes are a rendering cache; writers emit the raw stream bytes.
    return equalObjects(a.dict, b.dict) &&
      a.rawBytes.length === b.rawBytes.length &&
      a.rawBytes.every((byte, i) => byte === b.rawBytes[i]);
  }
  if (a instanceof PDFDict && b instanceof PDFDict) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      if (!equalObjects(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof PDFArray && b instanceof PDFArray) {
    return a.length === b.length && a.items.every((value, i) => equalObjects(value, b.get(i)));
  }
  if (a instanceof PDFHexString && b instanceof PDFHexString) {
    return a.hex.replace(/\s/g, '').toLowerCase() === b.hex.replace(/\s/g, '').toLowerCase();
  }
  return serializeToString(a) === serializeToString(b);
}

/** Compare exportable state, not xref offsets, trailer bookkeeping or render caches. */
export async function hasDocumentEdits(doc: PDFDocumentData): Promise<boolean> {
  const original = await parsePDF(doc.rawBytes);
  const encryption = getReencryptSaveContext(doc);
  if (encryption) {
    await decryptDocumentObjects(original, {
      ...encryption,
      fileId: parseFileId(original.xref.trailerDict),
      isOwner: false,
    });
  }
  if (doc.version !== original.version || doc.objects.size !== original.objects.size) return true;
  for (const [key, value] of doc.objects) {
    if (!equalObjects(value, original.objects.get(key))) return true;
  }
  for (const key of ['Root', 'Info', 'Encrypt', 'ID']) {
    if (!equalObjects(doc.xref.trailerDict.get(key), original.xref.trailerDict.get(key))) return true;
  }
  return false;
}

/** Finalized signed bytes may be reused only when the document has no edits. */
function hasFinalizedSignature(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length === 0) return false;
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  if (!/\/ByteRange\s*\[\s*0\s+\d+\s+\d+\s+\d+\s*\]/.test(text)) return false;
  const contents = text.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
  return contents != null && /[1-9a-fA-F]/.test(contents[1]);
}

/**
 * Quick save: append only changed objects when possible.
 * Finalized signed documents preserve their bytes, or throw SignedDocumentEditError for edits.
 */
export async function saveQuick(
  doc: PDFDocumentData,
  modifiedKeys?: Set<string>,
  newObjects?: Map<string, PDFObject>,
): Promise<Uint8Array> {
  if (doc.rawBytes.length > 0 && hasFinalizedSignature(doc.rawBytes)) {
    if (modifiedKeys?.size || newObjects?.size || await hasDocumentEdits(doc)) {
      throw new SignedDocumentEditError();
    }
    return new Uint8Array(doc.rawBytes);
  }
  if (doc.rawBytes.length === 0) {
    return serializeDocument(doc);
  }

  // The original encrypted prefix cannot be combined with plaintext editor
  // objects. Rebuild a complete encrypted revision instead.
  if (getReencryptSaveContext(doc)) {
    return serializeDocument(doc);
  }

  const mods = new Set(modifiedKeys);
  if (modifiedKeys?.size || newObjects?.size) {
    for (const key of unicodeFontModifiedKeys(doc.objects)) mods.add(key);
    for (const key of registeredFontKeys(doc.objects)) mods.add(key);
    for (const key of pageContentModifiedKeys(doc.objects)) mods.add(key);
  }
  if (mods.size === 0 && (!newObjects || newObjects.size === 0)) {
    return serializeDocument(doc);
  }

  try {
    return saveIncremental(doc, mods, newObjects);
  } catch {
    return serializeDocument(doc);
  }
}

/**
 * Optimized save: garbage-collect unreachable objects, dedupe streams, full serialize.
 * Signed-document edit detection compares the object graph with the finalized bytes.
 */
export async function saveOptimized(doc: PDFDocumentData): Promise<Uint8Array> {
  if (doc.rawBytes.length > 0 && hasFinalizedSignature(doc.rawBytes)) {
    if (await hasDocumentEdits(doc)) throw new SignedDocumentEditError();
    return new Uint8Array(doc.rawBytes);
  }
  try {
    const roots = rootsFromTrailer(doc.xref.trailerDict);
    const gc = garbageCollect(doc.objects, roots, { deduplicateStreams: true });
    doc.objects.clear();
    for (const [k, v] of gc.objects) {
      doc.objects.set(k, v);
    }
  } catch {
    try {
      const dedup = deduplicateStreams(doc.objects);
      if (dedup.refMap.size > 0) {
        const remapped = applyRefMap(doc.objects, dedup.refMap);
        doc.objects.clear();
        for (const [k, v] of remapped) doc.objects.set(k, v);
      }
    } catch {
      // continue
    }
  }
  return serializeDocument(doc);
}

export type SaveMode = 'quick' | 'optimized';

export async function saveDocument(
  doc: PDFDocumentData,
  mode: SaveMode = 'optimized',
): Promise<Uint8Array> {
  return mode === 'quick' ? saveQuick(doc) : saveOptimized(doc);
}
