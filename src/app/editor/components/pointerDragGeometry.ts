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
  inset = 10,
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
