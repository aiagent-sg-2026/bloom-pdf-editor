import { describe, expect, it } from 'vitest';
import { visualSignatureToImagePlacement } from '../../signatures/visual/signature-export';

describe('visual signature export mapping', () => {
  it('preserves the placed PDF-space geometry and appearance', () => {
    const result = visualSignatureToImagePlacement(
      { id: 'sig-1', pageIndex: 2, x: 11, y: 22, width: 140, height: 50, rotation: 12, opacity: 0.75, locked: false, appearanceType: 'drawn', appearanceId: 'lib-1' },
      { id: 'lib-1', name: 'Drawn', favorite: false, createdAt: 1, updatedAt: 1, source: 'draw', imageDataUrl: 'data:image/png;base64,AA==', width: 20, height: 10 },
    );
    expect(result).toEqual({ signatureId: 'sig-1', pageIndex: 2, imageDataUrl: 'data:image/png;base64,AA==', x: 11, y: 22, width: 140, height: 50, rotation: 12, opacity: 0.75 });
  });
  it('does not export an overlay whose library appearance is missing', () => {
    expect(visualSignatureToImagePlacement({ id: 'sig-1', pageIndex: 0, x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1, locked: false, appearanceType: 'drawn', appearanceId: 'missing' }, undefined)).toBeNull();
  });
});
