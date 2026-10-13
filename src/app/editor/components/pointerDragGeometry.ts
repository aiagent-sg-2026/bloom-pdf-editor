export interface PointerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function isPointNearRectEdge(
  x: number,
  y: number,
  rect: PointerRect,
  inset = 14,
): boolean {
  return x >= rect.left - inset
    && x <= rect.right + inset
    && y >= rect.top - inset
    && y <= rect.bottom + inset
    && (
      x <= rect.left + inset
      || x >= rect.right - inset
      || y <= rect.top + inset
      || y >= rect.bottom - inset
    );
}

export function pointerDragDelta(
  start: { x: number; y: number },
  current: { x: number; y: number },
) {
  return { x: current.x - start.x, y: current.y - start.y };
}

/** Convert CSS-pixel pointer movement into the PDF coordinate system. */
export function floatingTextPdfDelta(
  start: { x: number; y: number },
  current: { x: number; y: number },
  scale: number,
) {
  const delta = pointerDragDelta(start, current);
  return { x: delta.x / scale, y: -delta.y / scale };
}

/** Keep touch/pen drags off the textarea while allowing the wrapper/handle to move. */
export function shouldStartFloatingTextDrag(
  pointerType: string,
  targetIsTextArea: boolean,
  targetIsDragHandle: boolean,
  targetIsInteractiveControl = false,
  point?: { x: number; y: number },
  wrapperRect?: PointerRect,
) {
  if (targetIsInteractiveControl) return false;
  if (pointerType === 'mouse') return !targetIsTextArea;
  return !targetIsTextArea
    || targetIsDragHandle
    || (point != null && wrapperRect != null && isPointNearRectEdge(point.x, point.y, wrapperRect));
}
