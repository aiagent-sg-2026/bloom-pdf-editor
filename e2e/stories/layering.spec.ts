/**
 * Persona: a designer exporting a synthetic illustration while an image is selected.
 * Goal: drawers, security UI, and dialogs must intercept input above canvas controls.
 * Steps: select image; open Export; inspect hit stacks; close; open Security; open a signature dialog.
 * Assertions: elementsFromPoint puts the frame, all eight handles, and Replace below the covering surface.
 * Security/dialog coexistence cases remain fixme: those tools currently unmount the image controls.
 */
import { test, expect, type Locator } from '@playwright/test';
import { openPdf, selectImage } from '../helpers/ui';

async function expectCovered(frame: Locator, cover: Locator) {
  const coverElements = await cover.elementHandles();
  if (!coverElements.length) throw new Error('Covering surface is missing');
  const controls = [frame, frame.getByTitle('Replace image (keep size)', { exact: true })];
  for (const handle of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']) controls.push(frame.locator(`[data-handle="${handle}"]`));
  for (const control of controls) {
    await expect(control).toBeVisible();
    await expect.poll(() => control.evaluate((element, covering) => {
      const rect = element.getBoundingClientRect();
      const stack = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const ownIndex = stack.indexOf(element);
      const coveringIndex = stack.findIndex(candidate => covering.some(surface => candidate === surface || surface.contains(candidate)));
      return ownIndex >= 0 && coveringIndex >= 0 && coveringIndex < ownIndex;
    }, coverElements)).toBe(true);
  }
  for (const element of coverElements) await element.dispose();
}

test('Export drawer and backdrop cover all selected image controls', async ({ page }) => {
  await openPdf(page, 'image.pdf');
  const frame = await selectImage(page);
  await page.getByTitle('Export to Word, PNG, Markdown, etc.', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Export Document', exact: true })).toBeVisible();
  // Export has no semantic container/backdrop selector; derive both from its existing heading.
  const drawer = page.getByRole('heading', { name: 'Export Document', exact: true })
    .locator('xpath=ancestor::div[@data-theme="dark"]');
  const backdrop = drawer.locator('xpath=preceding-sibling::div[1]');
  // Any point is covered by either the drawer or its full-screen backdrop.
  await expectCovered(frame, drawer.or(backdrop));
});

test('Security panel covers selected image controls', async ({ page }) => {
  test.fixme(true, 'EmbeddedImageOverlay is Select-only; choosing Security unmounts its frame, handles, and Replace toolbar.');
  await openPdf(page, 'image.pdf');
  const frame = await selectImage(page);
  // Mobile security has a full-screen backdrop, unlike the non-overlapping desktop sidebar.
  await page.setViewportSize({ width: 700, height: 1000 });
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await expect(page.getByText('Document Security', { exact: true })).toBeVisible();
  const panel = page.getByText('Document Security', { exact: true }).locator('..').locator('..').locator('..');
  await expectCovered(frame, panel.or(panel.locator('xpath=preceding-sibling::div[1]')));
});

test('Dialog backdrop covers selected image controls', async ({ page }) => {
  test.fixme(true, 'The signature dialog requires Sign mode; switching away from Select unmounts embedded image controls.');
  await openPdf(page, 'image.pdf');
  const frame = await selectImage(page);
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature', exact: true });
  await expect(dialog).toBeVisible();
  await expectCovered(frame, dialog.or(dialog.locator('xpath=preceding-sibling::div[1]')));
});
