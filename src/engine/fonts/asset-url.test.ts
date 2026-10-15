import { afterEach, describe, expect, it, vi } from 'vitest';

// Fresh imports exercise the environment captured at module load; static imports cannot reset it.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('assetUrl', () => {
  it.each([undefined, '', '/'])('preserves root-host URLs with base path %j', async (basePath) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);
    vi.resetModules();
    const { assetUrl } = await import('./asset-url');
    expect(assetUrl('/fonts/NotoSansSC-Regular.ttf')).toBe('/fonts/NotoSansSC-Regular.ttf');
    expect(assetUrl('brand/paperloom-mark.svg')).toBe('/brand/paperloom-mark.svg');
  });

  it.each(['/bloom-pdf-editor', '/bloom-pdf-editor/', '/bloom-pdf-editor///'])('prefixes public URLs with %s', async (basePath) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);
    vi.resetModules();
    const { assetUrl } = await import('./asset-url');
    expect(assetUrl('/fonts/NotoSansSC-Regular.ttf')).toBe('/bloom-pdf-editor/fonts/NotoSansSC-Regular.ttf');
    expect(assetUrl('fonts/NotoSansSC-OFL.txt')).toBe('/bloom-pdf-editor/fonts/NotoSansSC-OFL.txt');
    expect(assetUrl('/brand/paperloom-mark.svg')).toBe('/bloom-pdf-editor/brand/paperloom-mark.svg');
  });
});
