/**
 * Coordinate Transformation Utilities
 * 
 * Converts between PDF coordinate space and canvas coordinate space.
 * 
 * PDF Coordinate System:
 * - Origin at bottom-left corner
 * - Y-axis points upward
 * - Units in points (1/72 inch)
 * 
 * Canvas Coordinate System:
 * - Origin at top-left corner
 * - Y-axis points downward
 * - Units in pixels
 * 
 * The transformation must account for:
 * - Y-axis inversion (PDF bottom-up → Canvas top-down)
 * - Scaling (zoom level)
 * - Rotation (page rotation: 0°, 90°, 180°, 270°)
 * - Translation (viewport offset)
 */

export interface Point {
  x: number;
  y: number;
}

export interface ViewportTransform {
  /** Zoom scale factor (1.0 = 100%) */
  scale: number;
  /** Page rotation in degrees (0, 90, 180, 270) */
  rotation: number;
  /** Page dimensions in PDF points */
  pageWidth: number;
  pageHeight: number;
  /** Visible page origin (CropBox lower-left), defaulting to 0,0. */
  pageX?: number;
  pageY?: number;
  /** Canvas viewport offset (for scroll position) */
  offsetX?: number;
  offsetY?: number;
}

/**
 * Convert PDF coordinates to canvas coordinates.
 * 
 * @param pdfX - X coordinate in PDF space (origin at bottom-left)
 * @param pdfY - Y coordinate in PDF space (origin at bottom-left)
 * @param transform - Viewport transformation parameters
 * @returns Point in canvas coordinate space (origin at top-left)
 * 
 * @example
 * // Basic transformation with scale only
 * const canvas = pdfToCanvas(100, 200, { scale: 2.0, rotation: 0, pageWidth: 612, pageHeight: 792 });
 * // canvas = { x: 200, y: 1184 } (scaled and Y-inverted)
 */
export function pdfToCanvas(
  pdfX: number,
  pdfY: number,
  transform: ViewportTransform
): Point {
  const { scale, rotation, pageWidth, pageHeight, pageX = 0, pageY = 0, offsetX = 0, offsetY = 0 } = transform;
  const x = pdfX - pageX;
  const y = pdfY - pageY;

  let canvasX: number;
  let canvasY: number;

  // Apply rotation first, then scale and translate
  switch (rotation) {
    case 0:
      // No rotation: standard Y-axis flip
      canvasX = x * scale;
      canvasY = (pageHeight - y) * scale;
      break;

    case 90:
      // 90° clockwise: swap axes and adjust
      canvasX = y * scale;
      canvasY = x * scale;
      break;

    case 180:
      // 180° rotation: flip both axes
      canvasX = (pageWidth - x) * scale;
      canvasY = y * scale;
      break;

    case 270:
      // 270° clockwise (or 90° counter-clockwise)
      canvasX = (pageHeight - y) * scale;
      canvasY = (pageWidth - x) * scale;
      break;

    default:
      // Fallback to no rotation for unsupported angles
      canvasX = x * scale;
      canvasY = (pageHeight - y) * scale;
      break;
  }

  // Apply viewport offset (for scroll position)
  canvasX += offsetX;
  canvasY += offsetY;

  return { x: canvasX, y: canvasY };
}

/**
 * Convert canvas coordinates to PDF coordinates.
 * 
 * @param canvasX - X coordinate in canvas space (origin at top-left)
 * @param canvasY - Y coordinate in canvas space (origin at top-left)
 * @param transform - Viewport transformation parameters
 * @returns Point in PDF coordinate space (origin at bottom-left)
 * 
 * @example
 * // Convert click position to PDF coordinates
 * const pdf = canvasToPdf(200, 1184, { scale: 2.0, rotation: 0, pageWidth: 612, pageHeight: 792 });
 * // pdf = { x: 100, y: 200 }
 */
export function canvasToPdf(
  canvasX: number,
  canvasY: number,
  transform: ViewportTransform
): Point {
  const { scale, rotation, pageWidth, pageHeight, pageX = 0, pageY = 0, offsetX = 0, offsetY = 0 } = transform;

  // Remove viewport offset first
  const adjustedX = canvasX - offsetX;
  const adjustedY = canvasY - offsetY;

  let pdfX: number;
  let pdfY: number;

  // Reverse the rotation transformation
  switch (rotation) {
    case 0:
      // No rotation: reverse Y-axis flip and scale
      pdfX = pageX + adjustedX / scale;
      pdfY = pageY + pageHeight - adjustedY / scale;
      break;

    case 90:
      // Reverse 90° clockwise rotation
      pdfX = pageX + adjustedY / scale;
      pdfY = pageY + adjustedX / scale;
      break;

    case 180:
      // Reverse 180° rotation
      pdfX = pageX + pageWidth - adjustedX / scale;
      pdfY = pageY + adjustedY / scale;
      break;

    case 270:
      // Reverse 270° clockwise rotation
      pdfX = pageX + pageWidth - adjustedY / scale;
      pdfY = pageY + pageHeight - adjustedX / scale;
      break;

    default:
      // Fallback to no rotation
      pdfX = pageX + adjustedX / scale;
      pdfY = pageY + pageHeight - adjustedY / scale;
      break;
  }

  return { x: pdfX, y: pdfY };
}

/**
 * Create a default viewport transform with common parameters.
 * 
 * @param pageWidth - Page width in PDF points
 * @param pageHeight - Page height in PDF points
 * @param scale - Optional scale factor (default: 1.0)
 * @param rotation - Optional rotation in degrees (default: 0)
 * @returns ViewportTransform object
 */
export function createViewportTransform(
  pageWidth: number,
  pageHeight: number,
  scale: number = 1.0,
  rotation: number = 0
): ViewportTransform {
  return {
    scale,
    rotation,
    pageWidth,
    pageHeight,
    offsetX: 0,
    offsetY: 0,
  };
}

/** Intersect the CropBox with the MediaBox, as required for page viewports. */
export function intersectPageBox(mediaBox: { x: number; y: number; width: number; height: number }, cropBox?: { x: number; y: number; width: number; height: number }) {
  if (!cropBox) return { ...mediaBox };
  const x = Math.max(mediaBox.x, cropBox.x);
  const y = Math.max(mediaBox.y, cropBox.y);
  const right = Math.min(mediaBox.x + mediaBox.width, cropBox.x + cropBox.width);
  const top = Math.min(mediaBox.y + mediaBox.height, cropBox.y + cropBox.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, top - y) };
}
