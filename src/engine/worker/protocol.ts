import type { WireDocument } from './codec';

export type WorkerCommand =
  | { type: 'PARSE_PDF'; requestId: string; bytes: Uint8Array; options?: { deferEncryptedFilters?: boolean } }
  | { type: 'SAVE_PDF'; requestId: string; document: WireDocument; modifiedKeys?: string[]; newObjectKeys?: string[] }
  | { type: 'OPTIMIZE_PDF'; requestId: string; document: WireDocument };

export type WorkerResponse =
  | { type: 'RESULT'; requestId: string; document?: WireDocument; bytes?: Uint8Array; rawBytesAdvanced?: boolean }
  | { type: 'ERROR'; requestId: string; error: { name: string; message: string; stack?: string } };
