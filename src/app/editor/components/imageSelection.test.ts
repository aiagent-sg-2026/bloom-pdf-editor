import { describe, expect, it } from 'vitest';
import type { ImageItem } from '@/engine/browser-core';
import { findImagePlacement, sameImagePlacement } from './imageSelection';
import { resizeBox, type ResizeHandle } from './resizeGeometry';

const image: ImageItem = {
  type: 'image', name: 'Im1', x: 0, y: 0, width: 595.27, height: 841.89,
  ctm: { a: 595.27, b: 0, c: 0, d: 841.89, e: 0, f: 0 },
  sourceInstructionIndex: 2, fillAlpha: 1, blendMode: 'Normal', softMask: null, clipPaths: [],
};

function placement(box: { x: number; y: number; width: number; height: number }, index: number): ImageItem {
  return {
    ...image, ...box, sourceInstructionIndex: index,
    ctm: { a: box.width, b: 0, c: 0, d: box.height, e: box.x, f: box.y },
  };
}

const handles: ResizeHandle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];

describe('image selection refresh', () => {
  it.each(handles)('resolves the committed %s box rather than stale geometry or another use of the image', handle => {
    const box = resizeBox(image, handle, { dx: -70, dy: 70, minWidth: 8, minHeight: 8, free: false });
    const resized = placement(box, 20);
    const otherUse = placement({ x: 10, y: 20, width: 40, height: 50 }, 30);
    const selected = findImagePlacement([image, resized, otherUse], { name: image.name, ...box });
    expect(selected).toBe(resized);
    expect(selected?.ctm).toEqual({ a: box.width, b: 0, c: 0, d: box.height, e: box.x, f: box.y });
    expect(selected?.sourceInstructionIndex).toBe(20);
    expect(sameImagePlacement(selected, image)).toBe(false);
  });

  it('keeps a selection across reinterpretation without relying on object identity', () => {
    const reinterpreted = { ...image, ctm: { ...image.ctm } };
    expect(sameImagePlacement(reinterpreted, image)).toBe(true);
    expect(findImagePlacement([reinterpreted], image)).toBe(reinterpreted);
  });

  it('does not replace a different or cleared selection when a resize finishes', () => {
    const anotherPlacement = { ...image, sourceInstructionIndex: 7 };
    expect(sameImagePlacement(anotherPlacement, image)).toBe(false);
    expect(sameImagePlacement({ ...image, name: 'Im2' }, image)).toBe(false);
    expect(sameImagePlacement({ ...image, width: image.width - 1 }, image)).toBe(false);
    expect(sameImagePlacement(null, image)).toBe(false);
  });

  it('resolves rounded PDF coordinates without confusing nearby placements', () => {
    const box = { x: 0, y: 98.99999999, width: 526.123456789, height: 742.89000001 };
    const written = placement({ x: 0, y: 99, width: 526.123457, height: 742.89 }, 10);
    const nearby = placement({ ...written, x: 0.01 }, 14);
    expect(findImagePlacement([written, nearby], { name: image.name, ...box })).toBe(written);
    expect(findImagePlacement([nearby], { name: image.name, ...box })).toBeNull();
  });

  it('uses the appended placement for a commit and the recorded instruction for history', () => {
    const coincident = placement(image, 6);
    const appended = placement(image, 10);
    expect(findImagePlacement([image, coincident, appended], { name: image.name, x: 0, y: 0, width: image.width, height: image.height })).toBe(appended);
    expect(findImagePlacement([image, coincident, appended], coincident)).toBe(coincident);
  });

  it('restores both sides of a resize when a shared resource changes paint order', () => {
    const otherUse = placement({ x: 10, y: 20, width: 40, height: 50 }, 6);
    const before = { ...image };
    const after = placement({ x: 0, y: 99, width: 526, height: 742.89 }, 10);
    const undoList = [{ ...before }, { ...otherUse }];
    const redoList = [{ ...otherUse, sourceInstructionIndex: 2 }, { ...after }];
    const undone = findImagePlacement(undoList, before);
    const redone = findImagePlacement(redoList, after);
    expect(undone).toMatchObject({ x: 0, y: 0, width: 595.27, height: 841.89, sourceInstructionIndex: 2 });
    expect(redone).toMatchObject({ x: 0, y: 99, width: 526, height: 742.89, sourceInstructionIndex: 10 });
    expect(sameImagePlacement(undone, before)).toBe(true);
    expect(sameImagePlacement(redone, after)).toBe(true);
  });

  it('clears a placement missing from the restored content instead of selecting a namesake', () => {
    expect(findImagePlacement([{ ...image, name: 'Im2' }], image)).toBeNull();
    expect(findImagePlacement([placement({ x: 10, y: 20, width: 40, height: 50 }, 2)], image)).toBeNull();
  });
});
