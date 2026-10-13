import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';

function classicPdf(startxrefOverride?: number): Uint8Array {
  const chunks = [
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const offsets = [0];
  let running = chunks[0].length;
  for (let i = 1; i < chunks.length; i++) {
    offsets.push(running);
    running += chunks[i].length;
  }
  const xref = `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${startxrefOverride ?? offset}\n%%EOF\n`;
  return new TextEncoder().encode(chunks.join('') + xref);
}

describe('PDF xref recovery', () => {
  it('recovers when startxref points at the wrong location', async () => {
    const doc = await parsePDF(classicPdf(12));
    expect(doc.pages).toHaveLength(1);
  });

  it('applies the PDF header offset to xref offsets after a junk prefix', async () => {
    const original = classicPdf();
    const prefix = new TextEncoder().encode('launcher junk\n');
    const prefixed = new Uint8Array(prefix.length + original.length);
    prefixed.set(prefix);
    prefixed.set(original, prefix.length);
    const doc = await parsePDF(prefixed);
    expect(doc.pages).toHaveLength(1);
  });

  it('reports empty and truncated data with a readable parse error', async () => {
    await expect(parsePDF(new Uint8Array())).rejects.toThrow(/Failed to parse PDF:/);
    await expect(parsePDF(classicPdf().slice(0, 80))).rejects.toThrow(/Failed to parse PDF:/);
  });
});
