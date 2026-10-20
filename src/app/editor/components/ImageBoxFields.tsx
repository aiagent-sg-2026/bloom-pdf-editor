import { useEffect, useRef, useState } from 'react';
import { editImageBox, MIN_IMAGE_SIZE_PT, type ImageBox, type ImageBoxField } from './imageBoxEdit';

interface ImageBoxFieldsProps {
  box: ImageBox;
  page?: ImageBox;
  onCommit?: (box: ImageBox) => Promise<void> | void;
}

const ROWS = [
  { title: 'Position', fields: [['x', 'X (pt)'], ['y', 'Y (pt)']] },
  { title: 'Size', fields: [['width', 'W (pt)'], ['height', 'H (pt)']] },
] as const;

export function ImageBoxFields({ box, page, onCommit }: ImageBoxFieldsProps) {
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const [drafts, setDrafts] = useState<Partial<Record<ImageBoxField, string>>>({});
  const draftsRef = useRef(drafts);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    draftsRef.current = {};
    setDrafts({});
    setError('');
  }, [box]);

  function resetField(field: ImageBoxField) {
    const next = { ...draftsRef.current };
    delete next[field];
    draftsRef.current = next;
    setDrafts(next);
  }

  async function commitField(field: ImageBoxField) {
    const input = draftsRef.current[field];
    resetField(field);
    if (input === undefined || pendingRef.current || !onCommit) return;
    const next = editImageBox(box, field, input, lockAspectRatio, page);
    if (!next || (next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height)) return;

    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      await onCommit(next);
    } catch (err) {
      console.error('[Editor] Image box edit failed:', err);
      setError('Could not update the image. Please try again.');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <fieldset disabled={pending || !onCommit} className="space-y-2 disabled:opacity-60" aria-busy={pending}>
      <legend className="sr-only">Image position and size in PDF points</legend>
      {ROWS.map(({ title, fields }) => (
        <div key={title} className="bg-panel-elevated rounded-md px-3 py-2 border border-app space-y-2">
          <span className="text-app-faint">{title}</span>
          <div className="grid grid-cols-2 gap-2">
            {fields.map(([field, label]) => (
              <label key={field} className="min-w-0 space-y-1 block">
                <span className="text-app-faint text-[10px]">{label}</span>
                <input
                  type="number"
                  step="any"
                  min={field === 'width' || field === 'height' ? MIN_IMAGE_SIZE_PT : undefined}
                  value={drafts[field] ?? String(Number(box[field].toFixed(2)))}
                  onChange={(event) => {
                    const next = { ...draftsRef.current, [field]: event.target.value };
                    draftsRef.current = next;
                    setDrafts(next);
                  }}
                  onBlur={() => { void commitField(field); }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      resetField(field);
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-full min-w-0 bg-transparent text-app font-mono border border-app rounded px-2 py-1 focus:outline-none focus:border-accent"
                />
              </label>
            ))}
          </div>
        </div>
      ))}
      <label className="flex items-center gap-2 text-app-muted cursor-pointer">
        <input
          type="checkbox"
          checked={lockAspectRatio}
          onChange={(event) => setLockAspectRatio(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        Lock aspect ratio
      </label>
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </fieldset>
  );
}
