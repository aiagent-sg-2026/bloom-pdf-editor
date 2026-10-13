import { describe, expect, it } from 'vitest';
import { EMBEDDED_IMAGE_OVERLAY_LAYERS } from './EmbeddedImageOverlay';

describe('embedded image resize handle layering', () => {
  it('puts resize handles above the interactive overlay layer', () => {
    expect(EMBEDDED_IMAGE_OVERLAY_LAYERS.handle).toBeGreaterThan(EMBEDDED_IMAGE_OVERLAY_LAYERS.overlay);
  });
});
