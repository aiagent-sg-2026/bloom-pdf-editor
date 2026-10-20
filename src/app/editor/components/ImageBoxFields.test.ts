// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageBoxFields } from './ImageBoxFields';
import type { ImageBox } from './imageBoxEdit';

const box: ImageBox = { x: 20, y: 30, width: 120, height: 80 };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function field(index: number) {
  return container.querySelectorAll<HTMLInputElement>('input[type="number"]')[index];
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

describe('image numeric edit transactions', () => {
  it('shows coupled dimensions live and commits the last valid preview only once on Enter plus blur', async () => {
    const commit = vi.fn(async (_box: ImageBox) => {});
    const preview = vi.fn();
    await act(async () => root.render(createElement(ImageBoxFields, { box, onCommit: commit, onPreview: preview })));
    await change(field(2), '150');
    expect(field(3).value).toBe('100');
    expect(commit).not.toHaveBeenCalled();
    await change(field(2), '');
    expect(field(3).value).toBe('100');
    expect(preview).toHaveBeenLastCalledWith({ ...box, width: 150, height: 100 });
    await act(async () => field(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await blur(field(2));
    await act(async () => vi.runAllTimers());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({ ...box, width: 150, height: 100 });
  });

  it('restores both inputs and removes the preview on Escape without a blur commit', async () => {
    const commit = vi.fn();
    const preview = vi.fn();
    await act(async () => root.render(createElement(ImageBoxFields, { box, onCommit: commit, onPreview: preview })));
    await change(field(3), '100');
    expect(field(2).value).toBe('150');
    await act(async () => field(3).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await blur(field(3));
    await act(async () => vi.runAllTimers());
    expect(field(2).value).toBe('120');
    expect(field(3).value).toBe('80');
    expect(preview).toHaveBeenLastCalledWith(null);
    expect(commit).not.toHaveBeenCalled();
  });

  it('cancels a queued blur transaction when selection changes', async () => {
    const commit = vi.fn();
    const preview = vi.fn();
    await act(async () => root.render(createElement(ImageBoxFields, { box, onCommit: commit, onPreview: preview })));
    await change(field(0), '90');
    await blur(field(0));
    await act(async () => root.render(createElement(ImageBoxFields, {
      box: { ...box, x: 200 }, onCommit: commit, onPreview: preview,
    })));
    await act(async () => vi.runAllTimers());
    expect(field(0).value).toBe('200');
    expect(preview).toHaveBeenLastCalledWith(null);
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits one blur transaction after multiple valid numeric changes', async () => {
    const commit = vi.fn();
    await act(async () => root.render(createElement(ImageBoxFields, { box, onCommit: commit })));
    await change(field(0), '21');
    await change(field(0), '22');
    await change(field(0), '23');
    await blur(field(0));
    await act(async () => vi.runAllTimers());
    expect(commit).toHaveBeenCalledExactlyOnceWith({ ...box, x: 23 });
  });
});
