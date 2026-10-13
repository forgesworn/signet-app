import { test, expect } from '@playwright/test';
import { navigateViaHarness, restoreIdentityAndUnlock } from './fixtures';
import { privateRelays } from './helpers/private-relays';
test.use({ actionTimeout: 15_000 });

test('hands a dependant directory to a fresh recovery identity and keeps only a read-only family archive', async ({ page, context, browser }) => {
  test.setTimeout(240_000);
  const network = privateRelays();
  await network.install(context);
  await restoreIdentityAndUnlock(page);
  await navigateViaHarness(page, 'add-dependant');
  await page.getByLabel(/Their name/i).fill('Independent Sam');
  await page.getByRole('button', { name: "I'll hold their keys", exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /written these down somewhere safe/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('checkbox', { name: /written these down somewhere safe/ }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(/Independent Sam's identity is ready/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /Done for now/ }).click();
  await navigateViaHarness(page, 'family-list');
  await page.getByRole('button', { name: /Independent Sam/ }).click();
  // The family-list selection scopes contact creation to Sam's directory.
  await navigateViaHarness(page, 'contact-new');
  await page.getByLabel('Name', { exact: true }).fill('Sam friend');
  await page.getByRole('button', { name: 'Kin', exact: true }).click();
  await page.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(page.getByText('Sam friend', { exact: true }).first()).toBeVisible();
  await navigateViaHarness(page, 'transition-ceremony');
  await page.getByRole('button', { name: 'Begin ceremony', exact: true }).click();
  await page.getByRole('button', { name: /Remove guardian authority/ }).click();
  await page.getByRole('button', { name: /Generate independent keys/ }).click();
  // Both word preparation and final handover require fresh presence.
  for (const digit of '123456') await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /I have written down/ })).toBeVisible({ timeout: 30_000 });
  const recoveryWords = (await page.locator('[data-word-index] > span:last-child').allTextContents()).join(' ');
  expect(recoveryWords.split(' ')).toHaveLength(19);
  await page.getByRole('checkbox', { name: /I have written down/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Trust for Sam friend' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('combobox', { name: 'Trust for Sam friend' }).selectOption('kith');
  await page.getByRole('radio', { name: 'Keep a read-only encrypted archive' }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm ceremony', exact: true }).click();
  for (const digit of '123456') await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByText('Ceremony complete', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await navigateViaHarness(page, 'family-list');
  await expect(page.getByRole('button', { name: /Independent Sam/ })).toHaveCount(0);
  await page.getByText('Independent Sam — read-only archive', { exact: true }).click();
  await expect(page.getByText('Sam friend — kin', { exact: false })).toBeVisible();

  const fresh = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(fresh);
    const independent = await fresh.newPage();
    await restoreIdentityAndUnlock(independent, { words: recoveryWords, name: 'Independent Sam' });
    await navigateViaHarness(independent, 'contacts');
    await expect(independent.getByText('Sam friend', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(independent.getByText('Kith', { exact: true }).first()).toBeVisible();
  } finally { await fresh.close(); }
});
