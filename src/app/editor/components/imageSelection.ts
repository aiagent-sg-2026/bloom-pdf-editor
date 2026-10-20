import type { DisplayItem, ImageItem, PathItem } from '@/engine/browser-core';
import type { ImageBox } from './imageBoxEdit';

// Content-stream numbers are rounded when written back to the PDF.
const BOX_EPSILON = 0.0001;

function sameBox(left: ImageBox, right: ImageBox): boolean {
  return Math.abs(left.x - right.x) < BOX_EPSILON &&
    Math.abs(left.y - right.y) < BOX_EPSILON &&
    Math.abs(left.width - right.width) < BOX_EPSILON &&
    Math.abs(left.height - right.height) < BOX_EPSILON;
}

/** Reinterpreting a page creates new objects, not a new selection. */
export function sameImagePlacement(current: ImageItem | PathItem | null, target: ImageItem): boolean {
  return current?.type === 'image' && current.name === target.name &&
    current.sourceInstructionIndex === target.sourceInstructionIndex && sameBox(current, target);
}

/** Resolve fresh bounds, CTM and instruction metadata for one image placement. */
export function findImagePlacement(
  items: readonly DisplayItem[],
  target: ImageBox & { name: string; sourceInstructionIndex?: number },
): ImageItem | null {
  let match: ImageItem | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const candidate = items[i];
    if (candidate.type !== 'image' || candidate.name !== target.name || !sameBox(candidate, target)) continue;
    // Resizes append a placement. History/render refreshes can identify an
    // existing placement precisely, including coincident uses of one resource.
    if (candidate.sourceInstructionIndex === target.sourceInstructionIndex) return candidate;
    match ??= candidate;
  }
  return match;
}
