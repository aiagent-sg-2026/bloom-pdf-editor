import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import path from 'node:path';

export const fixturePath = (name: string) => path.resolve(__dirname, '../fixtures/generated', name);
export const pdfCanvas = (page: Page) => page.locator('[data-canvas-stack] canvas.pdf-canvas');

export async function uploadPdf(page: Page, nameOrPath: string) {
  await page.goto('./');
  await page.locator('input[type="file"]').setInputFiles(
    path.isAbsolute(nameOrPath) ? nameOrPath : fixturePath(nameOrPath),
  );
  await expect(page).toHaveURL(/\/editor\/?$/);
}

export async function waitForEditor(page: Page) {
  await expect(pdfCanvas(page)).toBeVisible();
  await expect.poll(async () => Number(await pdfCanvas(page).getAttribute('width'))).toBeGreaterThan(100);
  await expect(page.getByText('Rendering...', { exact: true })).toBeHidden();
  await expect(page.getByTitle('Download original / edited PDF (no recompression)', { exact: true })).toBeEnabled();
}

export async function openPdf(page: Page, nameOrPath = 'letter.pdf') {
  await uploadPdf(page, nameOrPath);
  await waitForEditor(page);
}

// Rendering... may still be absent while an asynchronous edit is committing.
// Wait for the old canvas to be replaced before checking final editor readiness.
export async function renderAfter(page: Page, action: () => Promise<unknown>) {
  await waitForEditor(page);
  const previous = await pdfCanvas(page).elementHandle();
  if (!previous) throw new Error('PDF canvas is missing before edit');
  try {
    await action();
    await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false);
    await waitForEditor(page);
  } finally {
    await previous.dispose();
  }
}

export async function download(page: Page, info: TestInfo, label = 'export') {
  const event = page.waitForEvent('download');
  await page.getByTitle('Download original / edited PDF (no recompression)', { exact: true }).click();
  const file = await event;
  const target = info.outputPath(`${label}.pdf`);
  await file.saveAs(target);
  expect(await file.failure()).toBeNull();
  await info.attach(label, { path: target, contentType: 'application/pdf' });
  return target;
}

export type Point = { x: number; y: number };
export async function pagePoint(page: Page, x: number, y: number): Promise<Point> {
  const box = await pdfCanvas(page).boundingBox();
  if (!box) throw new Error('PDF canvas is not visible');
  // Fixture coordinates are top-left PDF points on a 612 by 792 letter page.
  return { x: box.x + x * box.width / 612, y: box.y + y * box.height / 792 };
}

export async function drag(page: Page, from: Point, to: Point, shift = false) {
  if (shift) await page.keyboard.down('Shift');
  try {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
  } finally {
    if (shift) await page.keyboard.up('Shift');
  }
}

export async function bounds(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected a visible selection box');
  return box;
}

export async function resize(page: Page, frame: Locator, handle: string, dx: number, dy: number, shift = false) {
  const box = await bounds(frame.locator(`[data-handle="${handle}"]`));
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await renderAfter(page, () => drag(page, from, { x: from.x + dx, y: from.y + dy }, shift));
  await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeEnabled();
}

export async function undo(page: Page) {
  await renderAfter(page, () => page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click());
  await expect(page.getByTitle('Redo (Ctrl+Shift+Z)', { exact: true })).toBeEnabled();
}

export async function redo(page: Page) {
  await renderAfter(page, () => page.getByTitle('Redo (Ctrl+Shift+Z)', { exact: true }).click());
  await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeEnabled();
}

export async function selectImage(page: Page) {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const point = await pagePoint(page, 240, 332);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTitle('Replace image (keep size)', { exact: true })).toBeVisible();
  // The immediate parent of the floating toolbar is the selected image frame.
  return page.getByTitle('Replace image (keep size)', { exact: true }).locator('..').locator('..');
}
