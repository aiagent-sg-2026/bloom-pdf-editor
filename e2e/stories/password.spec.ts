/**
 * Persona: an author sharing a synthetic handout through a password-protected file.
 * Goal: require the open password without losing the document contents.
 * Steps: upload; Security > Protect; encrypt; download; upload the export; enter the password.
 * Assertions: independent extraction requires the password; the editor prompts and reopens two pages.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { download, openPdf, uploadPdf, waitForEditor } from '../helpers/ui';
import { extractText, requirePoppler } from '../helpers/pdf';

test('protect a document and reopen it with the password', async ({ page }, info) => {
  requirePoppler('pdftotext');
  await openPdf(page);
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Protect', exact: true }).click();
  const password = 'synthetic-open-42';
  await page.getByPlaceholder('Optional open password').fill(password);
  await page.getByPlaceholder('Required for permissions').fill('synthetic-owner-42');
  await page.getByRole('button', { name: 'Encrypt PDF', exact: true }).click();
  await expect(page.getByText('Document encrypted', { exact: true })).toBeVisible();
  const exported = await download(page, info, 'protected');
  expect(() => execFileSync('pdftotext', [exported, '-'], { stdio: 'pipe' })).toThrow();
  expect(extractText(exported, password)).toContain('Synthetic sample');

  // Upload through the same public file picker, not IndexedDB or an engine API.
  await uploadPdf(page, exported);
  await expect(page.getByRole('heading', { name: 'Password required' })).toBeVisible();
  await page.getByLabel('Document password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await waitForEditor(page);
  await expect(page.getByRole('heading', { name: 'Password required' })).toBeHidden();
  await expect(page.getByRole('img', { name: /^Page \d+$/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  // Re-exporting the reopened file also proves its decrypted contents survived parsing.
  expect(extractText(await download(page, info, 'reopened'), password)).toContain('Second synthetic page');
});
