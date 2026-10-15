import { EditTransaction } from './edit-transaction';

interface DocumentSnapshot {
  label: string;
  bytes: Uint8Array;
}

/** Byte ownership and post-edit snapshots, independent of rendering and React. */
export class DocumentSession {
  private snapshots: DocumentSnapshot[];
  private cursor = 0;
  private currentRevision = 0;
  private activeTransaction: EditTransaction | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly maxSnapshots = 50;

  constructor(bytes: Uint8Array) {
    this.snapshots = [{ label: 'initial', bytes: new Uint8Array(bytes) }];
  }

  getBytes(): Uint8Array {
    return new Uint8Array(this.snapshots[this.cursor].bytes);
  }

  get revision(): number {
    return this.currentRevision;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.snapshots.length - 1;
  }

  /** Optional bytes bridge edits that have not yet moved to transactions. */
  snapshot(label: string, bytes?: Uint8Array): void {
    if (this.activeTransaction) throw new Error('An edit transaction is already active');
    const next = bytes ? new Uint8Array(bytes) : this.snapshots[this.cursor].bytes;
    this.snapshots.length = this.cursor + 1;
    this.snapshots.push({ label, bytes: next });
    if (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
    this.cursor = this.snapshots.length - 1;
    this.notify();
  }

  undo(): Uint8Array | null {
    if (this.activeTransaction) throw new Error('An edit transaction is already active');
    if (!this.canUndo) return null;
    this.cursor--;
    this.notify();
    return this.getBytes();
  }

  redo(): Uint8Array | null {
    if (this.activeTransaction) throw new Error('An edit transaction is already active');
    if (!this.canRedo) return null;
    this.cursor++;
    this.notify();
    return this.getBytes();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  beginTransaction(label: string): EditTransaction {
    if (this.activeTransaction) throw new Error('An edit transaction is already active');
    const transaction = new EditTransaction(
      this.getBytes(),
      bytes => { this.snapshot(label, bytes); },
      () => { this.activeTransaction = null; },
    );
    this.activeTransaction = transaction;
    return transaction;
  }

  private notify(): void {
    this.currentRevision++;
    for (const listener of this.listeners) listener();
  }
}
