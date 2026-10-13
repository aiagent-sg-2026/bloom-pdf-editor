/**
 * Object encryption key derivation and string/stream cipher ops.
 */

import { md5 } from '../crypto/md5';
import { rc4 } from '../crypto/rc4';
import { aesDecryptCbc, aesEncryptCbc } from '../crypto/aes';
import { concatBytes } from '../crypto/bytes';
import type { EncryptionAlgorithm, EncryptDictionary } from '../types';
import { detectAlgorithm } from './standard-handler';

const SALT = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // 'sAlT'

/**
 * Algorithm 1 — Compute object encryption key.
 */
export function computeObjectKey(
  fileKey: Uint8Array,
  objNum: number,
  genNum: number,
  algorithm: EncryptionAlgorithm,
): Uint8Array {
  // AES-256 (R5/R6) uses the file key directly
  if (algorithm === 'AES-256') {
    return fileKey;
  }

  const objBytes = new Uint8Array([
    objNum & 0xff,
    (objNum >> 8) & 0xff,
    (objNum >> 16) & 0xff,
    genNum & 0xff,
    (genNum >> 8) & 0xff,
  ]);

  const isAes = algorithm === 'AES-128';
  const input = isAes
    ? concatBytes(fileKey, objBytes, SALT)
    : concatBytes(fileKey, objBytes);

  const hash = md5(input);
  const n = Math.min(fileKey.length + 5, 16);
  return hash.subarray(0, n);
}

export async function decryptBytes(
  data: Uint8Array,
  key: Uint8Array,
  algorithm: EncryptionAlgorithm,
): Promise<Uint8Array> {
  if (algorithm === 'AES-128' || algorithm === 'AES-256') {
    return aesDecryptCbc(key, data);
  }
  return rc4(key, data);
}

export async function encryptBytes(
  data: Uint8Array,
  key: Uint8Array,
  algorithm: EncryptionAlgorithm,
): Promise<Uint8Array> {
  if (algorithm === 'AES-128' || algorithm === 'AES-256') {
    return aesEncryptCbc(key, data);
  }
  return rc4(key, data);
}

export function algorithmForEncrypt(enc: EncryptDictionary): EncryptionAlgorithm {
  return detectAlgorithm(enc);
}

/** Resolve the cipher selected by a PDF crypt filter. */
export function algorithmForFilter(
  enc: EncryptDictionary,
  filterName: string,
): EncryptionAlgorithm | null {
  // V1 has no crypt filters. The parser represents its implicit default
  // cipher with Identity for StmF/StrF, but that means the filter dictionary
  // is absent—not that streams and strings are left unencrypted.
  if (enc.version < 4) {
    return enc.length <= 40 ? 'RC4-40' : 'RC4-128';
  }
  if (filterName === 'Identity') return null;
  const filter = enc.cryptFilters.get(filterName);
  if (!filter || filter.method === 'None' || filter.method === 'Identity') return null;
  if (filter.method === 'AESV2') return 'AES-128';
  if (filter.method === 'AESV3') return 'AES-256';
  return enc.length <= 40 ? 'RC4-40' : 'RC4-128';
}

/**
 * Whether a stream should be decrypted with the stream crypt filter.
 * Metadata streams are skipped when EncryptMetadata is false.
 */
export function shouldEncryptStream(
  enc: EncryptDictionary,
  streamDictKeys: { type?: string; subtype?: string },
): boolean {
  if (!enc.encryptMetadata && streamDictKeys.type === 'Metadata' && streamDictKeys.subtype === 'XML') {
    return false;
  }
  return algorithmForFilter(enc, enc.stmF) !== null;
}

export function shouldEncryptString(enc: EncryptDictionary): boolean {
  return algorithmForFilter(enc, enc.strF) !== null;
}
