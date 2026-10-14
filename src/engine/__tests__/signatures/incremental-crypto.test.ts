/**
 * Phase 6 — Incremental updates; Phase 7 — cryptographic signing.
 */

import { describe, it, expect } from 'vitest';
import { BRAND_NAME } from '../../../lib/brand';
import {
  PDFArray,
  PDFDict,
  PDFDocumentData,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from '../../types';
import {
  appendIncrementalUpdate,
  IncrementalUpdateSession,
  listRevisions,
  OffsetManager,
  RevisionManager,
  saveIncremental,
} from '../../writer/incremental-writer';
import {
  hashBytes,
  hashByteRanges,
  bytesToHex,
  HASH_ALGORITHMS,
} from '../../signatures/crypto/hash-engine';
import {
  buildDetachedCMSAdvanced,
  getSignedAttributesForSigning,
  buildDetachedCMS,
} from '../../signatures/crypto/cms-builder';
import {
  makeContentsPlaceholder,
  findContentsHexSpan,
  computeByteRangeFromContentsSpan,
  fillContentsHex,
  patchByteRangeInPlace,
  createSignatureField,
  signDocumentCryptographic,
  DEFAULT_CONTENTS_SIZE,
} from '../../signatures';
import { serializeDocument } from '../../writer/serializer';

function latin1(str: string): Uint8Array {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
  return b;
}

/** Minimal valid-enough PDF for incremental append tests. */
function makeBasePdf(): { doc: PDFDocumentData; bytes: Uint8Array } {
  const objects = new Map<string, import('../../types').PDFObject>();

  const catalogRef = new PDFRef(1, 0);
  const pagesRef = new PDFRef(2, 0);
  const pageRef = new PDFRef(3, 0);

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', pagesRef);
  objects.set(catalogRef.toKey(), catalog);

  const pages = new PDFDict();
  pages.set('Type', new PDFName('Pages'));
  pages.set('Kids', new PDFArray([pageRef]));
  pages.set('Count', new PDFNumber(1));
  objects.set(pagesRef.toKey(), pages);

  const page = new PDFDict();
  page.set('Type', new PDFName('Page'));
  page.set('Parent', pagesRef);
  page.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  page.set('Annots', new PDFArray([]));
  objects.set(pageRef.toKey(), page);

  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(4));
  trailerDict.set('Root', catalogRef);

  const doc = {
    version: '1.7',
    catalog,
    objects,
    pages: [{
      index: 0,
      ref: pageRef,
      dict: page,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      contentRefs: [],
    }],
    xref: {
      entries: new Map([
        ['1_0', { objNum: 1, genNum: 0, offset: 0, type: 'n' as const }],
        ['2_0', { objNum: 2, genNum: 0, offset: 0, type: 'n' as const }],
        ['3_0', { objNum: 3, genNum: 0, offset: 0, type: 'n' as const }],
      ]),
      trailerDict,
    },
    info: {},
    rawBytes: new Uint8Array(0),
  } as unknown as PDFDocumentData;

  return { doc, bytes: new Uint8Array(0) };
}

describe('Phase 6 — incremental updates', () => {
  it('OffsetManager records batch offsets', () => {
    const om = new OffsetManager(1000);
    om.recordBatch(new Map([['10_0', 1000], ['11_0', 1100]]), 1, 1500);
    expect(om.getOffset('10_0')).toBe(1000);
    expect(om.length).toBe(1500);
    expect(om.all()).toHaveLength(2);
  });

  it('appends without rewriting the original prefix', async () => {
    const { doc } = makeBasePdf();
    doc.rawBytes = await serializeDocument(doc);
    const original = new Uint8Array(doc.rawBytes);
    const originalLen = original.length;

    // Modify page dict
    const page = doc.pages[0].dict;
    page.set('Rotate', new PDFNumber(90));

    const result = appendIncrementalUpdate(
      doc,
      new Set([doc.pages[0].ref.toKey()]),
    );

    expect(result.originalLength).toBe(originalLen);
    // Prefix preserved
    for (let i = 0; i < originalLen; i++) {
      expect(result.bytes[i]).toBe(original[i]);
    }
    expect(result.bytes.length).toBeGreaterThan(originalLen);
    expect(result.xrefOffset).toBeGreaterThan(originalLen);
    expect(result.prevXrefOffset).toBeGreaterThanOrEqual(0);

    // Contains startxref / %%EOF
    const text = Array.from(result.bytes).map((c) => String.fromCharCode(c)).join('');
    expect(text).toContain('startxref');
    expect(text).toContain('%%EOF');
    expect(text).toContain('/Prev');
  });

  it('supports multiple revisions via session', async () => {
    const { doc } = makeBasePdf();
    doc.rawBytes = await serializeDocument(doc);
    const session = new IncrementalUpdateSession(doc);

    doc.pages[0].dict.set('Rotate', new PDFNumber(90));
    session.markModifiedRef(doc.pages[0].ref);
    const r1 = session.commit();
    expect(r1.bytes.length).toBeGreaterThan(0);

    doc.pages[0].dict.set('Rotate', new PDFNumber(180));
    session.markModifiedRef(doc.pages[0].ref);
    const r2 = session.commit();
    expect(r2.bytes.length).toBeGreaterThan(r1.bytes.length);

    const revs = session.listRevisions();
    expect(revs.length).toBeGreaterThanOrEqual(2);

    const chain = listRevisions(r2.bytes);
    expect(chain.revisions.length).toBeGreaterThanOrEqual(1);
    expect(chain.fileLength).toBe(r2.bytes.length);
  });

  it('RevisionManager validates Prev chain', () => {
    const rm = new RevisionManager();
    rm.pushRevision({ xrefOffset: 100, prevOffset: null, size: 5, fileLength: 200 });
    rm.pushRevision({ xrefOffset: 150, prevOffset: 100, size: 6, fileLength: 250 });
    const v = rm.validate(250);
    expect(v.ok).toBe(true);
  });

  it('saveIncremental appends and updates rawBytes', async () => {
    const { doc } = makeBasePdf();
    doc.rawBytes = await serializeDocument(doc);
    const before = doc.rawBytes.length;
    const key = doc.pages[0].ref.toKey();
    doc.pages[0].dict.set('Rotate', new PDFNumber(270));
    const a = saveIncremental(doc, new Set([key]));
    expect(a.length).toBeGreaterThan(before);
    expect(doc.rawBytes.length).toBe(a.length);
  });
});

describe('Phase 7 — hash engine + CMS + ByteRange helpers', () => {
  it('hashes with sha256/384/512', async () => {
    const data = latin1(`${BRAND_NAME} hash test`);
    for (const algo of HASH_ALGORITHMS) {
      const d = await hashBytes(data, algo);
      expect(d.length).toBe(algo === 'sha256' ? 32 : algo === 'sha384' ? 48 : 64);
    }
  });

  it('hashByteRanges concatenates segments', async () => {
    const pdf = latin1('AAAAABBBBBCCCCC');
    const d = await hashByteRanges(pdf, [0, 5, 10, 5], 'sha256');
    const direct = await hashBytes(latin1('AAAAACCCCC'), 'sha256');
    expect(bytesToHex(d)).toBe(bytesToHex(direct));
  });

  it('builds CMS with signed attributes', () => {
    const digest = new Uint8Array(32).fill(0xab);
    const sig = new Uint8Array(64).fill(0xcd);
    const cms = buildDetachedCMSAdvanced({
      messageDigest: digest,
      signatureValue: sig,
      hashAlgorithm: 'sha256',
      signatureAlgorithm: 'RSA',
      includeSigningTime: true,
      signingTime: new Date('2026-07-15T00:00:00Z'),
    });
    expect(cms.length).toBeGreaterThan(50);
    // ContentInfo starts with SEQUENCE tag
    expect(cms[0]).toBe(0x30);
    // Legacy API still works
    const legacy = buildDetachedCMS(digest, sig);
    expect(legacy[0]).toBe(0x30);
  });

  it('signed attrs for signing are a DER SET', () => {
    const digest = new Uint8Array(32).fill(1);
    const attrs = getSignedAttributesForSigning({
      messageDigest: digest,
      signingTime: new Date('2026-01-01T00:00:00Z'),
    });
    expect(attrs[0]).toBe(0x31); // SET
  });

  it('Contents placeholder + ByteRange patch + fill', () => {
    const placeholder = makeContentsPlaceholder(16);
    expect(placeholder.length).toBe(32);
    const brPlaceholder = '/ByteRange [0 9999999999 9999999999 9999999999]';
    const body = `%PDF-1.7\n1 0 obj\n<< /Type /Sig /ByteRange [0 9999999999 9999999999 9999999999] /Contents <${placeholder}> >>\nendobj\n`;
    const bytes = latin1(body);
    const span = findContentsHexSpan(bytes, placeholder);
    expect(span).not.toBeNull();
    const br = computeByteRangeFromContentsSpan(bytes.length, span!.start, span!.end);
    expect(br[0]).toBe(0);
    expect(br[1]).toBe(span!.start);
    expect(br[2]).toBe(span!.end);
    expect(patchByteRangeInPlace(bytes, br)).toBe(true);
    const cms = new Uint8Array([1, 2, 3, 4]);
    fillContentsHex(bytes, span!.hexStart, span!.hexEnd, cms);
    const text = Array.from(bytes).map((c) => String.fromCharCode(c)).join('');
    expect(text).toContain('01020304');
    void brPlaceholder;
  });
});

describe('Phase 7 — signing pipeline (WebCrypto)', () => {
  it('signs a field with RSA and produces ByteRange + Contents', async () => {
    const { doc } = makeBasePdf();
    doc.rawBytes = await serializeDocument(doc);

    const fieldRef = createSignatureField(doc, 0, {
      x: 72, y: 700, width: 180, height: 50,
    }, 'SigCrypto');

    // Ensure AcroForm/page changes are in objects; base rawBytes is pre-field
    // Re-serialize so field exists in a fresh base, then sign incrementally
    doc.rawBytes = await serializeDocument(doc);

    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );

    const result = await signDocumentCryptographic(doc, fieldRef, keyPair.privateKey, {
      reason: 'Unit test',
      location: 'Test',
      name: 'Tester',
      hashAlgorithm: 'sha256',
      contentsSize: 4096,
      appearanceText: 'Tester',
    });

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.byteRange[0]).toBe(0);
    expect(result.byteRange[1]).toBeGreaterThan(0);
    expect(result.cms.length).toBeGreaterThan(0);
    expect(result.cms.length).toBeLessThanOrEqual(4096);
    expect(result.messageDigest.length).toBe(32);
    expect(result.signatureAlgorithm).toBe('RSA');

    // Contents placeholder should be filled (CMS at start of hex region)
    const ph = makeContentsPlaceholder(4096);
    const span = findContentsHexSpan(result.bytes, ph);
    expect(span).not.toBeNull();
    const hexHead = Array.from(result.bytes.subarray(span!.hexStart, span!.hexStart + 16))
      .map((b) => String.fromCharCode(b))
      .join('');
    expect(hexHead).not.toBe('0'.repeat(16));

    // Digest of ByteRange should be stable
    const again = await hashByteRanges(result.bytes, result.byteRange, 'sha256');
    expect(bytesToHex(again)).toBe(result.messageDigestHex);

    void DEFAULT_CONTENTS_SIZE;
  }, 30000);
});
