import type { PDFDocumentData } from '../types';
import type { SaveMode } from '../writer/save-pipeline';
import { saveOptimized, saveQuick } from '../worker/client';

export interface ExportOptions {
  mode: SaveMode;
  prepare?: () => Promise<void>;
  /** Return undefined when there is no pending edit; false cancels export. */
  commitPendingEdit?: () => Promise<boolean> | undefined;
  /** Flatten pending inputs and finish their content update before saving. */
  flatten?: () => Promise<void>;
}

export type ExportResult =
  | { status: 'success'; bytes: Uint8Array }
  | { status: 'cancelled' }
  | { status: 'error'; error: unknown };

/** Preserve the editor's prepare → edit → flatten → save ordering.
 * No clean-state commit or download is performed here. Already applied edits
 * retain the existing mutation semantics if a later step fails.
 */
export async function exportDocument(
  doc: PDFDocumentData,
  options: ExportOptions,
): Promise<ExportResult> {
  try {
    await options.prepare?.();
    const pendingEdit = options.commitPendingEdit?.();
    if (pendingEdit && !await pendingEdit) return { status: 'cancelled' };
    await options.flatten?.();
    const bytes = options.mode === 'quick'
      ? await saveQuick(doc)
      : await saveOptimized(doc);
    return { status: 'success', bytes };
  } catch (error) {
    return { status: 'error', error };
  }
}
