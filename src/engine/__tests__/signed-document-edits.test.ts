import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFNumber, PDFStream, PDFString } from '../types';
import { SignedDocumentEditError, saveQuick, saveOptimized } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';
import { saveQuick as saveQuickWorker, saveOptimized as saveOptimizedWorker } from '../worker/client';

async function signedFixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]).drawText('Original signed content');
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  // Synthetic finalized signature markers; no certificate or private file needed.
  doc.catalog.set('TestSignature', new PDFDict([
    ['ByteRange', new PDFArray([0, 10, 20, 10].map((n) => new PDFNumber(n)))],
    ['Contents', new PDFHexString('01020304')],
  ]));
  return parsePDF(await serializeDocument(doc));
}

describe('finalized signed document saves', () => {
  it('preserves every original byte when there are no edits', async () => {
    const doc = await signedFixture();
    const original = doc.rawBytes.slice();
    expect(await saveQuick(doc, new Set(), new Map())).toEqual(original);
    expect(await saveOptimized(doc)).toEqual(original);
    for (const object of doc.objects.values()) {
      if (object instanceof PDFStream) object.decodedBytes = null;
    }
    expect(await saveQuick(doc)).toEqual(original);
  });

  it.each(['modified keys', 'new objects'] as const)('rejects explicit %s instead of dropping edits', async (kind) => {
    const doc = await signedFixture();
    const result = kind === 'modified keys'
      ? saveQuick(doc, new Set(['1_0']))
      : saveQuick(doc, undefined, new Map([['99_0', new PDFString('new object')]]));
    await expect(result).rejects.toMatchObject({
      name: 'SignedDocumentEditError',
      message: expect.stringMatching(/digitally signed.*edits would invalidate the signature/i),
    });
    await expect(result).rejects.toBeInstanceOf(SignedDocumentEditError);
  });

  it.each([
    ['quick', saveQuick],
    ['optimized', saveOptimized],
    ['worker quick', saveQuickWorker],
    ['worker optimized', saveOptimizedWorker],
  ] as const)('rejects untracked in-memory edits in %s saves', async (_mode, save) => {
    const doc = await signedFixture();
    doc.pages[0].dict.set('Rotate', new PDFNumber(90));
    await expect(save(doc)).rejects.toMatchObject({ name: 'SignedDocumentEditError' });
    expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
  });

  it('rejects stream-byte edits even when its dictionary is unchanged', async () => {
    const doc = await signedFixture();
    const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    stream.rawBytes = stream.rawBytes.slice();
    stream.rawBytes[0] ^= 1;
    await expect(saveQuick(doc)).rejects.toBeInstanceOf(SignedDocumentEditError);
    await expect(saveOptimized(doc)).rejects.toBeInstanceOf(SignedDocumentEditError);
  });
});
