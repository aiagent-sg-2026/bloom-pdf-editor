import { test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFTextField,
  decodePDFRawStream,
} from 'pdf-lib';

export function requirePoppler(...commands: string[]) {
  for (const command of commands) {
    const probe = spawnSync(command, ['-v']);
    if (probe.error && 'code' in probe.error && probe.error.code === 'ENOENT') {
      test.skip(true, `${command} is missing; install Poppler (poppler-utils) for exported PDF assertions.`);
    }
    if (probe.error) throw probe.error;
    if (probe.status !== 0) throw new Error(`${command} -v failed: ${probe.stderr.toString()}`);
  }
}

export function extractText(path: string, password?: string): string {
  requirePoppler('pdftotext');
  return execFileSync('pdftotext', [...(password ? ['-upw', password] : []), '-layout', path, '-'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
}

// Hash rendered pixels, not serialized PDF bytes (timestamps and revisions can differ).
export function renderedFingerprint(path: string): string {
  requirePoppler('pdftoppm');
  const pixels = execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', path], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return createHash('sha256').update(pixels).digest('hex');
}

type Matrix = [number, number, number, number, number, number];
export type ImageBox = { page: number; x: number; y: number; width: number; height: number };
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

// Read placement operators independently of the editor; follow Form XObjects too.
function imagePlacements(document: PDFDocument): ImageBox[] {
  const images: ImageBox[] = [];
  const context = document.context;
  function walk(stream: PDFRawStream, resources: PDFDict, initial: Matrix, page: number, ancestors: Set<PDFRawStream>) {
    if (ancestors.has(stream)) throw new Error('Cyclic Form XObject in exported PDF');
    const nextAncestors = new Set(ancestors).add(stream);
    const source = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    // Strings/comments are single tokens so operator-like text cannot become geometry.
    const tokens = source.match(/%[^\r\n]*|\((?:\\[\s\S]|[^\\()])*\)|<[\da-fA-F\s]*>|\/[^\s()[\]<>\/%]+|[-+]?(?:\d*\.\d+|\d+)|[^\s]+/g) ?? [];
    let matrix = initial;
    const stack: Matrix[] = [];
    let operands: string[] = [];
    for (const token of tokens) {
      if (token.startsWith('%')) continue;
      if (/^[-+]?(?:\d*\.\d+|\d+)$/.test(token) || token.startsWith('/')) {
        operands.push(token);
        continue;
      }
      if (token === 'q') stack.push(matrix);
      else if (token === 'Q') matrix = stack.pop() ?? initial;
      else if (token === 'cm' && operands.length >= 6) {
        matrix = multiply(matrix, operands.slice(-6).map(Number) as Matrix);
      } else if (token === 'Do') {
        const objects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
        const name = operands.at(-1);
        const object = name && objects?.lookup(PDFName.of(name.slice(1)));
        if (object instanceof PDFRawStream) {
          const subtype = object.dict.lookup(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
              matrix[0] * x + matrix[2] * y + matrix[4],
              matrix[1] * x + matrix[3] * y + matrix[5],
            ]);
            const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
            images.push({ page, x: Math.min(...xs), y: Math.min(...ys),
              width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
          } else if (subtype === PDFName.of('Form')) {
            const formMatrix = object.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
            const transform = formMatrix ? formMatrix.asArray().map(value => Number(value.toString())) as Matrix : identity;
            walk(object, object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources,
              multiply(matrix, transform), page, nextAncestors);
          }
        }
      }
      operands = [];
    }
  }
  document.getPages().forEach((page, index) => {
    const contents = page.node.Contents();
    const resources = page.node.Resources();
    if (!contents || !resources) return;
    const streams = contents instanceof PDFArray ? contents.asArray().map(item => context.lookup(item)) : [contents];
    // The exporter writes balanced graphics-state blocks in each content stream.
    for (const stream of streams) if (stream instanceof PDFRawStream) walk(stream, resources, identity, index, new Set());
  });
  return images;
}

export async function inspectPdf(path: string) {
  const document = await PDFDocument.load(await readFile(path));
  const fields: Record<string, string> = {};
  for (const field of document.getForm().getFields()) {
    if (field instanceof PDFTextField) fields[field.getName()] = field.getText() ?? '';
  }
  return {
    pages: document.getPages().map(page => ({ ...page.getSize(), rotation: page.getRotation().angle })),
    fields,
    images: imagePlacements(document),
  };
}
