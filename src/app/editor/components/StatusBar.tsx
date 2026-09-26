import React from 'react';
import type { EditorTool } from '../types';
import { TOOLS } from '../types';
import type { TextRun, RenderResult, PDFDocumentData } from '@/engine/browser-core';

interface StatusBarProps {
  renderResult: RenderResult | null;
  activeTool: EditorTool;
  selectedRun: TextRun | null;
  doc: PDFDocumentData | null;
  totalPages: number;
}

export function StatusBar({
  renderResult,
  activeTool,
  selectedRun,
  doc,
  totalPages
}: StatusBarProps) {
  return (
    <footer className="hidden md:flex items-center justify-between px-4 h-7 bg-panel border-t border-app shrink-0 select-none">
      <span className="text-[10px] font-medium tracking-wider text-app-faint">
        {renderResult
          ? `${renderResult.pageWidth.toFixed(0)} × ${renderResult.pageHeight.toFixed(0)} PT`
          : ''}
      </span>
      <span className="text-[10px] font-medium tracking-wider text-app-faint flex items-center gap-2">
        <span>TOOL: <span className="text-app">{TOOLS.find(t => t.id === activeTool)?.label.toUpperCase()}</span></span>
        {selectedRun && (
          <>
            <span className="w-1 h-1 rounded-full bg-[var(--border-strong)]" />
            <span>SELECTED: <span className="text-app">&quot;{selectedRun.text.substring(0, 30)}{selectedRun.text.length > 30 ? '…' : ''}&quot;</span></span>
          </>
        )}
      </span>
      <span className="text-[10px] font-medium tracking-wider text-app-faint">
        {renderResult ? `${renderResult.textLines.length} LINES` : ''}
        {doc ? ` • ${totalPages} PAGES • v${doc.version}` : ''}
      </span>
    </footer>
  );
}
