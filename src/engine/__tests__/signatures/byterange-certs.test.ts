/**
 * Phase 8 — ByteRange / injector / finalizer
 * Phase 9 — Certificate import & manager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BRAND_NAME } from '../../../lib/brand';
import {
  calculateByteRange,
  validateByteRange,
  findContentsHexSpan,
  makeContentsPlaceholder,
  injectSignature,
  patchByteRangeInPlace,
  injectSignatureContents,
  DEFAULT_CONTENTS_SIZE,
  decodePem,
  isPem,
  importFromPem,
  importCertificateDer,
  detectCertificateFileFormat,
  formatCertificateSummary,
  isCertificateExpired,
  resetCertificateManagerForTests,
  createSignatureField,
  signDocumentCryptographic,
} from '../../signatures';
import {
  PDFArray,
  PDFDict,
  PDFDocumentData,
  PDFName,
  PDFNumber,
  PDFRef,
} from '../../types';
import { serializeDocument } from '../../writer/serializer';
import { getTestCredentials } from './test-credentials';

const credentials = getTestCredentials();

function latin1(str: string): Uint8Array {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
  return b;
}

function makeBasePdf(): PDFDocumentData {
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

  return {
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
}

describe('Phase 8 — ByteRange calculator & injector', () => {
  it('locates Contents placeholder and computes ByteRange', () => {
    const ph = makeContentsPlaceholder(64);
    const pdf =
      '%PDF-1.4\n' +
      '1 0 obj<< /Type /Sig /ByteRange [0000000000 9999999999 9999999999 9999999999] /Contents <' +
      ph +
      '> >>endobj\n%%EOF\n';
    const bytes = latin1(pdf);
    const calc = calculateByteRange(bytes, ph);
    expect(calc.byteRange[0]).toBe(0);
    expect(calc.byteRange[1]).toBe(calc.contentsSpan.start);
    expect(calc.byteRange[2]).toBe(calc.contentsSpan.end);
    expect(calc.byteRange[3]).toBe(bytes.length - calc.contentsSpan.end);
    expect(calc.contentsCapacity).toBe(64);

    const validation = validateByteRange(bytes, calc.byteRange, calc.contentsSpan);
    expect(validation.ok).toBe(true);
  });

  it('patches ByteRange without shifting Contents offsets', () => {
    const ph = makeContentsPlaceholder(32);
    const pdf =
      'HEADER /ByteRange [0000000000 9999999999 9999999999 9999999999] /Contents <' +
      ph +
      '> TRAILER';
    const bytes = latin1(pdf);
    const before = findContentsHexSpan(bytes, ph)!;
    const br: [number, number, number, number] = [0, before.start, before.end, 10];
    expect(patchByteRangeInPlace(bytes, br)).toBe(true);
    const after = findContentsHexSpan(bytes, ph)!;
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);
  });

  it('injects CMS into Contents without changing file length', () => {
    const ph = makeContentsPlaceholder(16);
    const pdf = `/Contents <${ph}>`;
    const bytes = latin1(pdf);
    const span = findContentsHexSpan(bytes, ph)!;
    const len = bytes.length;
    const cms = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    injectSignatureContents(bytes, span, cms);
    expect(bytes.length).toBe(len);
    const text = Array.from(bytes)
      .map((c) => String.fromCharCode(c))
      .join('');
    expect(text).toContain('deadbeef');
  });

  it('injectSignature patches range then fills Contents', () => {
    const ph = makeContentsPlaceholder(16);
    const pdf =
      '/ByteRange [0000000000 9999999999 9999999999 9999999999] /Contents <' +
      ph +
      '>';
    const bytes = latin1(pdf);
    const calc = calculateByteRange(bytes, ph);
    const { byteRangePatched } = injectSignature(bytes, {
      byteRange: calc.byteRange,
      contentsSpan: calc.contentsSpan,
      cms: new Uint8Array([1, 2]),
    });
    expect(byteRangePatched).toBe(true);
    expect(DEFAULT_CONTENTS_SIZE).toBeGreaterThan(1000);
  });
});

describe('Phase 8 — end-to-end finalize via signing pipeline', () => {
  it('signs with imported RSA key and validates ByteRange digest', async () => {
    const bundle = await importFromPem(credentials.pem, 'fixture');
    expect(bundle.key).not.toBeNull();
    expect(bundle.leaf).not.toBeNull();

    const doc = makeBasePdf();
    doc.rawBytes = await serializeDocument(doc);
    const fieldRef = createSignatureField(doc, 0, {
      x: 72, y: 700, width: 180, height: 50,
    }, 'SigPhase8');
    doc.rawBytes = await serializeDocument(doc);

    const result = await signDocumentCryptographic(
      doc,
      fieldRef,
      bundle.key!.privateKey,
      {
        reason: 'Phase 8 test',
        name: 'Bloom Test Signer',
        hashAlgorithm: 'sha256',
        contentsSize: 4096,
        certificateDer: bundle.leaf!.der,
        appearanceText: `${BRAND_NAME} Test`,
      },
    );

    expect(result.byteRange[0]).toBe(0);
    expect(result.cms.length).toBeGreaterThan(0);
    expect(result.messageDigest.length).toBe(32);
    // Contents still located, but no longer all-zero placeholder
    const span = findContentsHexSpan(result.bytes, makeContentsPlaceholder(4096));
    expect(span).not.toBeNull();
    const hex = Array.from(result.bytes.subarray(span!.hexStart, span!.hexEnd))
      .map((b) => String.fromCharCode(b))
      .join('');
    expect(hex.startsWith('0'.repeat(64))).toBe(false);
    expect(hex.toLowerCase().startsWith(
      Array.from(result.cms.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(''),
    )).toBe(true);
  }, 30000);
});

describe('Phase 9 — certificates', () => {
  beforeEach(() => {
    resetCertificateManagerForTests(null);
  });

  it('detects formats and parses PEM/DER', async () => {
    const pem = credentials.certificatePem;
    const der = credentials.certificateDer;
    expect(isPem(pem)).toBe(true);
    expect(decodePem(pem).length).toBe(1);
    expect(detectCertificateFileFormat('x.pem', new TextEncoder().encode(pem))).toBe('pem');
    expect(detectCertificateFileFormat('x.der', der)).toBe('der');
    expect(detectCertificateFileFormat('x.p12', new Uint8Array([0x30, 0x82]))).toBe('p12');

    const fromPem = await importFromPem(pem);
    expect(fromPem.leaf?.subject.commonName).toBe('Bloom Test Signer');
    expect(fromPem.key).toBeNull();

    const fromDer = await importCertificateDer(der);
    expect(fromDer.leaf?.fingerprintSha256.length).toBe(64);
    expect(formatCertificateSummary(fromDer.leaf!)).toContain('Bloom Test Signer');
    expect(isCertificateExpired(fromDer.leaf!)).toBe(false);
  });

  it('imports key+cert PEM into CertificateManager and selects it', async () => {
    const mgr = resetCertificateManagerForTests(null);
    const identity = await mgr.importPem(credentials.pem, 'Signer');
    expect(identity.hasPrivateKey).toBe(true);
    expect(identity.leaf?.subject.commonName).toBe('Bloom Test Signer');
    expect(mgr.getSelected()?.id).toBe(identity.id);
    expect(mgr.getSelectedKey()?.privateKey).toBeTruthy();
    expect(mgr.getSelectedLeafDer()?.length).toBeGreaterThan(100);
    expect(mgr.summarize(identity.id)).toContain('Bloom Test Signer');
  });

  it('persists public PEMs only (keys stay session-only)', async () => {
    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const mgr = resetCertificateManagerForTests(fakeStorage);
    await mgr.importPem(credentials.pem);
    expect(mgr.getSelectedKey()).not.toBeNull();

    // Rehydrate in a new manager — public cert restored, key not
    const mgr2 = resetCertificateManagerForTests(fakeStorage);
    await new Promise((r) => setTimeout(r, 30));
    const list = mgr2.list();
    expect(list.length).toBe(1);
    expect(list[0].hasPrivateKey).toBe(false);
    expect(list[0].leaf?.subject.commonName).toBe('Bloom Test Signer');
  });
});
