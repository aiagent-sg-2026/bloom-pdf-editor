/**
 * Persona: a workshop organizer preparing a synthetic handout.
 * Goal: insert a notes page, rotate the cover, and remove the unwanted last page.
 * Steps: upload; insert a blank first page; rotate original page one; delete original page two; download.
 * Assertions: exported page counts change 2 -> 3 -> 2; retained cover is landscape; notes page is blank.
 */
import { test, expect } from '@playwright/test';
import { download, openPdf, renderAfter } from '../helpers/ui';
import { extractText, inspectPdf, requirePoppler } from '../helpers/pdf';

test('organize pages for a handout', async ({ page }, info) => {
  requirePoppler('pdftotext');
  await openPdf(page);
  await expect(page.getByRole('img', { name: /^Page \d+$/ })).toHaveCount(2);
  await renderAfter(page, () => page.getByRole('button', { name: 'Insert blank page', exact: true }).first().click());
  await expect(page.getByRole('img', { name: /^Page \d+$/ })).toHaveCount(3);
  expect((await inspectPdf(await download(page, info, 'inserted'))).pages).toHaveLength(3);

  const cover = page.getByRole('img', { name: 'Page 2', exact: true }).locator('..').locator('..');
  await cover.hover();
  await renderAfter(page, () => cover.getByRole('button', { name: 'Rotate page 2', exact: true }).click());
  const rotated = await inspectPdf(await download(page, info, 'rotated'));
  expect(rotated.pages[1].rotation % 360).toBe(90);

  const last = page.getByRole('img', { name: 'Page 3', exact: true }).locator('..').locator('..');
  await last.hover();
  page.once('dialog', dialog => dialog.accept());
  await renderAfter(page, () => last.getByRole('button', { name: 'Delete page', exact: true }).click());
  await expect(page.getByRole('img', { name: /^Page \d+$/ })).toHaveCount(2);
  const exported = await download(page, info, 'organized');
  const { pages } = await inspectPdf(exported);
  expect(pages).toHaveLength(2);
  expect(pages[0]).toEqual({ width: 612, height: 792, rotation: 0 });
  expect(pages[1].rotation % 360).toBe(90);
  // A quarter-turn swaps displayed width and height, retaining the letter media box.
  expect(pages[1].height).toBeGreaterThan(pages[1].width);
  const textPages = extractText(exported).split('\f');
  expect(textPages[0].trim()).toBe('');
  expect(textPages[1]).toContain('Synthetic sample');
  expect(extractText(exported)).not.toContain('Second synthetic page');
});
