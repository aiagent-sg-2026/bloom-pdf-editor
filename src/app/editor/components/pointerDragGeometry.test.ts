import { describe, expect, it } from 'vitest';
import { isPointNearRectEdge, pointerDragDelta } from './pointerDragGeometry';

describe('touch dragging geometry', () => {
  it('recognizes a touch on the text box border as a move gesture', () => {
    expect(isPointNearRectEdge(101, 150, { left: 100, top: 100, right: 300, bottom: 200 })).toBe(true);
    expect(isPointNearRectEdge(200, 150, { left: 100, top: 100, right: 300, bottom: 200 })).toBe(false);
  });

  it('keeps pointer movement math independent of browser events', () => {
    expect(pointerDragDelta({ x: 20, y: 30 }, { x: 80, y: 110 })).toEqual({ x: 60, y: 80 });
  });
});
