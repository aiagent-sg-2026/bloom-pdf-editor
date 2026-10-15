'use client';

import { useCallback, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { savePdfToStorage } from '@/lib/pdfStorage';
import { isPdfFile } from '@/app/pdf-file-validation';
import { FileUp, Loader2, Sparkles } from 'lucide-react';
import { BRAND_BASE_PATH, BRAND_NAME } from '@/lib/brand';

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const handleFile = useCallback(async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      if (!isPdfFile(file.name, file.type, new Uint8Array(buffer))) {
        setError('Please select a valid PDF document.');
        return;
      }
      setIsLoading(true);
      setError(null);
      await savePdfToStorage(buffer, file.name);
      router.push('/editor');
    } catch (e) {
      setError(`Failed to load file: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setIsLoading(false);
    }
  }, [router]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center py-10 px-5 font-sans bg-surface text-app relative overflow-hidden">
      {/* Subtle Paperloom ambient glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-accent/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="flex flex-col items-center mb-8 z-10">
        <div className="flex items-center gap-3 mb-3">
          <Image
            src={`${BRAND_BASE_PATH}/brand/paperloom-mark.svg`}
            alt={BRAND_NAME}
            width={48}
            height={48}
            className="w-12 h-12 object-contain"
            priority
          />
          <h1 className="text-4xl font-extrabold tracking-tight text-app">
            {BRAND_NAME}
          </h1>
        </div>
        <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-bloom-100 border border-accent/20 text-accent text-xs font-semibold tracking-wide">
          <Sparkles size={13} />
          PDF Editor — Pure TypeScript Engine
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`w-full max-w-lg min-h-[260px] rounded-3xl flex flex-col items-center justify-center cursor-pointer transition-all duration-300 p-8 border-2 border-dashed relative z-10 backdrop-blur-sm ${
          isDragging 
            ? 'border-accent bg-bloom-100 scale-[1.02] shadow-xl shadow-accent/25'
            : 'border-app-strong bg-panel/70 hover:bg-panel-elevated hover:border-accent/50 hover:shadow-xl hover:shadow-accent/5'
        }`}
      >
        {isLoading ? (
          <>
            <Loader2 size={48} className="animate-spin text-accent mb-4" />
            <p className="text-sm font-medium text-app-muted animate-pulse">Loading PDF Document...</p>
          </>
        ) : (
          <>
            <div className={`p-4 rounded-2xl mb-4 transition-colors duration-300 ${isDragging ? 'bg-bloom-100 text-accent' : 'bg-panel-elevated text-accent'}`}>
              <FileUp size={40} />
            </div>
            <p className="text-base font-semibold text-app mb-1">
              Drop a PDF here or click to browse
            </p>
            <p className="text-xs text-app-faint font-medium">
              100% Client-Side Engine &bull; Private &bull; Fast
            </p>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={onFileSelect}
        className="hidden"
      />

      {error && (
        <p className="text-red-400 bg-red-400/10 border border-red-400/20 px-4 py-2.5 rounded-xl text-sm mt-6 max-w-lg text-center font-medium animate-in slide-in-from-bottom-2 fade-in z-10">
          {error}
        </p>
      )}
    </div>
  );
}
