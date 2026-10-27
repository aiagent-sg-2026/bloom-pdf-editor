/**
 * Persona: an author correcting a synthetic handout.
 * Goal: replace one word without recreating the PDF.
 * Steps: upload; enter text editing; double-click a word; type; commit; download.
 * Assertions: the exported text contains the replacement and preserves the other word/page.
 */
import { test, expect } from '@playwright/test';
import { download, openPdf, pagePoint, renderAfter } from '../helpers/ui';
import { extractText, requirePoppler } from '../helpers/pdf';

test('correct a word and send the edited handout', async ({ page }, info) => {
  requirePoppler('pdftotext');
  await openPdf(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const word = await pagePoint(page, 110, 82);
  // First double-click enters the line editor; the second selects its word.
  await page.mouse.dblclick(word.x, word.y);
  const editor = page.getByRole('textbox', { name: 'Edit line', exact: true });
  await expect(editor).toBeFocused();
  await page.mouse.dblclick(word.x, word.y);
  await expect.poll(() => editor.evaluate((element: HTMLTextAreaElement) =>
    element.value.slice(element.selectionStart, element.selectionEnd))).toBe('Synthetic');
  await page.keyboard.type('Revised');
  await renderAfter(page, () => page.keyboard.press('Enter'));
  await expect(editor).toBeHidden();
  const text = extractText(await download(page, info));
  expect(text).toContain('Revised sample');
  expect(text).toContain('Second synthetic page');
  expect(text).not.toContain('Synthetic sample');
});
