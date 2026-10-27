// Generated drawings and invented text only. Never use customer documents or personal data.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { default: UPNG } = require('@pdf-lib/upng');

const output = new URL('./generated/', import.meta.url);
await mkdir(output, { recursive: true });
async function save(name, document) {
  document.setTitle('Synthetic E2E fixture');
  document.setCreator('Paperloom synthetic fixture generator');
  document.setProducer('Paperloom synthetic fixture generator');
  document.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  document.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  await writeFile(new URL(name, output), await document.save({ useObjectStreams: false }));
}

const letter = await PDFDocument.create();
const font = await letter.embedFont(StandardFonts.Helvetica);
for (const text of ['Synthetic sample', 'Second synthetic page']) {
  const page = letter.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 24, font });
}
await save('letter.pdf', letter);

const imageDoc = await PDFDocument.create();
const imagePage = imageDoc.addPage([612, 792]);
imagePage.drawText('Synthetic image', { x: 72, y: 700, size: 24 });
const width = 60, height = 40;
const pixels = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels.set(x < width / 2 ? [25, 100, 210, 255] : [240, 140, 30, 255], offset);
  }
}
const png = UPNG.encode([pixels.buffer], width, height, 0);
const image = await imageDoc.embedPng(png);
imagePage.drawImage(image, { x: 150, y: 400, width: 180, height: 120 });
await save('image.pdf', imageDoc);

const formDoc = await PDFDocument.create();
const formPage = formDoc.addPage([612, 792]);
const formFont = await formDoc.embedFont(StandardFonts.Helvetica);
formPage.drawText('Synthetic form', { x: 72, y: 700, size: 24, font: formFont });
const field = formDoc.getForm().createTextField('synthetic_note');
field.setText('Draft');
field.addToPage(formPage, {
  x: 72, y: 600, width: 260, height: 32,
  font: formFont, textColor: rgb(0, 0, 0), borderWidth: 1,
});
formDoc.getForm().updateFieldAppearances(formFont);
await save('form.pdf', formDoc);
console.log(`Created three synthetic PDF fixtures in ${fileURLToPath(output)}`);
