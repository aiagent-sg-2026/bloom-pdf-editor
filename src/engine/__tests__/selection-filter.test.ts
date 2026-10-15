/**
 * Selection index — page-background paths must not be selectable.
 */

import { describe, it, expect } from 'vitest';
import {
  isPageBackgroundPath,
  isSelectableDisplayItem,
  buildDisplayListIndex,
  hitTestDisplayList,
} from '../editing/selection';
import type { PathItem, ImageItem } from '../content/interpreter';

function path(partial: Partial<PathItem> & Pick<PathItem, 'x' | 'y' | 'width' | 'height'>): PathItem {
  return {
    type: 'path',
    segments: [],
    strokeColor: null,
    fillColor: [1, 1, 1],
    strokeAlpha: 1,
    fillAlpha: 1,
    lineWidth: 1,
    paintType: 'fill',
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
    ...partial,
  };
}

const page = { x: 0, y: 0, width: 612, height: 792 };

describe('selection: page background filter', () => {
  it('rejects full-page fill rect (0 0 612 792)', () => {
    const bg = path({ x: 0, y: 0, width: 612, height: 792, paintType: 'fill' });
    expect(isPageBackgroundPath(bg, page)).toBe(true);
    expect(isSelectableDisplayItem(bg, page)).toBe(false);
  });

  it('keeps normal-sized drawings', () => {
    const sig = path({ x: 100, y: 100, width: 120, height: 40, paintType: 'stroke' });
    expect(isPageBackgroundPath(sig, page)).toBe(false);
    expect(isSelectableDisplayItem(sig, page)).toBe(true);
  });

  it('hit-test prefers smallest bbox over page-sized leftover', () => {
    const bg = path({ x: 0, y: 0, width: 612, height: 792 });
    const img: ImageItem = {
      type: 'image',
      x: 200,
      y: 300,
      width: 80,
      height: 60,
      name: 'Im1',
      ctm: { a: 80, b: 0, c: 0, d: 60, e: 200, f: 300 },
      fillAlpha: 1,
      softMask: null,
      clipPaths: [],
      blendMode: 'Normal',
    };
    // Even if bg slips into the list, smallest wins
    const tree = buildDisplayListIndex([bg, img], page);
    const hit = hitTestDisplayList(tree, 220, 320);
    expect(hit?.data.type).toBe('image');
  });
});
