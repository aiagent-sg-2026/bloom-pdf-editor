// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageItem, VisualSignature } from '@/engine/browser-core';
import { EmbeddedImageOverlay } from './EmbeddedImageOverlay';
import { SignatureOverlay } from './signatures/SignatureOverlay';
import { Z_LAYERS } from '../zLayers';
const bounds = { x: 30, y: 50, width: 200, height: 100 };
const scale = 2;
const toCssAtScale = (scale: number) => (box: typeof bounds) => ({
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

function embeddedProps(zoom = scale) {
  const item: ImageItem = {
    ...bounds, type: 'image', name: 'Im1', ctm: { a: 200, b: 0, c: 0, d: 100, e: 30, f: 50 },
    fillAlpha: 1, blendMode: 'Normal', softMask: null, clipPaths: [],
  };
  return {
    item, toCss: toCssAtScale(zoom), scale: zoom,
    onCommitMove: vi.fn(async () => {}),
    onCommitResize: vi.fn(async () => {}),
    onReplace: vi.fn(), onDeselect: vi.fn(),
  };
}

function signatureProps(locked = false, rotation = 0, zoom = scale) {
  const signature: VisualSignature = {
    ...bounds, id: 'sig-1', pageIndex: 0, rotation, opacity: 1, locked,
    appearanceType: 'uploaded', appearanceId: 'appearance-1',
  };
  return {
    signature, toCss: toCssAtScale(zoom), scale: zoom, imageDataUrl: null, selected: true,
    onSelect: vi.fn(), onCommitMove: vi.fn(), onCommitResize: vi.fn(),
    onCommitRotate: vi.fn(), onDelete: vi.fn(), onDeselect: vi.fn(),
  };
}

describe('embedded image Shift interactions', () => {
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
    await pointer(overlay.querySelector('[data-handle="se"]')!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 600, 420);
    expect(overlay.style.width).toBe('600px');
    expect(overlay.style.height).toBe('300px');
    expect(overlay.style.transform).toBe('translate(-50%, -50%) rotate(-37deg)');
    await pointer(window, 'pointerup', 600, 420);
    expect(props.onCommitResize).toHaveBeenCalledWith('sig-1', { x: 30, y: 0, width: 300, height: 150 });
    expect(props.onCommitRotate).not.toHaveBeenCalled();
    expect(props.onCommitMove).not.toHaveBeenCalled();
  });

  it('keeps both minimums proportional and supports Shift during the same drag', async () => {
    const props = signatureProps();
    const overlay = await mount(createElement(SignatureOverlay, props));
    await pointer(overlay.querySelector('[data-handle="se"]')!, 'pointerdown', 400, 400);
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
    expect(props.onCommitResize).toHaveBeenCalledWith('sig-1', { x: 30, y: 134, width: 32, height: 16 });
  });

  it('retains independent Shift resizing for a rotated signature', async () => {
    const props = signatureProps(false, 90);
    const overlay = await mount(createElement(SignatureOverlay, props));
    await pointer(overlay.querySelector('[data-handle="se"]')!, 'pointerdown', 400, 400, true);
    await pointer(window, 'pointermove', 600, 420, true);
    expect(overlay.style.width).toBe('600px');
    expect(overlay.style.height).toBe('220px');
    expect(overlay.style.transform).toBe('translate(-50%, -50%) rotate(-90deg)');
    await pointer(window, 'pointerup', 600, 420, true);
    expect(props.onCommitResize).toHaveBeenCalledWith('sig-1', { x: 30, y: 40, width: 300, height: 110 });
    expect(props.onCommitRotate).not.toHaveBeenCalled();
  });

  it('does not expose handles or mutate a locked, rotated signature', async () => {
    const props = signatureProps(true, 37);
    const overlay = await mount(createElement(SignatureOverlay, props));
    expect(overlay.querySelector('[data-handle]')).toBeNull();
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

const overlayKinds = [
  {
    kind: 'image',
    setup: (zoom = scale) => {
      const props = embeddedProps(zoom);
      return { element: createElement(EmbeddedImageOverlay, props), resize: props.onCommitResize, move: props.onCommitMove };
    },
  },
  {
    kind: 'signature',
    setup: (zoom = scale) => {
      const props = signatureProps(false, 0, zoom);
      return { element: createElement(SignatureOverlay, props), resize: props.onCommitResize, move: props.onCommitMove };
    },
  },
];

const edgeDrags = [
  { handle: 'n', dx: 70, dy: -40, box: { x: 30, y: 50, width: 200, height: 140 } },
  { handle: 's', dx: 70, dy: 40, box: { x: 30, y: 10, width: 200, height: 140 } },
  { handle: 'e', dx: 40, dy: 70, box: { x: 30, y: 50, width: 240, height: 100 } },
  { handle: 'w', dx: -40, dy: 70, box: { x: -10, y: 50, width: 240, height: 100 } },
] as const;

function expectLiveBox(overlay: HTMLElement, box: typeof bounds, kind: string, zoom: number) {
  const css = toCssAtScale(zoom)(box);
  expect(overlay.style.width).toBe(`${css.width}px`);
  expect(overlay.style.height).toBe(`${css.height}px`);
  expect(overlay.style.left).toBe(`${css.left + (kind === 'signature' ? css.width / 2 : 0)}px`);
  expect(overlay.style.top).toBe(`${css.top + (kind === 'signature' ? css.height / 2 : 0)}px`);
}

describe.each(overlayKinds)('$kind eight-handle resizing', ({ kind, setup }) => {
  describe.each([0.5, 2, 3])('at zoom %s', zoom => {
    it.each(edgeDrags)('resizes only one axis at $handle with and without Shift', async row => {
      const { element, resize, move } = setup(zoom);
      const overlay = await mount(element);
      await pointer(overlay.querySelector(`[data-handle="${row.handle}"]`)!, 'pointerdown', 400, 400);
      await pointer(window, 'pointermove', 400 + row.dx * zoom, 400 + row.dy * zoom);
      expectLiveBox(overlay, row.box, kind, zoom);
      expect(resize).not.toHaveBeenCalled();
      await pointer(window, 'pointermove', 400 + row.dx * zoom, 400 + row.dy * zoom, true);
      expectLiveBox(overlay, row.box, kind, zoom);
      await pointer(window, 'pointerup', 400 + row.dx * zoom, 400 + row.dy * zoom, true);
      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize).toHaveBeenCalledWith(...(kind === 'signature' ? ['sig-1', row.box] : [row.box]));
      expect(move).not.toHaveBeenCalled();
    });
  });

  it.each(edgeDrags)('does not commit purely orthogonal movement at $handle', async row => {
    const { element, resize, move } = setup();
    const overlay = await mount(element);
    const vertical = row.handle === 'n' || row.handle === 's';
    await pointer(overlay.querySelector(`[data-handle="${row.handle}"]`)!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', vertical ? 600 : 400, vertical ? 400 : 600, true);
    expectLiveBox(overlay, bounds, kind, scale);
    await pointer(window, 'pointerup', vertical ? 600 : 400, vertical ? 400 : 600, true);
    expect(resize).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it.each([
    { handle: 'n', dx: 500, dy: 500, box: { x: 30, y: 50, width: 200, height: 8 } },
    { handle: 's', dx: 500, dy: -500, box: { x: 30, y: 142, width: 200, height: 8 } },
    { handle: 'e', dx: -500, dy: 500, box: { x: 30, y: 50, width: 8, height: 100 } },
    { handle: 'w', dx: 500, dy: 500, box: { x: 222, y: 50, width: 8, height: 100 } },
  ])('clamps $handle at 8 pt and commits the fixed opposite edge', async row => {
    const { element, resize } = setup();
    const overlay = await mount(element);
    await pointer(overlay.querySelector(`[data-handle="${row.handle}"]`)!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 400 + row.dx * scale, 400 + row.dy * scale);
    expectLiveBox(overlay, row.box, kind, scale);
    await pointer(window, 'pointerup', 400 + row.dx * scale, 400 + row.dy * scale);
    expect(resize).toHaveBeenCalledWith(...(kind === 'signature' ? ['sig-1', row.box] : [row.box]));
  });

  it.each([
    { handle: 'nw', dx: -100, dy: -10, box: { x: -70, y: 50, width: 300, height: 150 } },
    { handle: 'ne', dx: 100, dy: -10, box: { x: 30, y: 50, width: 300, height: 150 } },
    { handle: 'sw', dx: -100, dy: 10, box: { x: -70, y: 0, width: 300, height: 150 } },
    { handle: 'se', dx: 100, dy: 10, box: { x: 30, y: 0, width: 300, height: 150 } },
  ])('keeps proportional corner resizing and its anchor at $handle', async row => {
    const { element, resize } = setup();
    const overlay = await mount(element);
    await pointer(overlay.querySelector(`[data-handle="${row.handle}"]`)!, 'pointerdown', 400, 400);
    await pointer(window, 'pointermove', 400 + row.dx * scale, 400 + row.dy * scale);
    expectLiveBox(overlay, row.box, kind, scale);
    await pointer(window, 'pointerup', 400 + row.dx * scale, 400 + row.dy * scale);
    expect(resize).toHaveBeenCalledWith(...(kind === 'signature' ? ['sig-1', row.box] : [row.box]));
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('positions eight handles at corners and edge midpoints above the overlay', async () => {
    const overlay = await mount(setup().element);
    const handles = [...overlay.querySelectorAll<HTMLElement>('[data-handle]')];
    expect(handles.map(handle => handle.dataset.handle).sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
    expect(overlay.style.zIndex).toBe(String(Z_LAYERS.canvasOverlay));
    for (const handle of handles) {
      expect(handle.style.zIndex).toBe(String(Z_LAYERS.canvasHandle));
    }
    for (const direction of ['n', 's']) {
      const handle = overlay.querySelector<HTMLElement>(`[data-handle="${direction}"]`)!;
      expect(handle.style.left).toBe('50%');
      expect(handle.style.transform).toBe('translateX(-50%)');
      expect(handle.style[direction === 'n' ? 'top' : 'bottom']).toBe('-5px');
    }
    for (const direction of ['e', 'w']) {
      const handle = overlay.querySelector<HTMLElement>(`[data-handle="${direction}"]`)!;
      expect(handle.style.top).toBe('50%');
      expect(handle.style.transform).toBe('translateY(-50%)');
      expect(handle.style[direction === 'e' ? 'right' : 'left']).toBe('-5px');
    }
  });
});
