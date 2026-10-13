import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { unlinkSync, writeFileSync } from 'fs';
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
} from '../../signatures';
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
      if (qpdf.error?.code !== 'ENOENT') {
        expect(qpdf.status).toBe(0);
        expect(`${qpdf.stdout}${qpdf.stderr}`).not.toMatch(/WARNING|ERROR/);
      }
      const pdfsig = spawnSync('pdfsig', [outputPath], { encoding: 'utf8' });
      if (pdfsig.error?.code !== 'ENOENT') expect(`${pdfsig.stdout}${pdfsig.stderr}`).toMatch(/Signature|signature/);
    } finally {
      unlinkSync(outputPath);
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
