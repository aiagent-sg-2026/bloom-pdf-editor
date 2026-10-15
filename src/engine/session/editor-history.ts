import type { EditorHistoryEntry } from '../editing/editor-history';
import type { PDFDocumentData } from '../types';
import type { SessionDocumentEditor } from './document-edit';

interface HistoryState {
  entry: EditorHistoryEntry;
  /** One isolated byte transaction per migrated boundary, never a second UI stack. */
  session?: SessionDocumentEditor;
  replaced?: boolean;
}

export interface HistoryRestore {
  entry: EditorHistoryEntry;
  restoredDocument: boolean;
}

/** Orders legacy snapshots and session boundaries without exposing internal checkpoints. */
export class SessionEditorHistory {
  private states: HistoryState[] = [];
  private cursor = -1;
  private restoring = false;

  constructor(private readonly maxSize = 50) {}

  seed(entry: EditorHistoryEntry): void {
    this.states = [{ entry }];
    this.cursor = 0;
  }

  push(entry: EditorHistoryEntry, session?: SessionDocumentEditor): void {
    this.states.length = this.cursor + 1;
    this.states.push({ entry, session });
    if (this.states.length > this.maxSize) this.states.shift();
    this.cursor = this.states.length - 1;
  }

  replace(entry: EditorHistoryEntry, preserveRedo = false): void {
    if (this.cursor < 0) this.push(entry);
    else this.states[this.cursor] = { ...this.states[this.cursor], entry, replaced: true };
    if (!preserveRedo) this.states.length = this.cursor + 1;
  }

  peek(): EditorHistoryEntry | null {
    return this.states[this.cursor]?.entry ?? null;
  }

  canUndo(): boolean {
    if (this.restoring || this.cursor <= 0) return false;
    return this.states[this.cursor].session?.canUndo ?? true;
  }

  canRedo(): boolean {
    if (this.restoring || this.cursor >= this.states.length - 1) return false;
    return this.states[this.cursor + 1].session?.canRedo ?? true;
  }

  async undo(doc: PDFDocumentData): Promise<HistoryRestore | null> {
    if (!this.canUndo()) return null;
    this.restoring = true;
    try {
      const state = this.states[this.cursor];
      const restoredDocument = state.session ? await state.session.undo(doc) : false;
      if (state.session && !restoredDocument) return null;
      this.cursor--;
      return { entry: this.states[this.cursor].entry, restoredDocument };
    } finally {
      this.restoring = false;
    }
  }

  async redo(doc: PDFDocumentData): Promise<HistoryRestore | null> {
    if (!this.canRedo()) return null;
    this.restoring = true;
    try {
      const state = this.states[this.cursor + 1];
      const restoredDocument = state.session ? await state.session.redo(doc) : false;
      if (state.session && !restoredDocument) return null;
      this.cursor++;
      // Export can replace a snapshot after baking overlays into native content.
      // Restore that legacy content on top of the session's resource revision.
      return { entry: state.entry, restoredDocument: restoredDocument && !state.replaced };
    } finally {
      this.restoring = false;
    }
  }
}
