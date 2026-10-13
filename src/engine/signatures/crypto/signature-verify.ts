/**
 * ASN.1 DER reader, PKCS#7/CMS parsing, and signature digest verification.
 *
 * Verifies the PDF byte-range digest embedded in PKCS#7 SignedData.
 * Uses Web Crypto when available; Node crypto as fallback in server routes.
 *
 * RFC 5652, ISO 32000-2 §12.8.
 */

import type {
  ASN1Node,
  CMSSignedData,
  CMSSignerInfo,
  PKCS7ContentInfo,
  PDFSignatureDict,
  SignatureVerificationResult,
  VerifyDigestOptions,
} from './types';
import { DEFAULT_VERIFY_OPTIONS, OID, OID_TO_DIGEST } from './types';

// ─── ASN.1 DER reader ───────────────────────────────────────────────────────

function classFromTag(byte: number): ASN1Node['class'] {
  const c = (byte >> 6) & 0x03;
  switch (c) {
    case 0: return 'universal';
    case 1: return 'application';
    case 2: return 'context';
    default: return 'private';
  }
}

const UNIVERSAL_NAMES: Record<number, string> = {
  0x01: 'BOOLEAN',
  0x02: 'INTEGER',
  0x03: 'BIT STRING',
  0x04: 'OCTET STRING',
  0x05: 'NULL',
  0x06: 'OBJECT IDENTIFIER',
  0x0c: 'UTF8String',
  0x13: 'PrintableString',
  0x17: 'UTCTime',
  0x30: 'SEQUENCE',
  0x31: 'SET',
};

function readLength(data: Uint8Array, offset: number): { length: number; bytesRead: number } {
  const first = data[offset]!;
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4) throw new Error('Invalid DER length at ' + offset);
  let length = 0;
  for (let i = 1; i <= numBytes; i++) {
    length = (length << 8) | data[offset + i]!;
  }
  return { length, bytesRead: 1 + numBytes };
}

/**
 * Parse one ASN.1 DER node starting at offset.
 */
export function parseDERNode(data: Uint8Array, offset = 0): ASN1Node {
  const start = offset;
  const tagByte = data[offset]!;
  const cls = classFromTag(tagByte);
  const constructed = (tagByte & 0x20) !== 0;
  let tag = tagByte & 0x1f;
  offset++;

  if (tag === 0x1f) {
    tag = 0;
    while (offset < data.length) {
      const b = data[offset]!;
      offset++;
      tag = (tag << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }

  const { length, bytesRead } = readLength(data, offset);
  offset += bytesRead;
  const contentEnd = offset + length;
  const content = data.slice(offset, contentEnd);

  const node: ASN1Node = {
    class: cls,
    constructed,
    tag,
    tagName: cls === 'universal' ? UNIVERSAL_NAMES[tag] : undefined,
    content,
    offset: start,
    length: contentEnd - start,
  };

  if (constructed) {
    node.children = [];
    let childOff = offset;
    while (childOff < contentEnd) {
      const child = parseDERNode(data, childOff);
      node.children.push(child);
      childOff += child.length;
    }
  }

  return node;
}

/** Parse full DER blob into root node. */
export function parseDER(data: Uint8Array): ASN1Node {
  if (data.length === 0) throw new Error('Empty DER input');
  return parseDERNode(data, 0);
}

// ─── OID decoding ───────────────────────────────────────────────────────────

function decodeOID(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const parts: number[] = [];
  parts.push(Math.floor(bytes[0]! / 40));
  parts.push(bytes[0]! % 40);
  let acc = 0;
  for (let i = 1; i < bytes.length; i++) {
    const b = bytes[i]!;
    acc = (acc << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join('.');
}

function nodeOID(node: ASN1Node): string | null {
  if (node.tagName === 'OBJECT IDENTIFIER') return decodeOID(node.content);
  return null;
}

// ─── PKCS#7 / CMS ───────────────────────────────────────────────────────────

function parseContentInfo(node: ASN1Node): PKCS7ContentInfo {
  const children = node.children ?? [];
  const contentType = nodeOID(children[0]!) ?? '';
  const content = children[1] ?? null;
  return { contentType, content };
}

function parseAlgorithmId(node: ASN1Node): string {
  return nodeOID(node.children?.[0] ?? node) ?? '';
}

function parseSignerInfo(node: ASN1Node): CMSSignerInfo {
  const ch = node.children ?? [];
  return {
    version: ch[0]?.content[0] ?? 0,
    sid: ch[1]!,
    digestAlgorithm: parseAlgorithmId(ch[2]!),
    signedAttrs: ch[3]?.class === 'context' ? ch[3] : null,
    signatureAlgorithm: parseAlgorithmId(ch[ch[3]?.class === 'context' ? 4 : 3]!),
    encryptedDigest: ch[ch.length - 1]?.content ?? new Uint8Array(0),
  };
}

/**
 * Parse PKCS#7 SignedData from ContentInfo wrapper.
 */
export function parseCMSSignedData(data: Uint8Array): CMSSignedData {
  const root = parseDER(data);
  const contentInfo = parseContentInfo(root);
  if (contentInfo.contentType !== OID.signedData) {
    throw new Error(`Expected SignedData OID, got ${contentInfo.contentType}`);
  }

  const signedData = contentInfo.content?.children?.[0] ?? contentInfo.content!;
  const ch = signedData.children ?? [];

  const digestAlgorithms = (ch[1]?.children ?? []).map(parseAlgorithmId);
  const encapContentInfo = parseContentInfo(ch[2]!);
  // Certificates are carried in an optional IMPLICIT [0] container. The
  // container itself owns the certificate children; its following sibling is
  // the mandatory signerInfos SET, not the certificate set.
  const certSet = ch.find((node) => node.class === 'context' && node.tag === 0);
  const signerSet = ch[ch.length - 1];

  const certificates = certSet?.children ?? [];
  const signerInfos = (signerSet?.children ?? []).map(parseSignerInfo);

  return {
    version: ch[0]?.content[0] ?? 0,
    digestAlgorithms,
    encapContentInfo,
    certificates,
    signerInfos,
  };
}

// ─── Byte range digest (PDF) ─────────────────────────────────────────────────

/**
 * Compute hash over PDF byte ranges excluding /Contents hex gap.
 * byteRange = [start1, len1, start2, len2]
 */
export function computeByteRangeDigest(
  pdfBytes: Uint8Array,
  byteRange: [number, number, number, number],
  algorithm: VerifyDigestOptions['algorithm'],
): Promise<Uint8Array> {
  const [s1, l1, s2, l2] = byteRange;
  const part1 = pdfBytes.slice(s1, s1 + l1);
  const part2 = pdfBytes.slice(s2, s2 + l2);
  const total = new Uint8Array(part1.length + part2.length);
  total.set(part1, 0);
  total.set(part2, part1.length);

  return digestBytes(total, algorithm);
}

async function digestBytes(
  data: Uint8Array,
  algorithm: VerifyDigestOptions['algorithm'],
): Promise<Uint8Array> {
  const algo = algorithm.toUpperCase().replace('SHA', 'SHA-');
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const digest = await globalThis.crypto.subtle.digest(algo, copy);
    return new Uint8Array(digest);
  }
  // Node fallback for API routes
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash(algorithm).update(data).digest());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function findMessageDigestInSignedAttrs(signedAttrs: ASN1Node | null): string | null {
  if (!signedAttrs?.children) return null;
  for (const attr of signedAttrs.children) {
    const oid = nodeOID(attr.children?.[0] ?? attr);
    if (oid === OID.messageDigest) {
      const set = attr.children?.[1];
      const octet = set?.children?.[0];
      if (octet?.content) return bytesToHex(octet.content);
    }
  }
  return null;
}

/**
 * Verify PKCS#7 message digest against PDF byte ranges.
 * Does not validate certificate chains or RSA/ECDSA signature (Phase 10.2).
 */
export async function verifySignatureDigest(
  pdfBytes: Uint8Array,
  signature: PDFSignatureDict,
  options: Partial<VerifyDigestOptions> = {},
): Promise<SignatureVerificationResult> {
  const opts = { ...DEFAULT_VERIFY_OPTIONS, ...options };
  const errors: string[] = [];

  let cms: CMSSignedData;
  try {
    cms = parseCMSSignedData(signature.contents);
  } catch (e) {
    return {
      valid: false,
      digestMatch: false,
      computedDigest: '',
      embeddedDigest: null,
      algorithm: opts.algorithm,
      errors: [`CMS parse failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const signer = cms.signerInfos[0];
  if (!signer) {
    errors.push('No SignerInfo present');
    return {
      valid: false,
      digestMatch: false,
      computedDigest: '',
      embeddedDigest: null,
      algorithm: opts.algorithm,
      errors,
    };
  }

  const algoFromSigner = OID_TO_DIGEST[signer.digestAlgorithm] ?? opts.algorithm;
  const embeddedDigest = findMessageDigestInSignedAttrs(signer.signedAttrs);

  let computedBytes: Uint8Array;
  try {
    computedBytes = await computeByteRangeDigest(pdfBytes, signature.byteRange, algoFromSigner);
  } catch (e) {
    errors.push(`ByteRange digest failed: ${e instanceof Error ? e.message : String(e)}`);
    return {
      valid: false,
      digestMatch: false,
      computedDigest: '',
      embeddedDigest,
      algorithm: algoFromSigner,
      errors,
    };
  }

  const computedDigest = bytesToHex(computedBytes);
  const digestMatch = embeddedDigest !== null
    ? embeddedDigest === computedDigest
    : true;

  if (embeddedDigest !== null && !digestMatch) {
    errors.push('Message digest mismatch between CMS signed attrs and byte ranges');
  }

  if (signature.byteRange[0] + signature.byteRange[1] > signature.byteRange[2]) {
    errors.push('Invalid byteRange ordering');
  }

  return {
    valid: digestMatch && errors.length === 0,
    digestMatch,
    computedDigest,
    embeddedDigest,
    algorithm: algoFromSigner,
    errors,
  };
}

export { decodeOID, nodeOID, parseContentInfo };
