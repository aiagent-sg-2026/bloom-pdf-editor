import { parsePDF as parseDirect, type ParsePDFOptions } from '../parser/parser';
import { saveQuick as saveQuickDirect, saveOptimized as saveOptimizedDirect, type SaveMode } from '../writer/save-pipeline';
import type { PDFDocumentData, PDFObject } from '../types';
import { collectTransferBuffers, dehydrateDocument, hydrateDocument } from './codec';
import type { WorkerCommand, WorkerResponse } from './protocol';
type WorkerRequest = WorkerCommand extends infer T ? T extends { requestId: string } ? Omit<T, 'requestId'> : never : never;

type Pending = { resolve: (value: WorkerResponse) => void; reject: (error: unknown) => void };
let worker: Worker | null = null;
let workerFailed = false;
let nextId = 0;
const pending = new Map<string, Pending>();

function getWorker(): Worker | null {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const item = pending.get(event.data.requestId);
      if (!item) return;
      pending.delete(event.data.requestId);
      if (event.data.type === 'ERROR') item.reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name, stack: event.data.error.stack }));
      else item.resolve(event.data);
    };
    worker.onerror = (event) => { const error = event.error ?? new Error(event.message); for (const item of pending.values()) item.reject(error); pending.clear(); worker?.terminate(); worker = null; workerFailed = true; };
    return worker;
  } catch { workerFailed = true; return null; }
}

async function request(command: WorkerRequest, transfer: Transferable[]): Promise<WorkerResponse> {
  const instance = getWorker();
  if (!instance) throw new Error('PDF worker unavailable');
  const requestId = `pdf-${++nextId}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try { instance.postMessage({ ...command, requestId }, transfer); }
    catch (error) { pending.delete(requestId); reject(error); }
  });
}

export async function parsePDF(data: Uint8Array, options?: ParsePDFOptions): Promise<PDFDocumentData> {
  const input = data.slice();
  try { const result = await request({ type: 'PARSE_PDF', bytes: input, options }, [input.buffer as ArrayBuffer]); if (result.type !== 'RESULT' || !result.document) throw new Error('Invalid PDF worker parse response'); return hydrateDocument(result.document, data); }
  catch { return parseDirect(data, options); }
}

export async function saveQuick(doc: PDFDocumentData, modifiedKeys?: Set<string>, newObjects?: Map<string, PDFObject>): Promise<Uint8Array> {
  const combinedObjects = new Map(doc.objects);
  if (newObjects) for (const [key, value] of newObjects) combinedObjects.set(key, value);
  const wire = dehydrateDocument({ ...doc, objects: combinedObjects });
  const newObjectKeys = newObjects ? Array.from(newObjects.keys()) : undefined;
  try {
    const result = await request({ type: 'SAVE_PDF', document: wire, modifiedKeys: modifiedKeys ? Array.from(modifiedKeys) : undefined, newObjectKeys }, collectTransferBuffers(wire));
    if (result.type !== 'RESULT' || !result.bytes) throw new Error('Invalid PDF worker save response');
    if (newObjects) for (const [key, value] of newObjects) doc.objects.set(key, value);
    if (result.rawBytesAdvanced) doc.rawBytes = result.bytes;
    return result.bytes;
  }
  catch { return saveQuickDirect(doc, modifiedKeys, newObjects); }
}

export async function saveOptimized(doc: PDFDocumentData): Promise<Uint8Array> {
  const wire = dehydrateDocument(doc);
  try { const result = await request({ type: 'OPTIMIZE_PDF', document: wire }, collectTransferBuffers(wire)); if (result.type !== 'RESULT' || !result.bytes) throw new Error('Invalid PDF worker optimize response'); return result.bytes; }
  catch { return saveOptimizedDirect(hydrateDocument(dehydrateDocument(doc))); }
}

export async function saveDocument(doc: PDFDocumentData, mode: SaveMode = 'optimized'): Promise<Uint8Array> { return mode === 'quick' ? saveQuick(doc) : saveOptimized(doc); }

export function resetPDFWorkerForTests(): void { worker?.terminate(); worker = null; workerFailed = false; pending.clear(); }
