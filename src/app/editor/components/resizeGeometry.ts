export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

interface ResizeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeOptions {
  /** Pointer displacement in PDF units: positive y points upward. */
  dx: number;
  dy: number;
  minWidth: number;
  minHeight: number;
  free: boolean;
}

/** Resize a positive-size PDF box, keeping the opposite corner fixed. */
export function resizeCorner(
  origin: ResizeBox,
  corner: ResizeCorner,
  { dx, dy, minWidth, minHeight, free }: ResizeOptions,
): ResizeBox {
  const east = corner === 'ne' || corner === 'se';
  const north = corner === 'nw' || corner === 'ne';
  const dw = east ? dx : -dx;
  const dh = north ? dy : -dy;
  let width: number;
  let height: number;

  if (free) {
    width = Math.max(minWidth, origin.width + dw);
    height = Math.max(minHeight, origin.height + dh);
  } else {
    const relativeWidth = dw / origin.width;
    const relativeHeight = dh / origin.height;
    // Compare changes, not resulting scales: inward drags must also shrink.
    // A tie follows width, keeping mixed-direction diagonal drags deterministic.
    const change = Math.abs(relativeWidth) >= Math.abs(relativeHeight)
      ? relativeWidth
      : relativeHeight;
    const scale = Math.max(1 + change, minWidth / origin.width, minHeight / origin.height);
    width = origin.width * scale;
    height = origin.height * scale;
  }

  return {
    x: east ? origin.x : origin.x + origin.width - width,
    y: north ? origin.y : origin.y + origin.height - height,
    width,
    height,
  };
}
