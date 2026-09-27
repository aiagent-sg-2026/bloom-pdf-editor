import { parsePDF as parseDirect } from '../parser/parser';
import { saveQuick as saveQuickDirect, saveOptimized as saveOptimizedDirect } from '../writer/save-pipeline';
import { dehydrateDocument, hydrateDocument, extractNewObjects } from './codec';
import type { WorkerCommand, WorkerResponse } from './protocol';

export async function handleWorkerCommand(command: WorkerCommand): Promise<WorkerResponse> {
  if (command.type === 'PARSE_PDF') {
    const doc = await parseDirect(command.bytes, command.options);
    return { type: 'RESULT', requestId: command.requestId, document: dehydrateDocument(doc, { includeRawBytes: false }) };
  }
  if (command.type === 'SAVE_PDF') {
    const doc = hydrateDocument(command.document);
    const before = doc.rawBytes;
    const newObjects = command.newObjectKeys ? extractNewObjects(doc, command.newObjectKeys) : undefined;
    const bytes = await saveQuickDirect(doc, command.modifiedKeys ? new Set(command.modifiedKeys) : undefined, newObjects);
    return { type: 'RESULT', requestId: command.requestId, bytes, rawBytesAdvanced: doc.rawBytes === bytes && doc.rawBytes !== before };
  }
  if (command.type === 'OPTIMIZE_PDF') {
    const doc = hydrateDocument(command.document);
    return { type: 'RESULT', requestId: command.requestId, bytes: await saveOptimizedDirect(doc) };
  }
  throw new Error(`Unknown PDF worker command: ${(command as { type?: unknown }).type ?? 'missing type'}`);
}
