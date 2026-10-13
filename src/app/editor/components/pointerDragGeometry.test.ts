import { describe, expect, it } from 'vitest';
import {
  floatingTextPdfDelta,
  isPointNearRectEdge,
  pointerDragDelta,
  shouldStartFloatingTextDrag,
} from './pointerDragGeometry';

describe('touch dragging geometry', () => {
  it('recognizes a touch on the text box border as a move gesture', () => {
    expect(isPointNearRectEdge(101, 150, { left: 100, top: 100, right: 300, bottom: 200 })).toBe(true);
    expect(isPointNearRectEdge(200, 150, { left: 100, top: 100, right: 300, bottom: 200 })).toBe(false);
  });

  it('uses the outer touch band without treating the interior as a drag', () => {
    const rect = { left: 100, top: 100, right: 300, bottom: 200 };
    expect(isPointNearRectEdge(114, 150, rect)).toBe(true);
    expect(isPointNearRectEdge(115, 150, rect)).toBe(false);
    expect(isPointNearRectEdge(200, 114, rect)).toBe(true);
    expect(isPointNearRectEdge(200, 150, rect)).toBe(false);
  });

  it('keeps pointer movement math independent of browser events', () => {
    expect(pointerDragDelta({ x: 20, y: 30 }, { x: 80, y: 110 })).toEqual({ x: 60, y: 80 });
  });

  it('converts screen movement to PDF movement at the current scale', () => {
    expect(floatingTextPdfDelta({ x: 20, y: 30 }, { x: 80, y: 110 }, 2))
      .toEqual({ x: 30, y: -40 });
  });

  it('keeps touch text editing separate from the explicit drag handle', () => {
    expect(shouldStartFloatingTextDrag('touch', true, false)).toBe(false);
    expect(shouldStartFloatingTextDrag('touch', false, false)).toBe(true);
    expect(shouldStartFloatingTextDrag('touch', false, true)).toBe(true);
    expect(shouldStartFloatingTextDrag('mouse', true, false)).toBe(false);
  });
});
