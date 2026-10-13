import type { SignatureLibraryEntry, VisualSignature } from './visual-types';

export interface VisualSignatureImagePlacement {
  signatureId: string;
  pageIndex: number;
  imageDataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
}

/** Resolve a placed overlay to the immutable image placement used by export. */
export function visualSignatureToImagePlacement(signature: VisualSignature, entry: SignatureLibraryEntry | null | undefined): VisualSignatureImagePlacement | null {
  if (!entry?.imageDataUrl) return null;
  return { signatureId: signature.id, pageIndex: signature.pageIndex, imageDataUrl: entry.imageDataUrl, x: signature.x, y: signature.y, width: signature.width, height: signature.height, rotation: signature.rotation, opacity: signature.opacity };
}
