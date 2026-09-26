/**
 * History (undo/redo) via TransactionStack.
 */

import { useCallback, useRef, useState } from 'react';
import { TransactionStack } from '@/engine/browser-core';
import type { PDFDocumentData } from '@/engine/browser-core';

export function useHistory() {
  const txStackRef = useRef(new TransactionStack());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoSnapshotRef = useRef<{ pageIndex: number; contentBytes: Uint8Array } | null>(null);

  const syncTxState = useCallback(() => {
    setCanUndo(txStackRef.current.canUndo());
    setCanRedo(txStackRef.current.canRedo());
  }, []);

  const pushSnapshot = useCallback((pageIndex: number, contentBytes: Uint8Array, label: string) => {
    txStackRef.current.push({
      pageIndex,
      contentBytes: new Uint8Array(contentBytes),
      label,
      timestamp: Date.now(),
    });
    syncTxState();
  }, [syncTxState]);

  const clear = useCallback(() => {
    txStackRef.current.clear();
    syncTxState();
  }, [syncTxState]);

  const undo = useCallback(async (
    doc: PDFDocumentData,
    engine: typeof import('@/engine/browser-core'),
    onRestored: (pageIndex: number) => void,
  ) => {
    const snap = txStackRef.current.undo();
    if (!snap) return;
    const page = doc.pages[snap.pageIndex];
    await engine.updatePageContent(page.contentRefs, snap.contentBytes, doc.objects);
    syncTxState();
    onRestored(snap.pageIndex);
  }, [syncTxState]);

  const redo = useCallback(async (
    doc: PDFDocumentData,
    engine: typeof import('@/engine/browser-core'),
    onRestored: (pageIndex: number) => void,
  ) => {
    const snap = txStackRef.current.redo();
    if (!snap) return;
    const page = doc.pages[snap.pageIndex];
    await engine.updatePageContent(page.contentRefs, snap.contentBytes, doc.objects);
    syncTxState();
    onRestored(snap.pageIndex);
  }, [syncTxState]);

  return {
    txStackRef,
    undoSnapshotRef,
    canUndo,
    canRedo,
    syncTxState,
    pushSnapshot,
    clear,
    undo,
    redo,
  };
}
