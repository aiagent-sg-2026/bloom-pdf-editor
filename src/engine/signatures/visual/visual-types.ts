/**
 * Visual signature objects — editable appearances, independent of digital signing.
 *
 * Follows the same spatial model as floating images / watermarks:
 * page-local PDF user-space bbox + appearance reference.
 */

/** How the signature ink / image was produced. */
export type SignatureAppearanceType = 'drawn' | 'uploaded' | 'typed' | 'composite';

/**
 * Placed signature on a page.
 * Editor overlays share their id with a native Stamp or field appearance.
 */
export interface VisualSignature {
  id: string;
  pageIndex: number;
  /** PDF user-space lower-left X. */
  x: number;
  /** PDF user-space lower-left Y. */
  y: number;
  width: number;
  height: number;
  /** Degrees, counter-clockwise about center. */
  rotation: number;
  /** 0–1 */
  opacity: number;
  locked: boolean;
  appearanceType: SignatureAppearanceType;
  /** Id of library entry and/or appearance object. */
  appearanceId: string;
}

export type SignatureSourceKind = 'draw' | 'upload' | 'typed';

/** Stored reusable signature in the browser library. */
export interface SignatureLibraryEntry {
  id: string;
  name: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  source: SignatureSourceKind;
  /** PNG (or SVG) data URL — transparency preserved for PNG/SVG. */
  imageDataUrl: string;
  width: number;
  height: number;
  typedText?: string;
  typedFont?: string;
  typedColor?: string;
  typedFontSize?: number;
}

/** Point in drawing surface coordinates. */
export interface StrokePoint {
  x: number;
  y: number;
  /** Pointer pressure 0–1 when available. */
  pressure?: number;
  t?: number;
}

export interface Stroke {
  points: StrokePoint[];
  color: string;
  width: number;
}

export interface DrawEngineOptions {
  color?: string;
  width?: number;
  /** Minimum distance between recorded points (px). */
  minDistance?: number;
}

/** Appearance component visibility + style. */
export interface AppearanceTextComponent {
  visible: boolean;
  text: string;
  font: string;
  size: number;
  color: string;
}

export interface AppearanceImageComponent {
  visible: boolean;
  imageDataUrl?: string;
  width?: number;
  height?: number;
}

export interface AppearanceBackgroundComponent {
  visible: boolean;
  color: string;
  opacity: number;
}

export interface AppearanceBorderComponent {
  visible: boolean;
  color: string;
  width: number;
  style: 'solid' | 'dashed';
}

export interface SignatureAppearanceLayout {
  padding: number;
  alignment: 'left' | 'center' | 'right';
  gap: number;
}

/**
 * Reusable Acrobat-style signature appearance specification.
 * Generation is independent of page rendering.
 */
export interface SignatureAppearance {
  id: string;
  name: string;
  /** Optional built-in template id. */
  templateId?: string;
  background: AppearanceBackgroundComponent;
  border: AppearanceBorderComponent;
  logo: AppearanceImageComponent;
  signatureImage: AppearanceImageComponent;
  typedName: AppearanceTextComponent;
  date: AppearanceTextComponent;
  reason: AppearanceTextComponent;
  location: AppearanceTextComponent;
  contactInfo: AppearanceTextComponent;
  layout: SignatureAppearanceLayout;
}

export interface AppearanceRenderOptions {
  /** Output width in CSS/px (vector paths scaled to this). */
  width: number;
  height: number;
  /** Prefer SVG string when true; otherwise PNG data URL. */
  preferVector?: boolean;
}

export interface AppearanceRenderResult {
  /** PNG data URL when rasterized. */
  imageDataUrl: string;
  /** SVG markup when preferVector / vector path used. */
  svg?: string;
  width: number;
  height: number;
}

export const DEFAULT_SIGNATURE_SIZE = { width: 160, height: 60 };

export const TYPED_SIGNATURE_FONTS = [
  'Great Vibes, cursive',
  'Dancing Script, cursive',
  'Pacifico, cursive',
  'Caveat, cursive',
  'Segoe Script, cursive',
  'Georgia, serif',
  'Times New Roman, serif',
  'Brush Script MT, cursive',
] as const;
