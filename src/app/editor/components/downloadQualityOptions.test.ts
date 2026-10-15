import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_PRESETS,
  DEFAULT_DOWNLOAD_OPTIONS,
  DPI_PRESETS,
  downloadQualityLabel,
} from './downloadQualityOptions';

describe('download quality selections', () => {
  it('defaults both groups to the first Original option', () => {
    expect(DEFAULT_DOWNLOAD_OPTIONS).toEqual({ dpi: null, quality: null });
    expect(DPI_PRESETS[0]).toMatchObject({ value: null, label: 'Original' });
    expect(COMPRESSION_PRESETS[0]).toMatchObject({ value: null, label: 'Original' });
    expect(downloadQualityLabel(DEFAULT_DOWNLOAD_OPTIONS)).toBe('Download (original quality)');
  });

  it.each([
    [{ dpi: 150, quality: 0.75 }, 'Download (75% · 150 DPI)'],
    [{ dpi: null, quality: 0.75 }, 'Download (75% · original DPI)'],
    [{ dpi: 150, quality: null }, 'Download (original quality · 150 DPI not applied)'],
    [{ dpi: 600, quality: 1 }, 'Download (100% · 600 DPI)'],
  ] as const)('labels independent selections %j', (options, label) => {
    expect(downloadQualityLabel(options)).toBe(label);
  });
});
