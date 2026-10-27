/**
 * Persona: a reviewer filling in a synthetic practice form.
 * Goal: save a field value that both viewers and form processors can read.
 * Steps: upload; select the field in Options; type a replacement; download.
 * Assertions: /V (read through pdf-lib) and the visible appearance's extracted text agree.
 */
import { test, expect } from '@playwright/test';
import { download, openPdf, renderAfter } from '../helpers/ui';
import { extractText, inspectPdf, requirePoppler } from '../helpers/pdf';

test('fill a text field and preserve its appearance and value', async ({ page }, info) => {
  requirePoppler('pdftotext');
  await openPdf(page, 'form.pdf');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'synthetic_note Tx', exact: true }).click();
  const value = page.getByRole('textbox');
  await expect(value).toHaveValue('Draft');
  await renderAfter(page, async () => {
    await value.fill('Reviewed synthetic entry');
    await value.press('Tab');
  });
  await expect(value).toHaveValue('Reviewed synthetic entry');
  const exported = await download(page, info);
  expect((await inspectPdf(exported)).fields.synthetic_note).toBe('Reviewed synthetic entry');
  expect(extractText(exported)).toContain('Reviewed synthetic entry');
  expect(extractText(exported)).not.toContain('Draft');
});
