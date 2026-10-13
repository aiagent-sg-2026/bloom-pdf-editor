import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { securityEngine } from '../security';
import { PDFStream } from '../types';

const fixtureDir = join(__dirname, 'fixtures', 'encrypted');
const fixtures = [
  ['aes-256-r6.pdf', 'userpass'],
  ['aes-128-r4.pdf', 'userpass'],
  ['rc4-128-r3.pdf', 'userpass'],
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
      const saved = await serializeDocument(opened.doc);
      expect(saved.length).toBeGreaterThan(0);
    }, 30000);
  }
});
