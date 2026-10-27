/**
 * Persona: a designer arranging a synthetic illustration.
 * Goal: resize proportionally or freely and precisely position the image without accidental history entries.
 * Steps: select; corner-drag; Shift-drag; use all eight handles; preview/cancel/commit X/Y/W/H; undo/redo; download.
 * Assertions: ratio locking, edge single-axis geometry, live canvas preview, Escape rollback,
 * one undo step per Enter, redo restoration, and the exported PDF image placement.
 */
import { test, expect, type Locator } from '@playwright/test';
import { bounds, download, openPdf, pdfCanvas, redo, renderAfter, resize, selectImage, undo } from '../helpers/ui';
import { inspectPdf } from '../helpers/pdf';

async function expectBox(frame: Locator, expected: { x: number; y: number; width: number; height: number }) {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    await expect.poll(async () => Math.abs((await bounds(frame))[key] - expected[key])).toBeLessThan(1);
  }
}

test('resize and position the embedded illustration', async ({ page }, info) => {
  await openPdf(page, 'image.pdf');
  const frame = await selectImage(page);
  const initial = await bounds(frame);
  await expect(frame.locator('[data-handle]')).toHaveCount(8);

  await resize(page, frame, 'se', 40, 10);
  let changed = await bounds(frame);
  expect(changed.width).toBeGreaterThan(initial.width);
  expect(changed.width / changed.height).toBeCloseTo(initial.width / initial.height, 2);
  await undo(page);
  await expectBox(frame, initial);

  await resize(page, frame, 'se', 40, 10, true);
  changed = await bounds(frame);
  expect(changed.width).toBeCloseTo(initial.width + 40, 0);
  expect(changed.height).toBeCloseTo(initial.height + 10, 0);
  expect(Math.abs(changed.width / changed.height - initial.width / initial.height)).toBeGreaterThan(0.05);
  await undo(page);
  await expectBox(frame, initial);

  for (const handle of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']) {
    // Diagonal gestures also prove edge handles ignore the perpendicular axis.
    const dx = handle.includes('w') ? -18 : 18;
    const dy = handle.includes('n') ? -12 : 12;
    const before = await bounds(frame);
    await resize(page, frame, handle, dx, dy);
    const after = await bounds(frame);
    if (handle === 'n' || handle === 's') {
      expect(after.width).toBeCloseTo(before.width, 0);
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.height).toBeGreaterThan(before.height + 5);
    } else if (handle === 'e' || handle === 'w') {
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
      expect(after.width).toBeGreaterThan(before.width + 5);
    } else {
      expect(after.width).toBeGreaterThan(before.width + 5);
      expect(after.height).toBeGreaterThan(before.height + 5);
      expect(after.width / after.height).toBeCloseTo(before.width / before.height, 2);
    }
    await undo(page);
    await expectBox(frame, initial);
  }
  await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Lock aspect ratio', exact: true }).uncheck();

  const edits = [
    { label: 'X (pt)', value: 160, key: 'x' },
    { label: 'Y (pt)', value: 410, key: 'y' },
    { label: 'W (pt)', value: 210, key: 'width' },
    { label: 'H (pt)', value: 140, key: 'height' },
  ] as const;
  const surface = pdfCanvas(page).locator('..');
  // Exclude selection chrome: antialiased edges can shift by a pixel fraction after undo.
  const screenshotOptions = { animations: 'disabled' as const, style: '[data-canvas-stack] .cursor-move { visibility: hidden !important; }' };
  for (const edit of edits) {
    const field = page.getByRole('spinbutton', { name: edit.label, exact: true });
    const before = await bounds(frame);
    const pixels = await surface.screenshot(screenshotOptions);
    await field.fill(String(edit.value));
    await expect.poll(async () => Math.abs((await bounds(frame))[edit.key] - before[edit.key])).toBeGreaterThan(2);
    // Observe actual preview pixels while the input is still focused, before any commit.
    await expect(field).toBeFocused();
    await expect.poll(async () => (await surface.screenshot(screenshotOptions)).equals(pixels)).toBe(false);
    await field.press('Escape');
    await expectBox(frame, before);
    await expect.poll(async () => (await surface.screenshot(screenshotOptions)).equals(pixels)).toBe(true);
    await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeDisabled();

    await field.fill(String(edit.value));
    await expect.poll(async () => Math.abs((await bounds(frame))[edit.key] - before[edit.key])).toBeGreaterThan(2);
    const preview = await bounds(frame);
    await renderAfter(page, () => field.press('Enter'));
    await expectBox(frame, preview);
    await expect(field).toBeEnabled();
    await undo(page);
    await expectBox(frame, before);
    // Disabled proves Enter plus blur did not create a second history entry.
    await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeDisabled();
    await redo(page);
    await expectBox(frame, preview);
    await undo(page);
    await expectBox(frame, before);
  }

  for (const edit of edits) {
    const field = page.getByRole('spinbutton', { name: edit.label, exact: true });
    await field.fill(String(edit.value));
    await renderAfter(page, () => field.press('Enter'));
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(String(edit.value));
  }
  const canvas = await bounds(pdfCanvas(page));
  await expectBox(frame, {
    x: canvas.x + 160 * canvas.width / 612,
    y: canvas.y + (792 - 410 - 140) * canvas.height / 792,
    width: 210 * canvas.width / 612, height: 140 * canvas.height / 792,
  });
  const { images } = await inspectPdf(await download(page, info));
  expect(images).toHaveLength(1);
  expect(images[0].page).toBe(0);
  for (const [key, value] of Object.entries({ x: 160, y: 410, width: 210, height: 140 })) {
    expect(images[0][key as 'x' | 'y' | 'width' | 'height']).toBeCloseTo(value, 1);
  }
});
