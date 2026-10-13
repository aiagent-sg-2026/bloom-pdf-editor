import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFDocumentData, type PDFObject,
} from '../../types';
import { serializeDocument } from '../../writer/serializer';
import { saveQuick } from '../../writer/save-pipeline';
import { parsePDF } from '../../parser/parser';
import { dehydrateDocument } from '../../worker/codec';
import { handleWorkerCommand } from '../../worker/handler';
import {
  createSignatureFieldAtPoint,
  importFromPem,
  signDocumentCryptographic,
  validateDocumentSignatures,
  parseCMSSignedData,
} from '../../signatures';
import { parseDERNode } from '../../signatures/crypto/signature-verify';
import { getTestCredentials } from './test-credentials';

function makeDocument(): PDFDocumentData {
  const objects = new Map<string, PDFObject>();
  const catalogRef = new PDFRef(1, 0);
  const pagesRef = new PDFRef(2, 0);
  const pageRef = new PDFRef(3, 0);
  const catalog = new PDFDict([['Type', new PDFName('Catalog')], ['Pages', pagesRef]]);
  const pages = new PDFDict([
    ['Type', new PDFName('Pages')],
    ['Kids', new PDFArray([pageRef])],
    ['Count', new PDFNumber(1)],
  ]);
  const page = new PDFDict([
    ['Type', new PDFName('Page')],
    ['Parent', pagesRef],
    ['MediaBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792)])],
  ]);
  objects.set(catalogRef.toKey(), catalog);
  objects.set(pagesRef.toKey(), pages);
  objects.set(pageRef.toKey(), page);
  return {
    version: '1.7',
    objects,
    xref: {
      entries: new Map(),
      trailerDict: new PDFDict([['Root', catalogRef], ['Size', new PDFNumber(4)]]),
    },
    catalog,
    pages: [{
      index: 0, dict: page, mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0, ref: pageRef,
      resources: new PDFDict(), contentRefs: [],
    }],
    info: {},
    rawBytes: new Uint8Array(),
  };
}

describe('worker-safe cryptographic signing', () => {
  it('does not treat an all-zero Contents placeholder as finalized', async () => {
    const doc = makeDocument();
    const placeholder = new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 10 20 10] /Contents <000000000000>\n');
    doc.rawBytes = placeholder;
    const saved = await saveQuick(doc);
    expect(saved).not.toEqual(placeholder);
  });

  it('keeps the AcroForm and widget in the signing revision', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680, {
      fieldName: 'BrowserSignature',
      withPlaceholderAppearance: true,
    });
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const result = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
      appearanceText: 'Browser signer',
    });
    const reparsed = await parsePDF(result.bytes);
    const acroEntry = reparsed.catalog.get('AcroForm');
    const acro = acroEntry instanceof PDFRef ? reparsed.objects.get(acroEntry.toKey()) : acroEntry;
    expect(acro).toBeInstanceOf(PDFDict);
    const fields = (acro as PDFDict).get('Fields');
    expect(fields).toBeInstanceOf(PDFArray);
    expect((fields as PDFArray).items.some((item) => item instanceof PDFRef && item.toKey() === field.ref.toKey())).toBe(true);
    expect((acro as PDFDict).getNumber('SigFlags')).toBe(3);
    const annots = reparsed.pages[0].dict.get('Annots');
    expect(annots).toBeInstanceOf(PDFArray);
    expect((annots as PDFArray).items.some((item) => item instanceof PDFRef && item.toKey() === field.ref.toKey())).toBe(true);

    const report = await validateDocumentSignatures(reparsed, { allowSelfSigned: true });
    expect(report.signatures[0]?.byteRangeOk).toBe(true);
    expect(report.signatures[0]?.digestMatch).toBe(true);

    const outputPath = join(tmpdir(), 'bloom-worker-signature.pdf');
    writeFileSync(outputPath, result.bytes);
    try {
      const qpdf = spawnSync('qpdf', ['--check', outputPath], { encoding: 'utf8' });
      if ((qpdf.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(qpdf.status).toBe(0);
        expect(`${qpdf.stdout}${qpdf.stderr}`).not.toMatch(/WARNING|ERROR/);
      }
      const pdfsig = spawnSync('pdfsig', [outputPath], { encoding: 'utf8' });
      if ((pdfsig.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') expect(`${pdfsig.stdout}${pdfsig.stderr}`).toMatch(/Signature|signature/);
    } finally {
      unlinkSync(outputPath);
    }
  }, 30000);

  it('matches CMS SignerInfo to the embedded certificate and verifies externally', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680, {
      fieldName: 'CmsSignerIdentifier',
      withPlaceholderAppearance: true,
    });
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const result = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });

    const cms = parseCMSSignedData(result.cms);
    const signer = cms.signerInfos[0]!;
    const certificate = parseDERNode(credentials.certificateDer);
    const tbs = certificate.children![0]!;
    let index = tbs.children![0]?.class === 'context' ? 1 : 0;
    const serial = tbs.children![index++];
    index++;
    const issuer = tbs.children![index];
    const sid = signer.sid.children!;
    expect(Array.from(sid[0]!.content)).toEqual(Array.from(issuer!.content));
    expect(Array.from(sid[1]!.content)).toEqual(Array.from(serial!.content));

    const reparsed = await parsePDF(result.bytes);
    const report = await validateDocumentSignatures(reparsed, { allowSelfSigned: true });
    expect(report.signatures[0]?.byteRangeOk).toBe(true);
    expect(report.signatures[0]?.digestMatch).toBe(true);
    expect(report.signatures[0]?.cmsSignatureOk).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), 'bloom-cms-verify-'));
    const signaturePath = join(directory, 'signature.der');
    const contentPath = join(directory, 'signed.bin');
    const pdfPath = join(directory, 'signed.pdf');
    writeFileSync(signaturePath, result.cms);
    writeFileSync(contentPath, Buffer.concat([
      Buffer.from(result.bytes.slice(result.byteRange[0], result.byteRange[0] + result.byteRange[1])),
      Buffer.from(result.bytes.slice(result.byteRange[2], result.byteRange[2] + result.byteRange[3])),
    ]));
    writeFileSync(pdfPath, result.bytes);
    try {
      const openssl = spawnSync('openssl', [
        'cms', '-verify', '-inform', 'DER', '-in', signaturePath,
        '-content', contentPath, '-binary', '-noverify',
      ], { encoding: 'utf8' });
      if ((openssl.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(openssl.status).toBe(0);
        expect(`${openssl.stdout}${openssl.stderr}`).toMatch(/Verification successful/);
      }

      const pdfsig = spawnSync('pdfsig', [pdfPath], { encoding: 'utf8' });
      if ((pdfsig.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(`${pdfsig.stdout}${pdfsig.stderr}`).not.toContain('Unknown Validation Failure');
      }
    } finally {
      unlinkSync(signaturePath);
      unlinkSync(contentPath);
      unlinkSync(pdfPath);
    }
  }, 30000);

  it('returns signed bytes unchanged through SAVE_PDF and OPTIMIZE_PDF worker commands', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });
    for (const type of ['SAVE_PDF', 'OPTIMIZE_PDF'] as const) {
      const response = await handleWorkerCommand({
        type,
        requestId: type,
        document: dehydrateDocument(doc),
      });
      expect(response.type).toBe('RESULT');
      expect(response.type === 'RESULT' && response.bytes).toEqual(signed.bytes);
    }
  }, 30000);
});
