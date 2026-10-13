/**
 * Save pipeline — quick (incremental) vs optimized (GC + dedup + full serialize).
 */

import type { PDFDocumentData, PDFObject } from '../types';
import { serializeDocument } from './serializer';
import { saveIncremental } from './incremental-writer';
import { garbageCollect, rootsFromTrailer, deduplicateStreams, applyRefMap } from '../optimize';
import { getReencryptSaveContext } from '../security/encryption/encrypt-objects';

/** A signed PDF must be exported byte-for-byte from the finalized buffer. */
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
 */
export async function saveQuick(
  doc: PDFDocumentData,
  modifiedKeys?: Set<string>,
  newObjects?: Map<string, PDFObject>,
): Promise<Uint8Array> {
  if (doc.rawBytes.length > 0 && hasFinalizedSignature(doc.rawBytes)) {
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

  const mods = modifiedKeys ?? new Set<string>();
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
 */
export async function saveOptimized(doc: PDFDocumentData): Promise<Uint8Array> {
  if (doc.rawBytes.length > 0 && hasFinalizedSignature(doc.rawBytes)) {
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
