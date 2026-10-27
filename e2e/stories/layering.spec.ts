/**
 * Persona: a designer exporting a synthetic illustration while an image is selected.
 * Goal: drawers, security UI, and dialogs must intercept input above canvas controls.
 * Steps: select image; open Export; inspect hit stacks; close; open Security; open a signature dialog.
 * Assertions: Export covers controls; tool changes remove them and covering surfaces receive input.
 */
import { test, expect, type ElementHandle, type Locator, type Page } from '@playwright/test';
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

type CapturedControls = {
  elements: ElementHandle<SVGElement | HTMLElement>[];
  points: { x: number; y: number }[];
};

async function captureControls(frame: Locator) {
  const controls = [frame, frame.getByTitle('Replace image (keep size)', { exact: true })];
  for (const handle of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']) controls.push(frame.locator(`[data-handle="${handle}"]`));
  const elements = [];
  const points = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const element = await control.elementHandle();
    if (!element) throw new Error('Selected image control is missing');
    const box = await control.boundingBox();
    if (!box) throw new Error('Selected image control has no bounds');
    elements.push(element);
    points.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  return { elements, points };
}

async function expectRemovedAndCovered(page: Page, controls: CapturedControls, cover: Locator, backdrop: Locator) {
  for (const element of controls.elements) {
    expect(await element.evaluate(node => node.isConnected)).toBe(false);
    await element.dispose();
  }
  await expect(page.getByTitle('Replace image (keep size)', { exact: true })).toHaveCount(0);
  const surfaces = await cover.elementHandles();
  const backdrops = await backdrop.elementHandles();
  let clickPoint: { x: number; y: number } | undefined;
  let backdropPoint: { x: number; y: number } | undefined;
  for (const point of controls.points) {
    const hit = await page.evaluate(({ point, surfaces, backdrops }) => {
      const target = document.elementFromPoint(point.x, point.y);
      return {
        covered: surfaces.some(surface => surface === target || (target && surface.contains(target))),
        backdrop: backdrops.some(surface => surface === target || (target && surface.contains(target))),
      };
    }, { point, surfaces, backdrops });
    expect(hit.covered, `former control at ${JSON.stringify(point)} must hit a covering surface`).toBe(true);
    clickPoint ??= point;
    if (hit.backdrop) backdropPoint = point;
  }
  expect(clickPoint).toBeDefined();
  await page.evaluate(surfaces => {
    document.addEventListener('click', event => {
      const target = event.target as Node;
      document.documentElement.dataset.coverReceivedClick = String(surfaces.some(surface => surface === target || surface.contains(target)));
    }, { capture: true, once: true });
  }, surfaces);
  const point = backdropPoint ?? clickPoint!;
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.coverReceivedClick)).toBe('true');
  for (const element of [...surfaces, ...backdrops]) await element.dispose();
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

test('Security removes selected image controls and intercepts their positions', async ({ page }) => {
  await openPdf(page, 'image.pdf');
  const frame = await selectImage(page);
  // Mobile security has a full-screen backdrop, unlike the non-overlapping desktop sidebar.
  await page.setViewportSize({ width: 700, height: 1000 });
  const controls = await captureControls(frame);
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  const heading = page.getByText('Document Security', { exact: true });
  await expect(heading).toBeVisible();
  const panel = heading.locator('..').locator('..').locator('..');
  const backdrop = panel.locator('xpath=preceding-sibling::div[1]');
  await expectRemovedAndCovered(page, controls, panel.or(backdrop), backdrop);
  await expect(heading).toBeHidden();
});

test('Signature dialog removes selected image controls and intercepts their positions', async ({ page }) => {
  await openPdf(page, 'image.pdf');
  const frame = await selectImage(page);
  const controls = await captureControls(frame);
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature', exact: true });
  await expect(dialog).toBeVisible();
  const backdrop = dialog.locator('xpath=preceding-sibling::div[1]');
  await expectRemovedAndCovered(page, controls, dialog.or(backdrop), backdrop);
  // The dialog itself may occupy all former control positions.
});
