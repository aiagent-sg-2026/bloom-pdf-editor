/**
 * Persona: a teacher annotating a synthetic practice handout.
 * Goal: highlight a line, sketch a pen mark, and erase it without losing undo history.
 * Steps: upload; highlight text; draw a pen stroke; erase the stroke; undo erase, pen, highlight.
 * Assertions: rendered exports differ for each edit; undo restores the exact prior visible page.
 */
import { test, expect } from '@playwright/test';
import { download, drag, openPdf, pagePoint, renderAfter, undo } from '../helpers/ui';
import { renderedFingerprint, requirePoppler } from '../helpers/pdf';

test('annotate, erase, and recover the original page', async ({ page }, info) => {
  requirePoppler('pdftoppm');
  await openPdf(page);
  const original = renderedFingerprint(await download(page, info, 'original'));

  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  const text = await pagePoint(page, 110, 82);
  await renderAfter(page, () => page.mouse.click(text.x, text.y));
  await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeEnabled();
  const highlighted = renderedFingerprint(await download(page, info, 'highlighted'));
  expect(highlighted).not.toBe(original);

  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.getByTitle('Freehand', { exact: true }).click();
  const penStart = await pagePoint(page, 120, 220);
  const penEnd = await pagePoint(page, 260, 250);
  await renderAfter(page, () => drag(page, penStart, penEnd));
  const ink = renderedFingerprint(await download(page, info, 'pen'));
  expect(ink).not.toBe(highlighted);

  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  const eraseStart = await pagePoint(page, 180, 215);
  const eraseEnd = await pagePoint(page, 180, 260);
  await renderAfter(page, () => drag(page, eraseStart, eraseEnd));
  const erased = renderedFingerprint(await download(page, info, 'erased'));
  expect(erased).toBe(highlighted);

  await undo(page);
  expect(renderedFingerprint(await download(page, info, 'undo-erase'))).toBe(ink);
  await undo(page);
  expect(renderedFingerprint(await download(page, info, 'undo-pen'))).toBe(highlighted);
  await undo(page);
  expect(renderedFingerprint(await download(page, info, 'undo-highlight'))).toBe(original);
  await expect(page.getByTitle('Undo (Ctrl+Z)', { exact: true })).toBeDisabled();
});
