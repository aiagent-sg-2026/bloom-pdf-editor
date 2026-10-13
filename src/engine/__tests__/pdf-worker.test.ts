import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectTransferBuffers, dehydrateDocument, extractNewObjects, hydrateDocument } from '../worker/codec';
import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../types';
import { parsePDF, saveOptimized, saveQuick, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import { parsePDF as parseDirect } from '../parser/parser';
import { securityEngine } from '../security';

const encryptedFixtures = [
  ['aes-256-r6.pdf', 'userpass'],
  ['aes-128-r4.pdf', 'userpass'],
  ['rc4-128-r4.pdf', 'userpass'],
  ['rc4-40-empty-user-r2.pdf', ''],
] as const;

function fixture(): PDFDocumentData {
  const shared = new PDFDict();
  const resources = new PDFDict([['Font', shared]]);
  const page = new PDFDict([['Resources', resources]]);
  const ref = new PDFRef(1, 0);
  const stream = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]));
  const objects = new Map<string, PDFObject>([['1_0', page], ['2_0', stream]]);
  return { version: '1.7', objects, xref: { entries: new Map([['1_0', { objNum: 1, genNum: 0, offset: 0, type: 'n' as const }]]), trailerDict: new PDFDict([['Root', ref]]) }, catalog: page, pages: [{ index: 0, dict: page, mediaBox: { x: 0, y: 0, width: 10, height: 10 }, cropBox: { x: 0, y: 0, width: 10, height: 10 }, rotate: 0, ref, resources, contentRefs: [ref] }], info: { title: 'test' }, rawBytes: new Uint8Array([37, 80]) };
}

describe('PDF worker codec', () => {
  afterEach(() => {
    resetPDFWorkerForTests();
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  it('round-trips core classes, bytes, and aliases', () => {
    const values = [new PDFName('N'), new PDFString('s'), new PDFHexString('ff'), new PDFNumber(1), new PDFBoolean(true), PDFNull.instance, new PDFArray(), new PDFDict(), new PDFStream(new PDFDict(), new Uint8Array([9])), new PDFRef(4, 0)];
    const doc = fixture();
    values.forEach((value, index) => doc.objects.set(`9_${index}`, value));
    const hydrated = hydrateDocument(dehydrateDocument(doc));
    expect(hydrated.objects.get('9_0')).toBeInstanceOf(PDFName);
    expect(hydrated.objects.get('9_1')).toBeInstanceOf(PDFString);
    expect(hydrated.objects.get('9_2')).toBeInstanceOf(PDFHexString);
    expect(hydrated.objects.get('9_3')).toBeInstanceOf(PDFNumber);
    expect(hydrated.objects.get('9_4')).toBeInstanceOf(PDFBoolean);
    expect(hydrated.objects.get('9_5')).toBe(PDFNull.instance);
    expect(hydrated.objects.get('9_6')).toBeInstanceOf(PDFArray);
    expect(hydrated.objects.get('9_7')).toBeInstanceOf(PDFDict);
    expect(hydrated.objects.get('9_8')).toBeInstanceOf(PDFStream);
    expect(hydrated.objects.get('9_9')).toBeInstanceOf(PDFRef);
    expect(hydrated.catalog).toBe(hydrated.pages[0].dict);
    expect(hydrated.pages[0].resources).toBe(hydrated.pages[0].dict.get('Resources'));
    const result = hydrated.objects.get('2_0') as PDFStream;
    expect(Array.from(result.rawBytes)).toEqual([1, 2, 3]);
    expect(Array.from(result.decodedBytes ?? [])).toEqual([4, 5]);
  });

  it('round-trips the encrypted-document save flag', () => {
    const doc = fixture();
    doc.decryptedFromEncrypted = true;
    expect(hydrateDocument(dehydrateDocument(doc)).decryptedFromEncrypted).toBe(true);
  });

  it('round-trips the authenticated file key only through the wire document', () => {
    const doc = fixture();
    doc.decryptedFromEncrypted = true;
    doc.encryptionFileKey = new Uint8Array([1, 2, 3, 4]);
    doc.encryptionAlgorithm = 'AES-256';
    const hydrated = hydrateDocument(dehydrateDocument(doc));
    expect(Array.from(hydrated.encryptionFileKey ?? [])).toEqual([1, 2, 3, 4]);
    expect(hydrated.encryptionAlgorithm).toBe('AES-256');
    expect(dehydrateDocument(doc)).not.toHaveProperty('password');
  });

  it('copies snapshot bytes before transfer and preserves explicit rawBytes identity', () => {
    const doc = fixture();
    const originalRaw = doc.rawBytes;
    const originalStream = doc.objects.get('2_0') as PDFStream;
    const originalStreamBytes = originalStream.rawBytes;
    const wire = dehydrateDocument(doc);
    expect(wire.rawBytes).not.toBe(originalRaw);
    expect((wire.nodes.find((node) => node.kind === 'stream') as { rawBytes: Uint8Array }).rawBytes).not.toBe(originalStreamBytes);
    const hydrated = hydrateDocument(wire, originalRaw);
    expect(hydrated.rawBytes).toBe(originalRaw);
    const transfer = collectTransferBuffers(wire);
    expect(transfer).not.toContain(originalRaw.buffer);
    expect(transfer).not.toContain(originalStreamBytes.buffer);
  });

  it('isolates xref entry objects in snapshots', () => {
    const doc = fixture();
    const original = doc.xref.entries.get('1_0')!;
    const hydrated = hydrateDocument(dehydrateDocument(doc));
    const snapshot = hydrated.xref.entries.get('1_0')!;
    expect(snapshot).not.toBe(original);
    snapshot.offset = 99;
    expect(original.offset).toBe(0);
  });

  it('uses one graph for newObjects aliases and extracts the same hydrated instance', () => {
    const doc = fixture();
    const shared = doc.objects.get('1_0')!;
    const newObjects = new Map([['8_0', shared]]);
    const wire = dehydrateDocument({ ...doc, objects: new Map([...doc.objects, ...newObjects]) });
    const hydrated = hydrateDocument(wire);
    const extracted = extractNewObjects(hydrated, ['8_0']);
    expect(extracted.get('8_0')).toBe(hydrated.objects.get('1_0'));
  });

  it('optimized fallback does not mutate live objects', async () => {
    resetPDFWorkerForTests();
    const doc = fixture();
    const before = Array.from(doc.objects.entries());
    await saveOptimized(doc);
    expect(Array.from(doc.objects.entries())).toEqual(before);
  });

  it('uses direct parser and writer when Worker is unavailable', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000219 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n268\n%%EOF\n');
    const doc = await parsePDF(pdf);
    expect(doc.catalog).toBeInstanceOf(PDFDict);
    const saved = await saveQuick(doc);
    expect(saved).toBeInstanceOf(Uint8Array);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('advances live rawBytes across two successful worker quick saves', async () => {
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminate() {}
      postMessage(command: Parameters<typeof handleWorkerCommand>[0]) {
        void handleWorkerCommand(command).then((response) => this.onmessage?.({ data: response } as MessageEvent));
      }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    const doc = fixture();
    const modified = new Set(['1_0']);
    const first = await saveQuick(doc, modified);
    expect(doc.rawBytes).toBe(first);
    const firstLength = first.length;
    const second = await saveQuick(doc, modified);
    expect(doc.rawBytes).toBe(second);
    expect(second.length).toBeGreaterThan(firstLength);
  });

  for (const [fixtureName, password] of encryptedFixtures) {
    for (const commandType of ['SAVE_PDF', 'OPTIMIZE_PDF'] as const) {
      it(`${commandType} exports decrypted ${fixtureName} through the worker`, async () => {
        const source = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'encrypted', fixtureName)));
        const opened = await securityEngine.open(await parseDirect(source), password);
        const wire = dehydrateDocument(opened.doc);
        const response = await handleWorkerCommand(commandType === 'SAVE_PDF'
          ? { type: commandType, requestId: `${fixtureName}-${commandType}`, document: wire }
          : { type: commandType, requestId: `${fixtureName}-${commandType}`, document: wire });
        if (response.type !== 'RESULT' || !response.bytes) throw new Error('worker save failed');
        const reparsed = await parseDirect(response.bytes);
        expect(reparsed.xref.trailerDict.has('Encrypt')).toBe(true);
        const reopened = await securityEngine.open(reparsed, password);
        let text = '';
        for (const object of reopened.doc.objects.values()) {
          if (object instanceof PDFStream) text += new TextDecoder().decode(object.getBytes());
        }
        expect(text).toContain('Hello encrypted');
        expect(new TextDecoder().decode(response.bytes)).not.toContain('Hello encrypted');

        const outputPath = join(tmpdir(), `bloom-worker-${fixtureName}-${commandType}.pdf`);
        writeFileSync(outputPath, response.bytes);
        try {
          const qpdf = spawnSync('qpdf', [`--password=${password}`, '--check', outputPath], { encoding: 'utf8' });
          if ((qpdf.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            console.info('SKIP qpdf assertion: qpdf is not installed');
          } else {
            expect(qpdf.status).toBe(0);
            expect(`${qpdf.stdout}${qpdf.stderr}`).not.toMatch(/WARNING|ERROR/);
          }
        } finally {
          unlinkSync(outputPath);
        }
      }, 30000);
    }
  }
});
