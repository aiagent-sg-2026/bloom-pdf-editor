import { collectTransferBuffers } from './codec';
import { handleWorkerCommand } from './handler';
import type { WorkerCommand, WorkerResponse } from './protocol';

const send = (response: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(response, transfer);

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  try {
    const response = await handleWorkerCommand(command);
    const transfer = response.type === 'RESULT' ? (response.document ? collectTransferBuffers(response.document) : response.bytes ? [response.bytes.buffer as ArrayBuffer] : []) : [];
    send(response, transfer);
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    send({ type: 'ERROR', requestId: command.requestId, error: { name: e.name, message: e.message, stack: e.stack } });
  }
};
