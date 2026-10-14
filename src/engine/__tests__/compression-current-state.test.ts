import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { compressDocumentImages } from '../optimize/image-compress';
import { serializeDocumentCompact } from '../writer/serializer';

async function editedFixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  // Make the current page content larger than the tiny uploaded document.
  let seed = 123;
  const lines = ['q 1 0 0 rg 10 10 20 20 re f Q'];
  for (let i = 0; i < 500; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    lines.push(`% edited content ${seed}`);
  }
  const content = new TextEncoder().encode(lines.join('\n'));
  const ref = new PDFRef(20, 0);
  doc.objects.set(ref.toKey(), new PDFStream(
    new PDFDict([['Length', new PDFNumber(content.length)]]), content,
  ));
  doc.pages[0].dict.set('Contents', ref);
  doc.pages[0].contentRefs = [ref];
  return { doc, content };
}

describe('compression of the current document', () => {
  it('retains edited page content even when the upload is smaller than the output', async () => {
    const { doc, content } = await editedFixture();
    const baseline = await serializeDocumentCompact(doc);
    expect(baseline.length).toBeGreaterThan(doc.rawBytes.length);

    const result = await compressDocumentImages(doc, { quality: 0.7, dpi: 150 });
    const reopened = await parsePDF(result.bytes);
    const stream = reopened.objects.get(reopened.pages[0].contentRefs[0].toKey());
    expect(stream).toBeInstanceOf(PDFStream);
    expect((stream as PDFStream).getBytes()).toEqual(content);
  });
});
