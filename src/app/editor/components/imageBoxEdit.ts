export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ImageBoxField = keyof ImageBox;

export const MIN_IMAGE_SIZE_PT = 8;

/** Returns null for rejected edits. Coordinates are PDF points, bottom-left origin. */
export function editImageBox(
  box: ImageBox,
  field: ImageBoxField,
  input: string,
  lockAspectRatio: boolean,
  page?: ImageBox,
): ImageBox | null {
  if (!input.trim()) return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;

  const next = { ...box, [field]: value };
  if (field === 'x' || field === 'y') {
    const extent = field === 'x' ? 'width' : 'height';
    if (page && Number.isFinite(page[field]) && Number.isFinite(page[extent]) && page[extent] > 0) {
      // Keep at least one point visible (or the entire page for a sub-point page).
      const overlap = Math.min(1, page[extent], box[extent]);
      const min = page[field] - box[extent] + overlap;
      const max = page[field] + page[extent] - overlap;
      next[field] = Math.max(min, Math.min(max, value));
    }
    return next;
  }

  if (value < MIN_IMAGE_SIZE_PT) return null;
  if (lockAspectRatio) {
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return null;
    const other = field === 'width' ? 'height' : 'width';
    const proportional = (value / box[field]) * box[other];
    if (!Number.isFinite(proportional) || proportional < MIN_IMAGE_SIZE_PT) return null;
    next[other] = Number(proportional.toFixed(2));
  }

  if (!Number.isFinite(next.width) || !Number.isFinite(next.height)
    || next.width < MIN_IMAGE_SIZE_PT || next.height < MIN_IMAGE_SIZE_PT) return null;
  return next;
}

export interface ImageBoxDraft {
  inputs: Partial<Record<ImageBoxField, string>>;
  box: ImageBox;
}

/** Preserve the last valid preview while allowing incomplete numeric input. */
export function previewImageBoxEdit(
  original: ImageBox,
  previous: ImageBoxDraft,
  field: ImageBoxField,
  input: string,
  lockAspectRatio: boolean,
  page?: ImageBox,
): ImageBoxDraft {
  const inputs = { ...previous.inputs, [field]: input };
  // Always use the original ratio, not the rounded proportional draft.
  const next = editImageBox(original, field, input, lockAspectRatio, page);
  if (!next) return { inputs, box: previous.box };
  if (lockAspectRatio && (field === 'width' || field === 'height')) {
    const other = field === 'width' ? 'height' : 'width';
    inputs[other] = String(next[other]);
  }
  return { inputs, box: next };
}
