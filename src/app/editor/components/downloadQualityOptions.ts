export interface CompressedDownloadOptions {
  /** JPEG quality 0–1; null preserves image bytes and takes precedence over DPI/target size. */
  quality: number | null;
  /** Target image DPI; null disables downsampling and page rasterization. */
  dpi: number | null;
  /** Optional max file size in bytes — searches quality to fit when compression is selected. */
  targetBytes?: number;
}

export const DEFAULT_DOWNLOAD_OPTIONS: CompressedDownloadOptions = {
  quality: null,
  dpi: null,
};

export const DPI_PRESETS = [
  { value: null, label: 'Original', desc: 'No downsampling' },
  { value: 72, label: 'Screen', desc: '72 DPI — Smallest file' },
  { value: 150, label: 'Standard', desc: '150 DPI — Good balance' },
  { value: 300, label: 'Print', desc: '300 DPI — Print quality' },
  { value: 600, label: 'High', desc: '600 DPI — Maximum detail' },
];

export const COMPRESSION_PRESETS = [
  { value: null, label: 'Original', desc: 'No re-encoding' },
  { value: 20, label: 'Extreme', desc: 'Smallest file' },
  { value: 50, label: 'High', desc: 'Good balance' },
  { value: 75, label: 'Medium', desc: 'Better quality' },
  { value: 100, label: 'Low', desc: 'Highest quality' },
];

export function downloadQualityLabel({ quality, dpi }: CompressedDownloadOptions): string {
  if (quality === null && dpi === null) return 'Download (original quality)';
  if (quality === null) return `Download (original quality · ${dpi} DPI not applied)`;
  return `Download (${Math.round(quality * 100)}% · ${dpi === null ? 'original DPI' : `${dpi} DPI`})`;
}
