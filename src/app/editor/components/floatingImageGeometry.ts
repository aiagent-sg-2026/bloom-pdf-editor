export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function rectanglesIntersect(a: OverlayRect, b: OverlayRect): boolean {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top;
}

/** The small replace control lives above the image, away from the SE handle. */
export function floatingImageReplaceButtonRect(box: OverlayRect): OverlayRect {
  return {
    left: box.left + box.width - 32,
    top: box.top - 12,
    width: 20,
    height: 20,
  };
}

export function floatingImageSeHandleRect(box: OverlayRect): OverlayRect {
  return {
    left: box.left + box.width - 12,
    top: box.top + box.height - 12,
    width: 12,
    height: 12,
  };
}
