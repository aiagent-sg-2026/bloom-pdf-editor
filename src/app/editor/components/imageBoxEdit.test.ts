import { describe, expect, it } from 'vitest';
import { editImageBox, previewImageBoxEdit, type ImageBoxDraft, type ImageBoxField } from './imageBoxEdit';

const box = { x: 20, y: 30, width: 120, height: 80 };

describe('image box edits', () => {
  it.each([true, false])('edits all four fields with aspect lock %s', (locked) => {
    expect(editImageBox(box, 'x', '-12.75', locked)).toEqual({ ...box, x: -12.75 });
    expect(editImageBox(box, 'y', '42.25', locked)).toEqual({ ...box, y: 42.25 });
    expect(editImageBox(box, 'width', '150', locked)).toEqual({
      ...box, width: 150, height: locked ? 100 : 80,
    });
    expect(editImageBox(box, 'height', '100', locked)).toEqual({
      ...box, width: locked ? 150 : 120, height: 100,
    });
    expect(box).toEqual({ x: 20, y: 30, width: 120, height: 80 });
  });

  it('rounds only the proportional dimension to two decimals', () => {
    expect(editImageBox(box, 'width', '121.234', true)).toEqual({
      ...box, width: 121.234, height: 80.82,
    });
    expect(editImageBox(box, 'height', '81.111', true)).toEqual({
      ...box, width: 121.67, height: 81.111,
    });
  });

  it.each(['x', 'y', 'width', 'height'] as const)('rejects invalid %s input', (field) => {
    for (const input of ['', '   ', 'NaN', 'Infinity', '-Infinity', '1e999', 'invalid']) {
      expect(editImageBox(box, field, input, true)).toBeNull();
      expect(editImageBox(box, field, input, false)).toBeNull();
    }
  });

  it.each(['width', 'height'] as const)('enforces the 8 pt minimum for %s', (field) => {
    for (const input of ['-8', '0', '0.01', '7.999']) {
      expect(editImageBox(box, field, input, false)).toBeNull();
      expect(editImageBox(box, field, input, true)).toBeNull();
    }
    expect(editImageBox(box, field, '8', false)?.[field]).toBe(8);
    const square = { ...box, width: 16, height: 16 };
    expect(editImageBox(square, field, '8', true)).toEqual({ ...square, width: 8, height: 8 });
  });

  it('rejects a locked resize that would make the other dimension too small', () => {
    expect(editImageBox(box, 'width', '8', true)).toBeNull();
    expect(editImageBox({ ...box, width: 80, height: 120 }, 'height', '8', true)).toBeNull();
  });

  it('clamps positions to partial page overlap, including nonzero page origins', () => {
    const page = { x: 10, y: -20, width: 600, height: 800 };
    expect(editImageBox(box, 'x', '-10000', true, page)).toEqual({ ...box, x: -109 });
    expect(editImageBox(box, 'x', '10000', false, page)).toEqual({ ...box, x: 609 });
    expect(editImageBox(box, 'y', '-10000', false, page)).toEqual({ ...box, y: -99 });
    expect(editImageBox(box, 'y', '10000', true, page)).toEqual({ ...box, y: 779 });
  });

  it('does not clamp positions without usable page bounds or move the corner on resize', () => {
    expect(editImageBox(box, 'x', '-1e20', true)?.x).toBe(-1e20);
    expect(editImageBox(box, 'y', '1e20', false)?.y).toBe(1e20);
    expect(editImageBox(box, 'x', '1000', true, { x: 0, y: 0, width: NaN, height: 0 })?.x).toBe(1000);
    const offPage = { ...box, x: -500, y: 1000 };
    expect(editImageBox(offPage, 'width', '240', true, { x: 0, y: 0, width: 600, height: 800 }))
      .toEqual({ ...offPage, width: 240, height: 160 });
  });

  it.each([
    [{ ...box, width: 1e300, height: 8 }, 'height', '16', { ...box, width: 2e300, height: 16 }],
    [{ ...box, width: 8, height: 1e300 }, 'width', '16', { ...box, width: 16, height: 2e300 }],
    [{ ...box, width: 1e300, height: 8 }, 'width', '8', null],
    [{ ...box, width: 8, height: 1e300 }, 'height', '8', null],
    [{ ...box, width: 1e308, height: 8 }, 'height', '16', null],
    [{ ...box, width: 8, height: 1e308 }, 'width', '16', null],
  ] as const)('handles extreme ratios for %s / %s', (current, field, input, expected) => {
    expect(editImageBox(current, field as ImageBoxField, input, true)).toEqual(expected);
  });

  it('rejects invalid source ratios only when the lock needs them', () => {
    for (const width of [0, -1, NaN, Infinity]) {
      expect(editImageBox({ ...box, width }, 'height', '100', true)).toBeNull();
    }
    expect(editImageBox({ ...box, width: 0 }, 'width', '100', false)).toEqual({ ...box, width: 100 });
  });
});

describe('image box live preview drafts', () => {
  const initial = (): ImageBoxDraft => ({ inputs: {}, box });

  it.each(['x', 'y', 'width', 'height'] as const)('retains the last valid %s through empty and invalid input', field => {
    const valid = previewImageBoxEdit(box, initial(), field, '160', true);
    for (const input of ['', '-', 'NaN', 'Infinity', '1e999']) {
      const rejected = previewImageBoxEdit(box, valid, field, input, true);
      expect(rejected.box).toEqual(valid.box);
      expect(rejected.inputs[field]).toBe(input);
    }
  });

  it('updates the coupled input without accumulating proportional rounding', () => {
    let draft = previewImageBoxEdit(box, initial(), 'width', '121.234', true);
    expect(draft.inputs).toEqual({ width: '121.234', height: '80.82' });
    draft = previewImageBoxEdit(box, draft, 'width', '150', true);
    expect(draft.box).toEqual({ ...box, width: 150, height: 100 });
    expect(draft.inputs.height).toBe('100');
    draft = previewImageBoxEdit(box, draft, 'height', '100.001', true);
    expect(draft.box).toEqual({ ...box, width: 150, height: 100.001 });
    expect(draft.inputs.width).toBe('150');
  });

  it('rejects undersized previews on either axis and resumes at the next valid edit', () => {
    const valid = previewImageBoxEdit(box, initial(), 'width', '150', true);
    const rejected = previewImageBoxEdit(box, valid, 'width', '8', true);
    expect(rejected.box).toEqual(valid.box);
    expect(rejected.inputs.height).toBe('100');
    expect(previewImageBoxEdit(box, rejected, 'width', '180', true).box)
      .toEqual({ ...box, width: 180, height: 120 });
  });

  it('previews unlocked sizes independently and clamps positions to the existing page bounds', () => {
    expect(previewImageBoxEdit(box, initial(), 'height', '100', false).box)
      .toEqual({ ...box, height: 100 });
    const page = { x: 10, y: -20, width: 600, height: 800 };
    const draft = previewImageBoxEdit(box, initial(), 'x', '10000', false, page);
    expect(draft.box).toEqual({ ...box, x: 609 });
    expect(draft.inputs.x).toBe('10000');
  });
});
