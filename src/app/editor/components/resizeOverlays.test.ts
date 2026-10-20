// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageItem, VisualSignature } from '@/engine/browser-core';
import { EmbeddedImageOverlay } from './EmbeddedImageOverlay';
import { SignatureOverlay } from './signatures/SignatureOverlay';

const bounds = { x: 30, y: 50, width: 200, height: 100 };
const scale = 2;
const toCss = (box: typeof bounds) => ({
  left: box.x * scale,
  top: (800 - box.y - box.height) * scale,
  width: box.width * scale,
  height: box.height * scale,
});

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(element: ReactElement) {
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container.firstElementChild as HTMLElement;
}

async function pointer(target: EventTarget, type: string, clientX: number, clientY: number, shiftKey = false) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, clientX, clientY, shiftKey, pointerId: 1, pointerType: 'mouse', button: 0,
    }));
  });
}

function embeddedProps() {
  const item: ImageItem = {
    ...bounds, type: 'image', name: 'Im1', ctm: { a: 200, b: 0, c: 0, d: 100, e: 30, f: 50 },
    fillAlpha: 1, blendMode: 'Normal', softMask: null, clipPaths: [],
  };
  return {
    item, toCss, scale,
    onCommitMove: vi.fn(async () => {}),
    onCommitResize: vi.fn(async () => {}),
    onReplace: vi.fn(), onDeselect: vi.fn(),
  };
}

function signatureProps(locked = false, rotation = 0) {
  const signature: VisualSignature = {
    ...bounds, id: 'sig-1', pageIndex: 0, rotation, opacity: 1, locked,
    appearanceType: 'uploaded', appearanceId: 'appearance-1',
  };
  return {
    signature, toCss, scale, imageDataUrl: null, selected: true,
    onSelect: vi.fn(), onCommitMove: vi.fn(), onCommitResize: vi.fn(),
    onCommitRotate: vi.fn(), onDelete: vi.fn(), onDeselect: vi.fn(),
  };
}

describe('embedded image corner interactions', () => {
  it.each([
    { corner: 'nw', dx: -200, dy: -20, x: -70, y: 50 },
    { corner: 'ne', dx: 200, dy: -20, x: 30, y: 50 },
    { corner: 'sw', dx: -200, dy: 20, x: -70, y: 0 },
    { corner: 'se', dx: 200, dy: 20, x: 30, y: 0 },
  ])('preserves ratio and the fixed corner when dragging $corner at zoom 2', async row => {
    const props = embeddedProps();
    const overlay = await mount(createElement(EmbeddedImageOverlay, props));
    await pointer(overlay.querySelector(`[data-handle="${row.corner}"]`)!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 400 + row.dx, 400 + row.dy);
    expect(overlay.style.width).toBe('600px');
    expect(overlay.style.height).toBe('300px');
    expect(overlay.style.left).toBe(`${row.x * scale}px`);
    expect(overlay.style.top).toBe(`${(800 - row.y - 150) * scale}px`);
    await pointer(window, 'pointerup', 400 + row.dx, 400 + row.dy);
    expect(props.onCommitResize).toHaveBeenCalledWith({ x: row.x, y: row.y, width: 300, height: 150 });
    expect(props.onCommitMove).not.toHaveBeenCalled();
  });

  it('switches to free resize and back without changing the drag origin', async () => {
    const props = embeddedProps();
    const overlay = await mount(createElement(EmbeddedImageOverlay, props));
    await pointer(overlay.querySelector('[data-handle="se"]')!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 600, 420);
    expect(overlay.style.height).toBe('300px');
    await pointer(window, 'pointermove', 600, 420, true);
    expect(overlay.style.width).toBe('600px');
    expect(overlay.style.height).toBe('220px');
    await pointer(window, 'pointermove', 600, 420, false);
    expect(overlay.style.height).toBe('300px');
    await pointer(window, 'pointerup', 600, 420);
    expect(props.onCommitResize).toHaveBeenCalledWith({ x: 30, y: 0, width: 300, height: 150 });
  });
});

describe('signature resize interactions', () => {
  it('preserves rotation and the existing screen-axis resize convention', async () => {
    const props = signatureProps(false, 37);
    const overlay = await mount(createElement(SignatureOverlay, props));
    await pointer(overlay.querySelector('.cursor-se-resize')!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 600, 420);
    expect(overlay.style.width).toBe('600px');
    expect(overlay.style.height).toBe('300px');
    expect(overlay.style.transform).toBe('translate(-50%, -50%) rotate(-37deg)');
    await pointer(window, 'pointerup', 600, 420);
    expect(props.onCommitResize).toHaveBeenCalledWith('sig-1', 300, 150);
    expect(props.onCommitRotate).not.toHaveBeenCalled();
    expect(props.onCommitMove).not.toHaveBeenCalled();
  });

  it('keeps both minimums proportional and supports Shift during the same drag', async () => {
    const props = signatureProps();
    const overlay = await mount(createElement(SignatureOverlay, props));
    await pointer(overlay.querySelector('.cursor-se-resize')!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', -400, -400);
    expect(overlay.style.width).toBe('64px');
    expect(overlay.style.height).toBe('32px');
    await pointer(window, 'pointermove', -400, -400, true);
    expect(overlay.style.width).toBe('48px');
    expect(overlay.style.height).toBe('32px');
    await pointer(window, 'pointermove', -400, -400, false);
    expect(overlay.style.width).toBe('64px');
    expect(overlay.style.height).toBe('32px');
    await pointer(window, 'pointerup', -400, -400);
    expect(props.onCommitResize).toHaveBeenCalledWith('sig-1', 32, 16);
  });

  it('retains independent Shift resizing for a rotated signature', async () => {
    const props = signatureProps(false, 90);
    const overlay = await mount(createElement(SignatureOverlay, props));
    await pointer(overlay.querySelector('.cursor-se-resize')!, 'pointerdown', 400, 400, true);
    await pointer(window, 'pointermove', 600, 420, true);
    expect(overlay.style.width).toBe('600px');
    expect(overlay.style.height).toBe('220px');
    expect(overlay.style.transform).toBe('translate(-50%, -50%) rotate(-90deg)');
    await pointer(window, 'pointerup', 600, 420, true);
    expect(props.onCommitResize).toHaveBeenCalledWith('sig-1', 300, 110);
    expect(props.onCommitRotate).not.toHaveBeenCalled();
  });

  it('does not expose handles or mutate a locked, rotated signature', async () => {
    const props = signatureProps(true, 37);
    const overlay = await mount(createElement(SignatureOverlay, props));
    expect(overlay.querySelector('.cursor-se-resize')).toBeNull();
    expect(overlay.querySelector('[title="Drag to rotate"]')).toBeNull();
    await pointer(overlay, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 600, 420, true);
    await pointer(window, 'pointerup', 600, 420, true);
    await act(async () => {
      overlay.querySelector<HTMLButtonElement>('[title="Rotate 15°"]')!.click();
    });
    expect(overlay.style.width).toBe('400px');
    expect(overlay.style.height).toBe('200px');
    expect(overlay.style.transform).toBe('translate(-50%, -50%) rotate(-37deg)');
    expect(props.onCommitResize).not.toHaveBeenCalled();
    expect(props.onCommitMove).not.toHaveBeenCalled();
    expect(props.onCommitRotate).not.toHaveBeenCalled();
  });
});
