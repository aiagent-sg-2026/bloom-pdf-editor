/**
 * CMS / PKCS#7 SignedData builder for PDF detached signatures (Phase 7).
 * RFC 5652 — detached content, optional certificates, signed attributes.
 */

import {
  hashAlgorithmOID,
  type HashAlgorithm,
} from './hash-engine';
import { parseDERNode } from './signature-verify';

export type SignatureAlgorithmKind = 'RSA' | 'ECDSA';

export interface BuildCMSOptions {
  /** Hash of the PDF ByteRange data (messageDigest). */
  messageDigest: Uint8Array;
  /** Raw signature value from WebCrypto (RSA PKCS1 or ECDSA P1363). */
  signatureValue: Uint8Array;
  /** Digest algorithm used for messageDigest. */
  hashAlgorithm?: HashAlgorithm;
  /** Signing key algorithm. */
  signatureAlgorithm?: SignatureAlgorithmKind;
  /** Optional DER-encoded X.509 certificate. */
  certificateDer?: Uint8Array;
  /** Include signingTime signed attribute. */
  includeSigningTime?: boolean;
  signingTime?: Date;
  /** RFC 3161 TimeStampToken (ContentInfo DER) as unsigned attribute. */
  timestampToken?: Uint8Array;
}

/** Minimal DER length encoding. */
export function derLength(len: number): number[] {
  if (len < 0x80) return [len];
  if (len < 0x100) return [0x81, len];
  if (len < 0x10000) return [0x82, (len >> 8) & 0xff, len & 0xff];
  return [0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
}

export function derSequence(contents: number[]): number[] {
  return [0x30, ...derLength(contents.length), ...contents];
}

export function derSet(contents: number[]): number[] {
  return [0x31, ...derLength(contents.length), ...contents];
}

export function derOctetString(data: Uint8Array | number[]): number[] {
  const arr = Array.from(data);
  return [0x04, ...derLength(arr.length), ...arr];
}

export function derInteger(value: number | Uint8Array): number[] {
  if (typeof value === 'number') {
    if (value < 0x80) return [0x02, 0x01, value];
    if (value < 0x100) return [0x02, 0x02, 0x00, value];
    return [0x02, 0x03, (value >> 8) & 0xff, value & 0xff];
  }
  // Big integer — ensure leading 0 if high bit set
  let arr = Array.from(value);
  if (arr.length > 0 && (arr[0] & 0x80) !== 0) arr = [0x00, ...arr];
  return [0x02, ...derLength(arr.length), ...arr];
}

export function derObjectIdentifier(oid: number[]): number[] {
  if (oid.length < 2) return [0x06, 0x01, 0x00];
  const body: number[] = [oid[0] * 40 + oid[1]];
  for (let i = 2; i < oid.length; i++) {
    let v = oid[i];
    const stack: number[] = [];
    stack.push(v & 0x7f);
    v >>= 7;
    while (v > 0) {
      stack.push(0x80 | (v & 0x7f));
      v >>= 7;
    }
    for (let j = stack.length - 1; j >= 0; j--) body.push(stack[j]);
  }
  return [0x06, ...derLength(body.length), ...body];
}

function derNull(): number[] {
  return [0x05, 0x00];
}

function derUtcTime(date: Date): number[] {
  // YYMMDDhhmmssZ
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const str = `${yy}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const bytes = Array.from(str).map((c) => c.charCodeAt(0));
  return [0x17, ...derLength(bytes.length), ...bytes];
}

function algorithmIdentifier(oid: number[], withNull = true): number[] {
  return derSequence([...derObjectIdentifier(oid), ...(withNull ? derNull() : [])]);
}

function attribute(oid: number[], value: number[]): number[] {
  // Attribute ::= SEQUENCE { type OID, values SET OF ANY }
  return derSequence([...derObjectIdentifier(oid), ...derSet(value)]);
}

function compareDerBytes(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * Extract the exact issuer Name and serial INTEGER encodings from the leaf
 * certificate. CMS matches a certificate using these encoded values, so the
 * issuer must not be reconstructed from display-name fields.
 */
function signerIdentifierFromCertificate(
  certificateDer: Uint8Array,
): number[] | null {
  try {
    const certificate = parseDERNode(certificateDer, 0);
    const tbs = certificate.children?.[0];
    if (!tbs?.children) return null;
    let index = tbs.children[0]?.class === 'context' ? 1 : 0;
    const serial = tbs.children[index++];
    index++; // signature algorithm
    const issuer = tbs.children[index++];
    if (!serial || !issuer) return null;
    return [
      ...certificateDer.slice(issuer.offset, issuer.offset + issuer.length),
      ...certificateDer.slice(serial.offset, serial.offset + serial.length),
    ];
  } catch {
    return null;
  }
}

/**
 * Build signedAttrs SET content (without outer tag) then wrap as SET (0x31)
 * for signing, and as context-specific [0] IMPLICIT for embedding in SignerInfo.
 */
function buildSignedAttributes(
  messageDigest: Uint8Array,
  includeSigningTime: boolean,
  signingTime: Date,
): { forSigning: Uint8Array; forEmbedding: number[] } {
  const contentTypeOid = [1, 2, 840, 113549, 1, 9, 3];
  const messageDigestOid = [1, 2, 840, 113549, 1, 9, 4];
  const signingTimeOid = [1, 2, 840, 113549, 1, 9, 5];
  const dataOid = [1, 2, 840, 113549, 1, 7, 1];

  const attrs: number[][] = [];
  // contentType = id-data
  attrs.push(attribute(contentTypeOid, derObjectIdentifier(dataOid)));
  // messageDigest
  attrs.push(attribute(messageDigestOid, derOctetString(messageDigest)));
  if (includeSigningTime) {
    attrs.push(attribute(signingTimeOid, derUtcTime(signingTime)));
  }

  // DER requires SET OF members to be sorted by their complete encodings.
  attrs.sort(compareDerBytes);
  const setBytes = derSet(attrs.flat());
  // For embedding in SignerInfo: [0] IMPLICIT — replace SET tag 0x31 with 0xA0
  const forEmbedding = [...setBytes];
  forEmbedding[0] = 0xa0;

  return {
    forSigning: new Uint8Array(setBytes),
    forEmbedding,
  };
}

/**
 * Build a detached CMS SignedData ContentInfo suitable for PDF /Contents.
 */
export function buildDetachedCMSAdvanced(options: BuildCMSOptions): Uint8Array {
  const hashAlgo = options.hashAlgorithm ?? 'sha256';
  const sigKind = options.signatureAlgorithm ?? 'RSA';
  const digestOid = hashAlgorithmOID(hashAlgo);
  const digestAlg = algorithmIdentifier(digestOid, true);

  // Signature algorithm
  const sigOid =
    sigKind === 'ECDSA'
      ? [1, 2, 840, 10045, 2, 1] // ecPublicKey — Acrobat often wants ecdsa-with-SHA*
      : [1, 2, 840, 113549, 1, 1, 1]; // rsaEncryption
  // For ECDSA with SHA-256 use ecdsa-with-SHA256 1.2.840.10045.4.3.2
  const ecdsaWithSha =
    hashAlgo === 'sha512'
      ? [1, 2, 840, 10045, 4, 3, 4]
      : hashAlgo === 'sha384'
        ? [1, 2, 840, 10045, 4, 3, 3]
        : [1, 2, 840, 10045, 4, 3, 2];
  const sigAlg =
    sigKind === 'ECDSA'
      ? algorithmIdentifier(ecdsaWithSha, false)
      : algorithmIdentifier(sigOid, true);

  const includeTime = options.includeSigningTime !== false;
  const signedAttrs = buildSignedAttributes(
    options.messageDigest,
    includeTime,
    options.signingTime ?? new Date(),
  );

  // If the certificate is unavailable or malformed, retain the legacy
  // certificate-less behavior. Such CMS cannot be matched to a signer by
  // independent validators because there is no certificate to identify.
  const signerIdentifier = options.certificateDer && options.certificateDer.length > 0
    ? signerIdentifierFromCertificate(options.certificateDer)
    : null;
  const sid = derSequence(signerIdentifier ?? [
    ...derSequence([]),
    ...derInteger(1),
  ]);

  const encDigest = derOctetString(options.signatureValue);

  const signerInfoParts: number[] = [
    ...derInteger(1), // version
    ...sid,
    ...digestAlg,
    ...signedAttrs.forEmbedding,
    ...sigAlg,
    ...encDigest,
  ];

  // Unsigned attributes: RFC 3161 timestamp token
  if (options.timestampToken && options.timestampToken.length > 0) {
    const tstOid = [1, 2, 840, 113549, 1, 9, 16, 2, 14];
    const tstAttr = attribute(tstOid, Array.from(options.timestampToken));
    const unsignedSet = derSet(tstAttr);
    // [1] IMPLICIT SET
    const unsigned = [...unsignedSet];
    unsigned[0] = 0xa1;
    signerInfoParts.push(...unsigned);
  }

  const signerInfo = derSequence(signerInfoParts);

  const digestAlgs = derSet(digestAlg);
  const signerInfos = derSet(signerInfo);

  // encapContentInfo — detached (no eContent)
  const encapContent = derSequence([
    ...derObjectIdentifier([1, 2, 840, 113549, 1, 7, 1]), // id-data
  ]);

  const signedDataBody: number[] = [
    ...derInteger(1),
    ...digestAlgs,
    ...encapContent,
  ];

  if (options.certificateDer && options.certificateDer.length > 0) {
    const certs = [
      0xa0,
      ...derLength(options.certificateDer.length),
      ...Array.from(options.certificateDer),
    ];
    signedDataBody.push(...certs);
  }

  signedDataBody.push(...signerInfos);
  const signedData = derSequence(signedDataBody);

  const contentInfo = derSequence([
    ...derObjectIdentifier([1, 2, 840, 113549, 1, 7, 2]), // signedData
    0xa0,
    ...derLength(signedData.length),
    ...signedData,
  ]);

  return new Uint8Array(contentInfo);
}

/**
 * Bytes that must be signed when signedAttrs are present (DER SET of attributes).
 */
export function getSignedAttributesForSigning(options: {
  messageDigest: Uint8Array;
  includeSigningTime?: boolean;
  signingTime?: Date;
}): Uint8Array {
  return buildSignedAttributes(
    options.messageDigest,
    options.includeSigningTime !== false,
    options.signingTime ?? new Date(),
  ).forSigning;
}

/** Legacy wrapper matching older buildDetachedCMS(digest, signature, cert?) API. */
export function buildDetachedCMS(
  digest: Uint8Array,
  signature: Uint8Array,
  certDer?: Uint8Array,
): Uint8Array {
  return buildDetachedCMSAdvanced({
    messageDigest: digest,
    signatureValue: signature,
    certificateDer: certDer,
    hashAlgorithm: 'sha256',
    signatureAlgorithm: 'RSA',
    includeSigningTime: true,
  });
}
