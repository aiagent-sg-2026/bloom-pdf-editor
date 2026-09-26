/**
 * Editor session store — shared document/tool/selection state.
 */

import { create } from 'zustand';
import type { PDFDocumentData, TextLine, EditableObject, AcroFormWidget } from '@/engine/browser-core';
import type { EditorTool } from '../types';

export type SaveModeUI = 'quick' | 'optimized';

interface EditorSessionState {
  doc: PDFDocumentData | null;
  fileName: string;
  currentPage: number;
  totalPages: number;
  scale: number;
  activeTool: EditorTool;
  selectedLine: TextLine | null;
  selectedObject: EditableObject | null;
  selectedFormField: AcroFormWidget | null;
  isDirty: boolean;
  saveMode: SaveModeUI;
  canUndo: boolean;
  canRedo: boolean;

  setDoc: (doc: PDFDocumentData | null) => void;
  setFileName: (name: string) => void;
  setCurrentPage: (page: number) => void;
  setTotalPages: (n: number) => void;
  setScale: (scale: number) => void;
  setActiveTool: (tool: EditorTool) => void;
  setSelectedLine: (line: TextLine | null) => void;
  setSelectedObject: (obj: EditableObject | null) => void;
  setSelectedFormField: (field: AcroFormWidget | null) => void;
  setDirty: (dirty: boolean) => void;
  setSaveMode: (mode: SaveModeUI) => void;
  setCanUndo: (v: boolean) => void;
  setCanRedo: (v: boolean) => void;
  resetSelection: () => void;
}

export const useEditorSession = create<EditorSessionState>((set) => ({
  doc: null,
  fileName: '',
  currentPage: 0,
  totalPages: 0,
  scale: 1,
  activeTool: 'text',
  selectedLine: null,
  selectedObject: null,
  selectedFormField: null,
  isDirty: false,
  saveMode: 'optimized',
  canUndo: false,
  canRedo: false,

  setDoc: (doc) => set({ doc }),
  setFileName: (fileName) => set({ fileName }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setTotalPages: (totalPages) => set({ totalPages }),
  setScale: (scale) => set({ scale }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setSelectedLine: (selectedLine) => set({ selectedLine }),
  setSelectedObject: (selectedObject) => set({ selectedObject }),
  setSelectedFormField: (selectedFormField) => set({ selectedFormField }),
  setDirty: (isDirty) => set({ isDirty }),
  setSaveMode: (saveMode) => set({ saveMode }),
  setCanUndo: (canUndo) => set({ canUndo }),
  setCanRedo: (canRedo) => set({ canRedo }),
  resetSelection: () => set({
    selectedLine: null,
    selectedObject: null,
    selectedFormField: null,
  }),
}));
