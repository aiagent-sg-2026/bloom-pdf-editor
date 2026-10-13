/**
 * Cryptographic PDF signing pipeline (Phases 7–8).
 *
 * Flow:
 * 1. Attach Sig dictionary with fixed-size /Contents placeholder + padded /ByteRange
 * 2. Append via incremental update (never rewrite original bytes)
 * 3. Finalize via Phase 8 (ByteRange → hash → CMS → inject → validate)
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFDocumentData,
} from '../../types';
import { getNextObjNum } from '../../writer/serializer';
import {
  appendIncrementalUpdate,
  type IncrementalWriteResult,
} from '../../writer/incremental-writer';
import { serializeDocument } from '../../writer/serializer';
import { hashByteRanges, type HashAlgorithm } from './hash-engine';
import { applySignatureFieldAppearance } from '../fields/appearance-stream';
import {
  makeContentsPlaceholder,
  DEFAULT_CONTENTS_SIZE,
  BYTERANGE_DIGIT_WIDTH,
  findContentsHexSpan,
  computeByteRangeFromContentsSpan,
  calculateByteRange,
  validateByteRange,
  hashExcludedContents,
} from './byterange';
import {
  patchByteRangeInPlace,
  fillContentsHex,
  injectSignature,
  injectSignatureContents,
} from './signature-injector';
import { finalizePdfSignature } from './finalizer';
import type { SignatureAlgorithmKind } from './cms-builder';

export {
  DEFAULT_CONTENTS_SIZE,
  BYTERANGE_DIGIT_WIDTH,
  makeContentsPlaceholder,
  findContentsHexSpan,
  computeByteRangeFromContentsSpan,
  calculateByteRange,
  validateByteRange,
  hashExcludedContents,
  patchByteRangeInPlace,
  fillContentsHex,
  injectSignature,
  injectSignatureContents,
  finalizePdfSignature,
};

export interface CryptoSignOptions {
  reason?: string;
  location?: string;
  contactInfo?: string;
  name?: string;
  hashAlgorithm?: HashAlgorithm;
  /** Reserved /Contents size in raw CMS bytes. */
  contentsSize?: number;
  /** Optional DER certificate to embed in CMS. */
  certificateDer?: Uint8Array;
  /** Appearance text / name for /AP generation. */
  appearanceText?: string;
  includeSigningTime?: boolean;
  /** Phase 11 — request RFC 3161 timestamp (falls back if TSA down). */
  enableTimestamp?: boolean;
  tsaUrl?: string;
}

export interface SignPipelineResult {
  bytes: Uint8Array;
  byteRange: [number, number, number, number];
  messageDigest: Uint8Array;
  messageDigestHex: string;
  hashAlgorithm: HashAlgorithm;
  signatureAlgorithm: SignatureAlgorithmKind;
  cms: Uint8Array;
  fieldRef: PDFRef;
  sigRef: PDFRef;
  incremental?: IncrementalWriteResult;
  timestampApplied?: boolean;
  timestampError?: string;
}

/**
 * Create a signature dictionary with placeholder Contents + ByteRange.
 */
export function createSignatureDictionary(
  doc: PDFDocumentData,
  options: CryptoSignOptions = {},
): PDFRef {
  const contentsSize = options.contentsSize ?? DEFAULT_CONTENTS_SIZE;
  const placeholder = makeContentsPlaceholder(contentsSize);

  const sigDict = new PDFDict();
  sigDict.set('Type', new PDFName('Sig'));
  sigDict.set('Filter', new PDFName('Adobe.PPKLite'));
  sigDict.set('SubFilter', new PDFName('adbe.pkcs7.detached'));
  sigDict.set('Contents', new PDFHexString(placeholder));

  // Fixed-width ByteRange placeholders so in-place patch won't shift bytes
  const br = new PDFArray([
    new PDFNumber(0),
    new PDFNumber(9999999999),
    new PDFNumber(9999999999),
    new PDFNumber(9999999999),
  ]);
  sigDict.set('ByteRange', br);

  if (options.reason) sigDict.set('Reason', new PDFString(options.reason));
  if (options.location) sigDict.set('Location', new PDFString(options.location));
  if (options.contactInfo) sigDict.set('ContactInfo', new PDFString(options.contactInfo));
  if (options.name) sigDict.set('Name', new PDFString(options.name));
  sigDict.set(
    'M',
    new PDFString(
      `D:${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}+00'00'`,
    ),
  );

  const sigRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(sigRef.toKey(), sigDict);
  return sigRef;
}

/**
 * Full cryptographic signing of a signature field.
 */
export async function signDocumentCryptographic(
  doc: PDFDocumentData,
  fieldRef: PDFRef,
  privateKey: CryptoKey,
  options: CryptoSignOptions = {},
): Promise<SignPipelineResult> {
  const field = doc.objects.get(fieldRef.toKey());
  if (!(field instanceof PDFDict)) {
    throw new Error('Signature field not found');
  }

  const hashAlgorithm = options.hashAlgorithm ?? 'sha256';
  const contentsSize = options.contentsSize ?? DEFAULT_CONTENTS_SIZE;

  if (!doc.rawBytes || doc.rawBytes.length === 0) {
    doc.rawBytes = await serializeDocument(doc);
  }

  const sigRef = createSignatureDictionary(doc, options);
  field.set('V', sigRef);

  if (options.appearanceText) {
    const rect = field.get('Rect');
    let w = 160;
    let h = 50;
    if (rect instanceof PDFArray) {
      const n = rect.asNumbers();
      w = Math.abs((n[2] ?? 160) - (n[0] ?? 0));
      h = Math.abs((n[3] ?? 50) - (n[1] ?? 0));
    }
    applySignatureFieldAppearance(doc, fieldRef, {
      width: w,
      height: h,
      typedName: options.appearanceText,
      date: new Date().toLocaleDateString(),
      reason: options.reason,
      location: options.location,
      backgroundColor: [1, 1, 1],
      borderWidth: 1,
    });
  }

  const modified = new Set<string>([fieldRef.toKey(), sigRef.toKey()]);
  // Field creation mutates the catalog's AcroForm and the page's Annots.
  // Both objects must be present in the signing revision, otherwise readers
  // cannot discover the field/widget even though the CMS is valid.
  for (const [key, object] of doc.objects) {
    if (object === doc.catalog) modified.add(key);
  }
  const fieldDict = doc.objects.get(fieldRef.toKey());
  const pageRef = fieldDict instanceof PDFDict && fieldDict.get('P') instanceof PDFRef
    ? fieldDict.get('P') as PDFRef
    : null;
  const fieldPage = pageRef ? doc.pages.find((page) => page.ref.toKey() === pageRef.toKey()) : undefined;
  if (fieldPage) modified.add(fieldPage.ref.toKey());
  const acro = doc.catalog.get('AcroForm');
  if (acro instanceof PDFRef) modified.add(acro.toKey());
  const newObjects = new Map<string, import('../../types').PDFObject>();
  for (const [key, obj] of doc.objects) {
    if (!doc.xref?.entries?.has(key) && key !== fieldRef.toKey() && key !== sigRef.toKey()) {
      newObjects.set(key, obj);
      modified.add(key);
    }
  }

  const incremental = appendIncrementalUpdate(doc, modified, newObjects);

  const finalized = await finalizePdfSignature({
    pdfBytes: incremental.bytes,
    privateKey,
    hashAlgorithm,
    contentsSize,
    certificateDer: options.certificateDer,
    includeSigningTime: options.includeSigningTime,
    enableTimestamp: options.enableTimestamp,
    tsaUrl: options.tsaUrl,
  });

  if (!finalized.validation.ok) {
    console.warn('[sign] ByteRange validation warnings:', finalized.validation.errors);
  }

  doc.rawBytes = finalized.bytes;

  // Keep in-memory Sig dict aligned with patched bytes (validation / multi-sig UI)
  const sigObj = doc.objects.get(sigRef.toKey());
  if (sigObj instanceof PDFDict) {
    const { bytesToHex } = await import('./hash-engine');
    const cmsHex = bytesToHex(finalized.cms);
    const capacity = contentsSize * 2;
    const padded =
      cmsHex.length >= capacity
        ? cmsHex.slice(0, capacity)
        : cmsHex + '0'.repeat(capacity - cmsHex.length);
    sigObj.set('Contents', new PDFHexString(padded));
    sigObj.set(
      'ByteRange',
      new PDFArray(finalized.byteRange.map((n) => new PDFNumber(n))),
    );
  }

  return {
    bytes: finalized.bytes,
    byteRange: finalized.byteRange,
    messageDigest: finalized.messageDigest,
    messageDigestHex: finalized.messageDigestHex,
    hashAlgorithm: finalized.hashAlgorithm,
    signatureAlgorithm: finalized.signatureAlgorithm,
    cms: finalized.cms,
    fieldRef,
    sigRef,
    incremental,
    timestampApplied: finalized.timestampApplied,
    timestampError: finalized.timestampError,
  };
}

export async function computeDocumentDigest(
  pdfBytes: Uint8Array,
  byteRange: [number, number, number, number],
  algorithm: HashAlgorithm = 'sha256',
): Promise<Uint8Array> {
  return hashByteRanges(pdfBytes, byteRange, algorithm);
}
