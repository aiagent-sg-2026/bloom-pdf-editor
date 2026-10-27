/**
 * Persona: a tester signing a synthetic demonstration document, not a real agreement.
 * Goal: create a reusable visual mark and resize its placement reversibly.
 * Steps: open signature dialog; type a synthetic mark; save; drag from library; resize all eight handles; undo.
 * Assertions: dialog creates a visible library entry, native dragging places it on the page,
 * every handle resizes with correct edge-axis behavior, and undo restores geometry then removes placement.
 */
import { test, expect } from '@playwright/test';
import { bounds, openPdf, pdfCanvas, renderAfter, resize, undo } from '../helpers/ui';

test('create a signature, drag it from the library, and resize it', async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().fill('Synthetic mark');
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name', { exact: true }).fill('SYNTHETIC');
  await dialog.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(dialog).toBeHidden();

  const card = page.locator('[draggable="true"]').filter({ has: page.getByRole('img', { name: 'Synthetic mark', exact: true }) });
  await expect(card).toBeVisible();
  const canvas = await bounds(pdfCanvas(page));
  await renderAfter(page, () => card.dragTo(pdfCanvas(page).locator('..'), {
    sourcePosition: { x: 30, y: 20 },
    targetPosition: { x: canvas.width * 0.35, y: canvas.height * 0.5 },
  }));
  const frame = page.locator('[data-canvas-stack]').getByRole('img', { name: 'Signature', exact: true }).locator('..');
  await expect(frame).toBeVisible();
  await expect(frame.locator('[data-handle]')).toHaveCount(8);
  const original = await bounds(frame);

  for (const handle of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']) {
    await frame.click();
    await expect(frame.locator('[data-handle]')).toHaveCount(8);
    // Deliberately include off-axis movement when testing an edge handle.
    const dx = handle.includes('w') ? -16 : 16;
    const dy = handle.includes('n') ? -12 : 12;
    await resize(page, frame, handle, dx, dy);
    const resized = await bounds(frame);
    if (handle === 'n' || handle === 's') {
      expect(resized.width).toBeCloseTo(original.width, 0);
      expect(resized.x).toBeCloseTo(original.x, 0);
      expect(resized.height).toBeGreaterThan(original.height + 5);
    } else if (handle === 'e' || handle === 'w') {
      expect(resized.height).toBeCloseTo(original.height, 0);
      expect(resized.y).toBeCloseTo(original.y, 0);
      expect(resized.width).toBeGreaterThan(original.width + 5);
    } else {
      expect(resized.width).toBeGreaterThan(original.width + 5);
      expect(resized.height).toBeGreaterThan(original.height + 5);
      expect(resized.width / resized.height).toBeCloseTo(original.width / original.height, 2);
    }
    await undo(page);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      await expect.poll(async () => Math.abs((await bounds(frame))[key] - original[key])).toBeLessThan(1);
    }
  }
  await undo(page);
  await expect(frame).toBeHidden();
  await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeDisabled();
  // Undo removes the placement, not the reusable library entry.
  await expect(card).toBeVisible();
});
