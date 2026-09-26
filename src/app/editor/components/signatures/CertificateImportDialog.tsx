'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Upload, KeyRound, Trash2, Check } from 'lucide-react';
import {
  getCertificateManager,
  formatCertificateSummary,
  type ManagedIdentity,
} from '@/engine/browser-core';

interface CertificateImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after import / selection / remove so the parent can refresh. */
  onChange?: (identities: ManagedIdentity[]) => void;
}

export function CertificateImportDialog({
  open,
  onOpenChange,
  onChange,
}: CertificateImportDialogProps) {
  const [identities, setIdentities] = useState<ManagedIdentity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [pemPaste, setPemPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const mgr = getCertificateManager();
    const list = mgr.list();
    setIdentities(list);
    setSelectedId(mgr.getSelected()?.id ?? null);
    onChange?.(list);
  }, [onChange]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPassword('');
    setPemPaste('');
    // Hydrate may be async on first open
    const t = window.setTimeout(refresh, 50);
    return () => window.clearTimeout(t);
  }, [open, refresh]);

  const select = (id: string) => {
    getCertificateManager().select(id);
    setSelectedId(id);
    onChange?.(getCertificateManager().list());
  };

  const remove = (id: string) => {
    getCertificateManager().remove(id);
    refresh();
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const identity = await getCertificateManager().importFile(file, password);
      setSelectedId(identity.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importPem = async () => {
    if (!pemPaste.trim()) {
      setError('Paste a PEM certificate and/or private key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identity = await getCertificateManager().importPem(pemPaste.trim());
      setSelectedId(identity.id);
      setPemPaste('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[min(520px,94vw)] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/80">
            <Dialog.Title className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <KeyRound size={16} /> Certificates
            </Dialog.Title>
            <Dialog.Close className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="p-4 space-y-4 overflow-y-auto flex-1">
            <p className="text-[11px] text-zinc-500">
              Import PEM, DER, or P12/PFX. Private keys stay in memory for this session only.
              Encrypted P12 files may need conversion:{' '}
              <code className="text-zinc-400">openssl pkcs12 -nodes</code>
            </p>

            <div className="space-y-2">
              <label className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                Import file
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".pem,.crt,.cer,.der,.p12,.pfx,.key"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = '';
                }}
              />
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="P12/PFX password (if any)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-zinc-500"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#E8607A] hover:bg-[#D94D6A] disabled:opacity-50 text-white text-xs font-semibold"
                >
                  <Upload size={14} /> Browse
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                Or paste PEM
              </label>
              <textarea
                value={pemPaste}
                onChange={(e) => setPemPaste(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----BEGIN PRIVATE KEY-----&#10;..."
                rows={5}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-zinc-500 resize-y"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void importPem()}
                className="w-full py-1.5 rounded-md bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-semibold"
              >
                Import PEM
              </button>
            </div>

            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                Available identities
              </div>
              {identities.length === 0 && (
                <p className="text-[11px] text-zinc-500">No certificates imported yet.</p>
              )}
              {identities.map((id) => {
                const active = selectedId === id.id;
                const summary = id.leaf
                  ? formatCertificateSummary(id.leaf)
                  : id.label;
                return (
                  <div
                    key={id.id}
                    className={`rounded-lg border p-2.5 cursor-pointer transition-colors ${
                      active
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-zinc-700 hover:border-zinc-500 bg-zinc-800/40'
                    }`}
                    onClick={() => select(id.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-zinc-100 truncate flex items-center gap-1.5">
                          {active && <Check size={12} className="text-emerald-400 shrink-0" />}
                          {id.label}
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{summary}</div>
                        <div className="text-[10px] text-zinc-600 mt-1">
                          {id.source.toUpperCase()}
                          {id.hasPrivateKey ? ' · key loaded' : ' · cert only (re-import key to sign)'}
                          {id.certificates.length > 1 ? ` · chain ${id.certificates.length}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        title="Remove"
                        className="p-1 rounded text-zinc-500 hover:text-red-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(id.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-3 border-t border-zinc-700/80 flex justify-end">
            <Dialog.Close className="px-4 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
