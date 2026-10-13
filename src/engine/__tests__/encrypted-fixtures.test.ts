import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parsePDF } from '../parser/parser';
import { saveDocument } from '../writer/save-pipeline';
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

      const reparsed = await parsePDF(saved);
      expect(reparsed.xref.trailerDict.has('Encrypt')).toBe(false);
      expect(streamText(reparsed)).toContain('Hello encrypted');

      const outputPath = join(tmpdir(), `bloom-resaved-${name}`);
      writeFileSync(outputPath, saved);
      try {
        const qpdfResult = spawnSync('qpdf', ['--check', outputPath], {
          encoding: 'utf8',
        });
        expect(qpdfResult.status).toBe(0);
        expect(`${qpdfResult.stdout}${qpdfResult.stderr}`).not.toMatch(/WARNING|ERROR/);
      } finally {
        unlinkSync(outputPath);
      }
    }, 30000);
  }
});
