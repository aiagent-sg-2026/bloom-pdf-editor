import { describe, expect, it } from 'vitest';
import { Z_LAYERS } from './zLayers';
import { EMBEDDED_IMAGE_OVERLAY_LAYERS } from './components/EmbeddedImageOverlay';

describe('editor layer scale', () => {
  it('reserves 0–99 for canvas-local layers and keeps every global tier strictly above it', () => {
    expect(Z_LAYERS.canvasMin).toBe(0);
    expect(Z_LAYERS.canvasMax).toBe(99);
    const tiers = [
      Z_LAYERS.canvasMax,
      Z_LAYERS.chrome,
      Z_LAYERS.expandedSidebar,
      Z_LAYERS.toolbar,
      Z_LAYERS.dropdown,
      Z_LAYERS.drawerBackdrop,
      Z_LAYERS.drawer,
      Z_LAYERS.modalBackdrop,
      Z_LAYERS.modal,
      Z_LAYERS.toast,
    ];
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]).toBeGreaterThan(tiers[i - 1]);
    }
    for (const layer of Object.values(Z_LAYERS)) {
      expect(Number.isInteger(layer)).toBe(true);
    }
  });

  it('keeps embedded image frames and handles within the canvas-local range', () => {
    for (const layer of Object.values(EMBEDDED_IMAGE_OVERLAY_LAYERS)) {
      expect(layer).toBeGreaterThanOrEqual(Z_LAYERS.canvasMin);
      expect(layer).toBeLessThanOrEqual(Z_LAYERS.canvasMax);
    }
    expect(EMBEDDED_IMAGE_OVERLAY_LAYERS.handle).toBeGreaterThan(EMBEDDED_IMAGE_OVERLAY_LAYERS.overlay);
  });
});
