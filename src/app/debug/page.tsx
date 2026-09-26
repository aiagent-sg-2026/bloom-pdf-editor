'use client';

import { useState, useRef, useEffect } from 'react';
import type * as Engine from '@/engine';

/**
 * Lightweight PDF parse debugger.
 * PDF parsing debugging stays in the browser engine.
 */
export default function DebugPage() {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<typeof Engine | null>(null);

  useEffect(() => {
    import('@/engine').then((m) => {
      engineRef.current = m;
    });
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !engineRef.current) return;

    setLoading(true);
    setError(null);
    setSummary(null);

    try {
      const buffer = await file.arrayBuffer();
      const pdfBytes = new Uint8Array(buffer);
      const parsed = await engineRef.current.parsePDF(pdfBytes);
      setSummary(
        `Parsed ${file.name}: ${parsed.pages.length} page(s), PDF ${parsed.version}. ` +
          `Parsing and conversion-related PDF work runs in the browser engine.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto font-sans">
      <h1 className="text-3xl font-bold mb-4">PDF Parse Debugger</h1>
      <p className="mb-6 text-gray-600">
        Upload a PDF to verify the in-browser parser. PDF processing stays local to this browser.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={handleFileUpload}
        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-[#B83A57] hover:file:bg-blue-100 mb-8"
      />

      {loading && <div className="text-[#E8607A] animate-pulse">Processing PDF...</div>}
      {error && <div className="text-red-600 font-medium">Error: {error}</div>}
      {summary && <div className="text-emerald-700 font-medium">{summary}</div>}
    </div>
  );
}
