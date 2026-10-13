import { describe, expect, it } from 'vitest';
import {
  floatingImageReplaceButtonRect,
  floatingImageSeHandleRect,
  rectanglesIntersect,
} from './floatingImageGeometry';

describe('floating image controls', () => {
  it('keeps Replace out of the SE resize handle hit area', () => {
    const box = { left: 100, top: 80, width: 240, height: 160 };

    expect(rectanglesIntersect(
      floatingImageReplaceButtonRect(box),
      floatingImageSeHandleRect(box),
    )).toBe(false);
  });
});
