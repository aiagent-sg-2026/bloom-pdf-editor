import { describe, expect, it } from 'vitest';
import { resizeBox, type ResizeCorner } from './resizeGeometry';

const origin = { x: 30, y: 50, width: 200, height: 100 };
const limits = { minWidth: 8, minHeight: 8, free: false };
const corners: ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];

function fixedCorner(box: typeof origin, corner: ResizeCorner) {
  return {
    x: corner.endsWith('e') ? box.x : box.x + box.width,
    y: corner.startsWith('n') ? box.y : box.y + box.height,
  };
}

function outward(corner: ResizeCorner, dw: number, dh: number) {
  return {
    dx: corner.endsWith('e') ? dw : -dw,
    dy: corner.startsWith('n') ? dh : -dh,
  };
}

describe('proportional corner resizing in PDF coordinates', () => {
  it.each(corners)('grows %s using the dominant relative width change', corner => {
    const resized = resizeBox(origin, corner, { ...limits, ...outward(corner, 100, 10) });
    expect(resized.width).toBe(300);
    expect(resized.height).toBe(150);
    expect(fixedCorner(resized, corner)).toEqual(fixedCorner(origin, corner));
    expect(origin).toEqual({ x: 30, y: 50, width: 200, height: 100 });
  });

  it.each(corners)('shrinks %s using the dominant relative height change', corner => {
    const resized = resizeBox(origin, corner, { ...limits, ...outward(corner, -20, -50) });
    expect(resized.width).toBe(100);
    expect(resized.height).toBe(50);
    expect(fixedCorner(resized, corner)).toEqual(fixedCorner(origin, corner));
  });

  it.each(corners)('allows independent dimensions with Shift at %s', corner => {
    const resized = resizeBox(origin, corner, {
      ...limits, ...outward(corner, 100, -20), free: true,
    });
    expect(resized.width).toBe(300);
    expect(resized.height).toBe(80);
    expect(fixedCorner(resized, corner)).toEqual(fixedCorner(origin, corner));
  });

  it.each(corners)('clamps a crossed %s handle without flipping or stretching', corner => {
    const resized = resizeBox(origin, corner, { ...limits, ...outward(corner, -400, -200) });
    expect(resized.width).toBe(16);
    expect(resized.height).toBe(8);
    expect(fixedCorner(resized, corner)).toEqual(fixedCorner(origin, corner));
  });

  it.each(['nw', 'ne'] as const)('treats screen-down as shrinking the %s PDF north edge', corner => {
    // At zoom 2, dragging 40 CSS pixels down is a -20 PDF-unit y delta.
    const resized = resizeBox(origin, corner, { ...limits, dx: 0, dy: -40 / 2 });
    expect(resized.width).toBe(160);
    expect(resized.height).toBe(80);
    expect(resized.y).toBe(origin.y);
    expect(fixedCorner(resized, corner)).toEqual(fixedCorner(origin, corner));
  });

  it.each([
    { width: 2000, height: 20, dx: 100, dy: -10, expectedWidth: 3000, expectedHeight: 30 },
    { width: 20, height: 2000, dx: 10, dy: -100, expectedWidth: 30, expectedHeight: 3000 },
  ])('uses relative rather than absolute changes for $width × $height', row => {
    const resized = resizeBox({ ...origin, width: row.width, height: row.height }, 'se', {
      ...limits, dx: row.dx, dy: row.dy,
    });
    expect(resized.width).toBe(row.expectedWidth);
    expect(resized.height).toBe(row.expectedHeight);
  });

  it.each([
    { width: 2000, height: 20, minWidth: 8, minHeight: 8, expectedWidth: 800, expectedHeight: 8 },
    { width: 20, height: 2000, minWidth: 8, minHeight: 8, expectedWidth: 8, expectedHeight: 800 },
    { width: 200, height: 100, minWidth: 24, minHeight: 16, expectedWidth: 32, expectedHeight: 16 },
    { width: 100, height: 200, minWidth: 24, minHeight: 16, expectedWidth: 24, expectedHeight: 48 },
    { width: 200, height: 100, minWidth: 10, minHeight: 10, expectedWidth: 20, expectedHeight: 10 },
  ])('respects both minimums for $width × $height with $minWidth × $minHeight limits', row => {
    const box = { ...origin, width: row.width, height: row.height };
    const resized = resizeBox(box, 'se', {
      ...limits, minWidth: row.minWidth, minHeight: row.minHeight,
      dx: -row.width * 2, dy: row.height * 2,
    });
    expect(resized.width).toBeCloseTo(row.expectedWidth);
    expect(resized.height).toBeCloseTo(row.expectedHeight);
    expect(resized.width / resized.height).toBeCloseTo(box.width / box.height);
    expect(fixedCorner(resized, 'se')).toEqual(fixedCorner(box, 'se'));
  });

  it('clamps each side independently in free mode', () => {
    expect(resizeBox(origin, 'se', { ...limits, dx: -500, dy: -20, free: true }))
      .toEqual({ x: 30, y: 30, width: 8, height: 120 });
    expect(resizeBox(origin, 'se', { ...limits, dx: 20, dy: 500, free: true }))
      .toEqual({ x: 30, y: 142, width: 220, height: 8 });
  });

  it('uses the dominant signed change when axes move in opposite directions', () => {
    const resized = resizeBox(origin, 'se', { ...limits, dx: 20, dy: 50 });
    expect(resized).toEqual({ x: 30, y: 100, width: 100, height: 50 });
  });

  it('returns to the original ratio when Shift is released in the same drag', () => {
    const pointer = { dx: 100, dy: -10 };
    expect(resizeBox(origin, 'se', { ...limits, ...pointer })).toEqual({ x: 30, y: 0, width: 300, height: 150 });
    expect(resizeBox(origin, 'se', { ...limits, ...pointer, free: true })).toEqual({ x: 30, y: 40, width: 300, height: 110 });
    expect(resizeBox(origin, 'se', { ...limits, ...pointer })).toEqual({ x: 30, y: 0, width: 300, height: 150 });
  });
});

describe('one-axis edge resizing in PDF coordinates', () => {
  const edges = [
    { handle: 'n', dx: 70, dy: 40, grown: { x: 30, y: 50, width: 200, height: 140 }, shrunk: { x: 30, y: 50, width: 200, height: 60 } },
    { handle: 's', dx: 70, dy: -40, grown: { x: 30, y: 10, width: 200, height: 140 }, shrunk: { x: 30, y: 90, width: 200, height: 60 } },
    { handle: 'e', dx: 40, dy: 70, grown: { x: 30, y: 50, width: 240, height: 100 }, shrunk: { x: 30, y: 50, width: 160, height: 100 } },
    { handle: 'w', dx: -40, dy: 70, grown: { x: -10, y: 50, width: 240, height: 100 }, shrunk: { x: 70, y: 50, width: 160, height: 100 } },
  ] as const;

  describe.each([false, true])('with free=%s', free => {
    it.each(edges)('grows and shrinks $handle without moving the opposite edge or the other axis', row => {
      expect(resizeBox(origin, row.handle, { ...limits, free, dx: row.dx, dy: row.dy })).toEqual(row.grown);
      expect(resizeBox(origin, row.handle, { ...limits, free, dx: -row.dx, dy: -row.dy })).toEqual(row.shrunk);
    });

    it.each([
      { handle: 'n', dx: 1000, dy: -1000, expected: { x: 30, y: 50, width: 200, height: 8 } },
      { handle: 's', dx: 1000, dy: 1000, expected: { x: 30, y: 142, width: 200, height: 8 } },
      { handle: 'e', dx: -1000, dy: 1000, expected: { x: 30, y: 50, width: 8, height: 100 } },
      { handle: 'w', dx: 1000, dy: 1000, expected: { x: 222, y: 50, width: 8, height: 100 } },
    ] as const)('clamps a crossed $handle at 8 pt without flipping', row => {
      expect(resizeBox(origin, row.handle, { ...limits, free, dx: row.dx, dy: row.dy })).toEqual(row.expected);
    });
  });

  it.each(edges)('ignores purely orthogonal movement at $handle', row => {
    const vertical = row.handle === 'n' || row.handle === 's';
    expect(resizeBox(origin, row.handle, {
      ...limits, dx: vertical ? 500 : 0, dy: vertical ? 0 : 500,
    })).toEqual(origin);
  });
});
