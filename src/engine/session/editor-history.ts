import type { EditorHistoryEntry } from '../editing/editor-history';
import type { PDFDocumentData } from '../types';
import type { SessionDocumentEditor } from './document-edit';

interface HistoryState {
  entry: EditorHistoryEntry;
  /** Export can append a text transaction to an existing toolbar boundary. */
  sessions?: SessionDocumentEditor[];
  replaced?: boolean;
  /** Appended export transactions do not upgrade a legacy entry's undo coverage. */
  legacyBefore?: boolean;
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
    this.states.push({ entry, sessions: session ? [session] : undefined });
    if (this.states.length > this.maxSize) this.states.shift();
    this.cursor = this.states.length - 1;
  }

  replace(entry: EditorHistoryEntry, preserveRedo = false, session?: SessionDocumentEditor): void {
    if (this.cursor < 0) this.push(entry, session);
    else {
      const state = this.states[this.cursor];
      this.states[this.cursor] = {
        ...state,
        entry,
        sessions: session ? [...(state.sessions ?? []), session] : state.sessions,
        replaced: true,
        legacyBefore: state.legacyBefore || (session !== undefined && !state.sessions?.length),
      };
    }
    if (!preserveRedo) this.states.length = this.cursor + 1;
  }

  peek(): EditorHistoryEntry | null {
    return this.states[this.cursor]?.entry ?? null;
  }

  canUndo(): boolean {
    if (this.restoring || this.cursor <= 0) return false;
    return this.states[this.cursor].sessions?.every(session => session.canUndo) ?? true;
  }

  canRedo(): boolean {
    if (this.restoring || this.cursor >= this.states.length - 1) return false;
    return this.states[this.cursor + 1].sessions?.every(session => session.canRedo) ?? true;
  }

  async undo(doc: PDFDocumentData): Promise<HistoryRestore | null> {
    if (!this.canUndo()) return null;
    this.restoring = true;
    try {
      const state = this.states[this.cursor];
      const restoredDocument = await this.restoreSessions(doc, state, 'undo');
      const target = this.states[this.cursor - 1];
      if (target.replaced && target.sessions?.length) {
        try {
          // A later session's before-bytes can predate export's baked text/fonts.
          await target.sessions[target.sessions.length - 1].restoreCurrent(doc);
        } catch (error) {
          await this.restoreSessions(doc, state, 'redo');
          throw error;
        }
      }
      this.cursor--;
      return { entry: target.entry, restoredDocument: restoredDocument && !state.legacyBefore && !target.replaced };
    } finally {
      this.restoring = false;
    }
  }

  async redo(doc: PDFDocumentData): Promise<HistoryRestore | null> {
    if (!this.canRedo()) return null;
    this.restoring = true;
    try {
      const state = this.states[this.cursor + 1];
      const restoredDocument = await this.restoreSessions(doc, state, 'redo');
      this.cursor++;
      // Export can replace a snapshot after baking overlays into native content.
      // Restore that legacy content on top of the session's resource revision.
      return { entry: state.entry, restoredDocument: restoredDocument && !state.replaced };
    } finally {
      this.restoring = false;
    }
  }

  private async restoreSessions(
    doc: PDFDocumentData,
    state: HistoryState,
    direction: 'undo' | 'redo',
  ): Promise<boolean> {
    const sessions = state.sessions;
    if (!sessions?.length) return false;
    const ordered = direction === 'undo' ? [...sessions].reverse() : sessions;
    let completed = 0;
    try {
      for (; completed < sessions.length; completed++) {
        if (!await ordered[completed][direction](doc)) throw new Error('Session history boundary is unavailable');
      }
      return true;
    } catch (error) {
      // A failed restore must not leave part of a combined toolbar step consumed.
      const reverse = direction === 'undo' ? 'redo' : 'undo';
      for (let offset = completed - 1; offset >= 0; offset--) await ordered[offset][reverse](doc);
      throw error;
    }
  }
}
