'use client';

import { useState, useCallback, FormEvent } from 'react';
import { Lock, Loader2 } from 'lucide-react';

interface PasswordDialogProps {
  fileName?: string;
  error?: string | null;
  isVerifying?: boolean;
  onSubmit: (password: string) => void;
  onCancel?: () => void;
}

/**
 * Prompt for PDF open password (Security Engine Phase 3 UI).
 */
export function PasswordDialog({
  fileName,
  error,
  isVerifying,
  onSubmit,
  onCancel,
}: PasswordDialogProps) {
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      onSubmit(password);
    },
    [onSubmit, password],
  );

  // Z_LAYERS.modalBackdrop (500) / modal (600); the form is a flex item.
  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <form
        onSubmit={handleSubmit}
        className="z-[600] w-full max-w-sm rounded-2xl border border-app bg-panel p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-xl bg-bloom-100 p-2.5 text-accent">
            <Lock size={20} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-app">Password required</h2>
            <p className="text-xs text-app-muted">
              {fileName ? `"${fileName}" is encrypted` : 'This PDF is encrypted'}
            </p>
          </div>
        </div>

        <label className="mb-1 block text-xs font-medium text-app-muted" htmlFor="pdf-password">
          Document password
        </label>
        <input
          id="pdf-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-3 w-full rounded-xl border border-app bg-panel-elevated px-3 py-2 text-sm text-app outline-none focus:border-accent"
          placeholder="Enter password"
          disabled={isVerifying}
        />

        {error && (
          <p className="mb-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isVerifying}
              className="rounded-xl px-3 py-1.5 text-sm text-app-muted hover:bg-panel-elevated hover:text-app"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={isVerifying}
            className="inline-flex items-center gap-2 rounded-xl bg-bloom-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-bloom-600 disabled:opacity-60 shadow-md shadow-accent/20 transition-all"
          >
            {isVerifying ? <Loader2 size={14} className="animate-spin" /> : null}
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}
