import {
  PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber,
  PDFRef, PDFStream, PDFString,
  type PDFDocumentData, type PDFObject, type PDFPageInfo, type PDFRectangle,
  type XRefEntry,
} from '../types';

export type WireBytes = Uint8Array;
export type WireNode =
  | { id: number; kind: 'boolean'; value: boolean }
  | { id: number; kind: 'number'; value: number }
  | { id: number; kind: 'string'; value: string }
  | { id: number; kind: 'hex'; value: string }
  | { id: number; kind: 'name'; value: string }
  | { id: number; kind: 'null' }
  | { id: number; kind: 'ref'; objNum: number; genNum: number }
  | { id: number; kind: 'array'; items: number[] }
  | { id: number; kind: 'dict'; entries: [string, number][] }
  | { id: number; kind: 'stream'; dict: number; rawBytes: WireBytes; decodedBytes: WireBytes | null };

export interface WireDocument {
  version: string;
  nodes: WireNode[];
  objects: [string, number][];
  xref: { entries: [string, XRefEntry][]; trailerDict: number };
  catalog: number;
  pages: Array<{ index: number; dict: number; mediaBox: PDFRectangle; cropBox: PDFRectangle; rotate: number; ref: number; resources: number; contentRefs: number[] }>;
  info: PDFDocumentData['info'];
  rawBytes: WireBytes | null;
}

export interface DehydrateOptions { includeRawBytes?: boolean }

export function dehydrateDocument(doc: PDFDocumentData, options: DehydrateOptions = {}): WireDocument {
  const nodes: WireNode[] = [];
  const ids = new Map<object, number>();
  const visit = (value: PDFObject): number => {
    const existing = ids.get(value as object);
    if (existing !== undefined) return existing;
    const id = nodes.length + 1;
    ids.set(value as object, id);
    // Reserve the slot before visiting children so cyclic graphs are safe.
    nodes.push({ id, kind: 'null' });
    let node: WireNode;
    if (value instanceof PDFNull) node = { id, kind: 'null' };
    else if (value instanceof PDFBoolean) node = { id, kind: 'boolean', value: value.value };
    else if (value instanceof PDFNumber) node = { id, kind: 'number', value: value.value };
    else if (value instanceof PDFString) node = { id, kind: 'string', value: value.value };
    else if (value instanceof PDFHexString) node = { id, kind: 'hex', value: value.hex };
    else if (value instanceof PDFName) node = { id, kind: 'name', value: value.name };
    else if (value instanceof PDFRef) node = { id, kind: 'ref', objNum: value.objNum, genNum: value.genNum };
    else if (value instanceof PDFArray) node = { id, kind: 'array', items: value.items.map(visit) };
    else if (value instanceof PDFDict) node = { id, kind: 'dict', entries: Array.from(value.entries(), ([key, item]) => [key, visit(item)]) };
    else if (value instanceof PDFStream) node = { id, kind: 'stream', dict: visit(value.dict), rawBytes: value.rawBytes.slice(), decodedBytes: value.decodedBytes ? value.decodedBytes.slice() : null };
    else throw new Error(`Unsupported PDF object in worker codec: ${(value as { constructor?: { name?: string } })?.constructor?.name ?? typeof value}`);
    nodes[id - 1] = node;
    return id;
  };
  const rawBytes = options.includeRawBytes === false ? null : doc.rawBytes.slice();
  return {
    version: doc.version,
    nodes,
    objects: Array.from(doc.objects, ([key, value]) => [key, visit(value)]),
    xref: { entries: Array.from(doc.xref.entries, ([key, entry]) => [key, { ...entry }]), trailerDict: visit(doc.xref.trailerDict) },
    catalog: visit(doc.catalog),
    pages: doc.pages.map((page) => ({ index: page.index, dict: visit(page.dict), mediaBox: { ...page.mediaBox }, cropBox: { ...page.cropBox }, rotate: page.rotate, ref: visit(page.ref), resources: visit(page.resources), contentRefs: page.contentRefs.map(visit) })),
    info: { ...doc.info },
    rawBytes,
  };
}

export function hydrateDocument(wire: WireDocument, rawBytes?: Uint8Array): PDFDocumentData {
  const byId = new Map<number, PDFObject>();
  // Allocate non-stream shells first so streams can retain the canonical dict.
  for (const node of wire.nodes) {
    let value: PDFObject | undefined;
    switch (node.kind) {
      case 'boolean': value = new PDFBoolean(node.value); break;
      case 'number': value = new PDFNumber(node.value); break;
      case 'string': value = new PDFString(node.value); break;
      case 'hex': value = new PDFHexString(node.value); break;
      case 'name': value = new PDFName(node.value); break;
      case 'null': value = PDFNull.instance; break;
      case 'ref': value = new PDFRef(node.objNum, node.genNum); break;
      case 'array': value = new PDFArray(); break;
      case 'dict': value = new PDFDict(); break;
    }
    if (value) byId.set(node.id, value);
  }
  const get = (id: number): PDFObject => {
    const value = byId.get(id);
    if (!value) throw new Error(`Invalid worker codec node ${id}`);
    return value;
  };
  for (const node of wire.nodes) {
    if (node.kind === 'stream') byId.set(node.id, new PDFStream(get(node.dict) as PDFDict, node.rawBytes.slice(), node.decodedBytes?.slice() ?? null));
  }
  for (const node of wire.nodes) {
    const value = get(node.id);
    if (node.kind === 'array') (value as PDFArray).items.push(...node.items.map(get));
    else if (node.kind === 'dict') for (const [key, id] of node.entries) (value as PDFDict).set(key, get(id));
  }
  const doc: PDFDocumentData = {
    version: wire.version,
    objects: new Map(wire.objects.map(([key, id]) => [key, get(id)])),
    xref: { entries: new Map(wire.xref.entries.map(([key, entry]) => [key, { ...entry }])), trailerDict: get(wire.xref.trailerDict) as PDFDict },
    catalog: get(wire.catalog) as PDFDict,
    pages: wire.pages.map((page): PDFPageInfo => ({ ...page, dict: get(page.dict) as PDFDict, ref: get(page.ref) as PDFRef, resources: get(page.resources) as PDFDict, contentRefs: page.contentRefs.map((id) => get(id) as PDFRef) })),
    info: { ...wire.info },
    rawBytes: rawBytes !== undefined ? rawBytes : wire.rawBytes?.slice() ?? new Uint8Array(),
  };
  return doc;
}

export function collectTransferBuffers(wire: WireDocument): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const node of wire.nodes) {
    if (node.kind === 'stream') { buffers.push(node.rawBytes.buffer as ArrayBuffer); if (node.decodedBytes) buffers.push(node.decodedBytes.buffer as ArrayBuffer); }
  }
  if (wire.rawBytes) buffers.push(wire.rawBytes.buffer as ArrayBuffer);
  return buffers;
}

export function extractNewObjects(doc: PDFDocumentData, keys: string[]): Map<string, PDFObject> {
  return new Map(keys.map((key) => {
    const value = doc.objects.get(key);
    if (!value) throw new Error(`Missing new object ${key}`);
    return [key, value] as const;
  }));
}
