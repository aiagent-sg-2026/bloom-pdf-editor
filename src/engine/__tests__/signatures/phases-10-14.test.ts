/**
 * Phases 10–14 — validation, timestamp, multi-sig, LTV, UX helpers.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { BRAND_NAME } from '../../../lib/brand';
import { readFileSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PDFArray,
  PDFDict,
  PDFDocumentData,
  PDFName,
  PDFNumber,
  PDFRef,
} from '../../types';
import { serializeDocument } from '../../writer/serializer';
import { saveQuick, saveOptimized } from '../../writer/save-pipeline';
import {
  createSignatureField,
  signDocumentCryptographic,
  importFromPem,
  validateDocumentSignatures,
  validateSignatureField,
  validationStatusBadge,
  buildTimestampRequest,
  parseTimestampResponse,
  cmsHasTimestampToken,
  listManagedSignatures,
  buildRevisionViewer,
  canAddSignatureWithoutInvalidating,
  collectEmbeddedCertificates,
  enableLongTermValidation,
  getLtvStatus,
  pushRecentSignatureId,
  listRecentSignatureIds,
  orderLibraryByRecent,
  lockSignaturesAfterSigning,
  snapToAlignmentGuides,
  defaultPageGuides,
  createVisualSignature,
  SIGNATURE_SHORTCUTS,
} from '../../signatures';

const generatedFixtures = mkdtempSync(join(tmpdir(), 'bloom-signature-'));
const signerKey = join(generatedFixtures, 'signer.key');
const signerCert = join(generatedFixtures, 'signer.crt');

beforeAll(() => {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', signerKey, '-out', signerCert,
    '-days', '1', '-subj', '/CN=Bloom Test Signer',
  ], { stdio: 'ignore' });
});

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

async function signFixtureField(doc: PDFDocumentData, name: string) {
  const pem = `${readFileSync(signerKey, 'utf8')}\n${readFileSync(signerCert, 'utf8')}`;
  const bundle = await importFromPem(pem, 'fixture');
  doc.rawBytes = await serializeDocument(doc);
  const fieldRef = createSignatureField(doc, 0, {
    x: 72, y: 700, width: 180, height: 50,
  }, name);
  doc.rawBytes = await serializeDocument(doc);
  const result = await signDocumentCryptographic(
    doc,
    fieldRef,
    bundle.key!.privateKey,
    {
      reason: 'Phase test',
      name: 'Bloom Test Signer',
      hashAlgorithm: 'sha256',
      contentsSize: 4096,
      certificateDer: bundle.leaf!.der,
      appearanceText: BRAND_NAME,
      enableTimestamp: false,
    },
  );
  doc.rawBytes = result.bytes;
  return { result, bundle, fieldRef };
}

describe('Phase 10 — validation engine', () => {
  it('validates a freshly signed document as Valid/Unknown with digest match', async () => {
    const doc = makeBasePdf();
    await signFixtureField(doc, 'SigVal');
    const report = await validateDocumentSignatures(doc, { allowSelfSigned: true });
    expect(report.signatures.length).toBeGreaterThan(0);
    const signed = report.signatures.find((s) => s.digestMatch || s.status !== 'Unknown');
    expect(signed).toBeTruthy();
    expect(signed!.byteRangeOk).toBe(true);
    expect(signed!.digestMatch).toBe(true);
    expect(['Valid', 'Unknown']).toContain(signed!.status);
    expect(validationStatusBadge('Valid').tone).toBe('ok');
    expect(validationStatusBadge('Modified').tone).toBe('bad');
  }, 30000);

  it('exports the exact finalized bytes in both save modes', async () => {
    const doc = makeBasePdf();
    const { result } = await signFixtureField(doc, 'SigSave');
    const signed = new Uint8Array(result.bytes);
    expect(await saveQuick(doc)).toEqual(signed);
    expect(await saveOptimized(doc)).toEqual(signed);
  }, 30000);

  it('detects Modified when PDF bytes after Contents are altered', async () => {
    const doc = makeBasePdf();
    await signFixtureField(doc, 'SigMod');
    const bytes = new Uint8Array(doc.rawBytes!);
    // Flip a byte in the trailing region (after Contents) if possible
    const last = bytes.length - 5;
    bytes[last] = (bytes[last] ^ 0xff) & 0xff;
    doc.rawBytes = bytes;

    const fields = (await import('../../signatures')).listSignatureFields(doc);
    const field = fields.find((f) => f.signed)!;
    const detail = await validateSignatureField(doc, field, bytes, { allowSelfSigned: true });
    // Digest should fail after tamper
    expect(detail.digestMatch).toBe(false);
    expect(detail.status).toBe('Modified');
  }, 30000);
});

describe('Phase 11 — timestamp helpers', () => {
  it('builds a TimeStampReq DER', async () => {
    const hash = new Uint8Array(32).fill(0xab);
    const req = buildTimestampRequest(hash, { hashAlgorithm: 'sha256', certReq: true });
    expect(req[0]).toBe(0x30);
    expect(req.length).toBeGreaterThan(40);
  });

  it('parses a minimal rejected TimeStampResp', () => {
    // SEQUENCE { PKIStatusInfo SEQUENCE { INTEGER 2 } } = 30 05 30 03 02 01 02
    const resp = new Uint8Array([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]);
    const parsed = parseTimestampResponse(resp);
    expect(parsed.token).toBeNull();
    expect(parsed.status).toBe(2);
  });

  it('cmsHasTimestampToken returns false for plain CMS', async () => {
    const doc = makeBasePdf();
    const { result } = await signFixtureField(doc, 'SigTs');
    expect(cmsHasTimestampToken(result.cms)).toBe(false);
  }, 30000);
});

describe('Phase 12 — multi-signature manager', () => {
  it('lists managed signatures and revision viewer after sign', async () => {
    const doc = makeBasePdf();
    expect(canAddSignatureWithoutInvalidating(doc).ok).toBe(false);
    await signFixtureField(doc, 'SigMulti');
    expect(canAddSignatureWithoutInvalidating(doc).ok).toBe(true);
    const managed = listManagedSignatures(doc);
    expect(managed.length).toBe(1);
    expect(managed[0].hasCms).toBe(true);
    expect(managed[0].signerName).toBe('Bloom Test Signer');
    const { revisions, chain } = buildRevisionViewer(doc);
    expect(chain).not.toBeNull();
    expect(revisions.length).toBeGreaterThan(0);
  }, 30000);
});

describe('Phase 13 — LTV / DSS', () => {
  it('embeds DSS with certificates from CMS', async () => {
    const doc = makeBasePdf();
    await signFixtureField(doc, 'SigLtv');
    const certs = collectEmbeddedCertificates(doc);
    expect(certs.length).toBeGreaterThan(0);
    const before = getLtvStatus(doc);
    expect(before.enabled).toBe(false);
    const result = enableLongTermValidation(doc);
    expect(result.certCount).toBeGreaterThan(0);
    const after = getLtvStatus(doc);
    expect(after.enabled).toBe(true);
    expect(after.offlineReady).toBe(true);
  }, 30000);
});

describe('Phase 14 — UX helpers', () => {
  it('tracks recent signatures and orders library', () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
    pushRecentSignatureId('b', fake);
    pushRecentSignatureId('a', fake);
    expect(listRecentSignatureIds(fake)[0]).toBe('a');
    const ordered = orderLibraryByRecent(
      [
        { id: 'b', name: 'B', createdAt: 1, updatedAt: 1, favorite: false, source: 'draw', imageDataUrl: '', width: 1, height: 1 },
        { id: 'a', name: 'A', createdAt: 1, updatedAt: 1, favorite: false, source: 'draw', imageDataUrl: '', width: 1, height: 1 },
        { id: 'c', name: 'C', createdAt: 1, updatedAt: 1, favorite: true, source: 'draw', imageDataUrl: '', width: 1, height: 1 },
      ] as import('../../signatures').SignatureLibraryEntry[],
      listRecentSignatureIds(fake),
    );
    expect(ordered[0].id).toBe('a');
    expect(SIGNATURE_SHORTCUTS.tool).toBe('s');
  });

  it('locks overlays and snaps to guides', () => {
    const sig = createVisualSignature({
      pageIndex: 0,
      x: 100,
      y: 100,
      appearanceId: 'x',
      appearanceType: 'drawn',
    });
    const locked = lockSignaturesAfterSigning([sig], 0);
    expect(locked[0].locked).toBe(true);
    const guides = defaultPageGuides(612, 792);
    const snapped = snapToAlignmentGuides(38, 40, guides, 6);
    expect(snapped.snappedX).toBe(true);
    expect(snapped.x).toBe(36);
  });
});
