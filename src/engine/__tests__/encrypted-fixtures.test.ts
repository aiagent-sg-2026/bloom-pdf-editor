import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parsePDF } from '../parser/parser';
import { saveDocument, saveQuick } from '../writer/save-pipeline';
import { securityEngine } from '../security';
import { PDFStream } from '../types';

const fixtureDir = join(__dirname, 'fixtures', 'encrypted');
const fixtures = [
  ['aes-256-r6.pdf', 'userpass'],
  ['aes-128-r4.pdf', 'userpass'],
  ['rc4-128-r4.pdf', 'userpass'],
  ['rc4-40-empty-user-r2.pdf', ''],
] as const;

function streamText(doc: Awaited<ReturnType<typeof parsePDF>>): string {
  let text = '';
  for (const object of doc.objects.values()) {
    if (object instanceof PDFStream) {
      text += new TextDecoder().decode(object.getBytes());
    }
  }
  return text;
}

describe('qpdf encrypted fixtures', () => {
  for (const [name, password] of fixtures) {
    it(`opens ${name} with its user password and can be re-saved`, async () => {
      const parsed = await parsePDF(new Uint8Array(readFileSync(join(fixtureDir, name))));
      await expect(securityEngine.open(parsed, 'wrong-password')).rejects.toThrow(/password/i);
      const opened = await securityEngine.open(parsed, password);
      expect(streamText(opened.doc)).toContain('Hello encrypted');
      const saved = await saveDocument(opened.doc);
      expect(saved.length).toBeGreaterThan(0);

      expect(new TextDecoder().decode(saved)).toContain('/Encrypt');
      const reparsed = await parsePDF(saved);
      expect(reparsed.xref.trailerDict.has('Encrypt')).toBe(true);
      const reopened = await securityEngine.open(reparsed, password);
      expect(streamText(reopened.doc)).toContain('Hello encrypted');
      expect(new TextDecoder().decode(saved)).not.toContain('Hello encrypted');

      const outputPath = join(tmpdir(), `bloom-resaved-${name}`);
      writeFileSync(outputPath, saved);
      try {
        const qpdfArgs = password === ''
          ? ['--check', outputPath]
          : [`--password=${password}`, '--check', outputPath];
        const qpdfResult = spawnSync('qpdf', qpdfArgs, {
          encoding: 'utf8',
        });
        if ((qpdfResult.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          console.info('SKIP qpdf assertion: qpdf is not installed');
        } else {
          expect(qpdfResult.status).toBe(0);
          expect(`${qpdfResult.stdout}${qpdfResult.stderr}`).not.toMatch(/WARNING|ERROR/);
        }
      } finally {
        unlinkSync(outputPath);
      }
    }, 30000);
  }

  it('re-encrypts direct quick saves for every fixture cipher', async () => {
    for (const [name, password] of fixtures) {
      const source = new Uint8Array(readFileSync(join(fixtureDir, name)));
      const opened = await securityEngine.open(await parsePDF(source), password);
      const saved = await saveQuick(opened.doc, new Set(['3_0']));
      const reopened = await securityEngine.open(await parsePDF(saved), password);
      expect(reopened.doc.pages.length).toBe(opened.doc.pages.length);
      expect(new TextDecoder().decode(saved)).not.toContain('Hello encrypted');
    }
  }, 30000);
});
