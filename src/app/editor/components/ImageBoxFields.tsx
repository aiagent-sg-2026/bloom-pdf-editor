import { useEffect, useRef, useState } from 'react';
import { previewImageBoxEdit, MIN_IMAGE_SIZE_PT, type ImageBox, type ImageBoxDraft } from './imageBoxEdit';

interface ImageBoxFieldsProps {
  box: ImageBox;
  page?: ImageBox;
  onCommit?: (box: ImageBox) => Promise<void> | void;
  onPreview?: (box: ImageBox | null) => void;
}

const ROWS = [
  { title: 'Position', fields: [['x', 'X (pt)'], ['y', 'Y (pt)']] },
  { title: 'Size', fields: [['width', 'W (pt)'], ['height', 'H (pt)']] },
] as const;

export function ImageBoxFields({ box, page, onCommit, onPreview }: ImageBoxFieldsProps) {
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const [draft, setDraft] = useState<ImageBoxDraft>({ inputs: {}, box });
  const draftRef = useRef(draft);
  const blurTimerRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    draftRef.current = { inputs: {}, box };
    setDraft(draftRef.current);
    setError('');
    return () => {
      window.clearTimeout(blurTimerRef.current);
      onPreview?.(null);
    };
  }, [box, onPreview]);

  function reset() {
    draftRef.current = { inputs: {}, box };
    setDraft(draftRef.current);
    onPreview?.(null);
  }

  async function commitField() {
    if (pendingRef.current || !onCommit) return;
    const next = draftRef.current.box;
    if (!Object.keys(draftRef.current.inputs).length) return;
    // Consume the edit before blur can submit it a second time.
    draftRef.current = { inputs: {}, box: next };
    if (next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height) {
      reset();
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      await onCommit(next);
    } catch (err) {
      console.error('[Editor] Image box edit failed:', err);
      setError('Could not update the image. Please try again.');
      reset();
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
                  value={draft.inputs[field] ?? String(Number(box[field].toFixed(2)))}
                  onChange={(event) => {
                    const next = previewImageBoxEdit(box, draftRef.current, field, event.target.value, lockAspectRatio, page);
                    draftRef.current = next;
                    setDraft(next);
                    onPreview?.(next.box);
                  }}
                  onBlur={() => {
                    // A selection/tool change must unmount or reset before a blur commits.
                    blurTimerRef.current = window.setTimeout(() => { void commitField(); }, 0);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitField();
                      event.currentTarget.blur();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      reset();
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
