import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, navigateViaHarness, unlockWithPin, waitForDecryptedIdentity } from './fixtures';
import { privateRelays } from './helpers/private-relays';

test.beforeEach(async ({ page, context }) => {
  await privateRelays().install(context);
  await createIdentityAndUnlock(page, { name: 'Prompt Owner' });
});

test('recovery words require fresh authentication, with cancel and wrong PIN leaving them hidden', async ({ page }) => {
  await navigateViaHarness(page, 'settings-security');
  const reveal = page.getByRole('button', { name: 'View my recovery words' });
  await reveal.click();
  await expect(page.getByRole('heading', { name: 'Reveal your recovery words' })).toBeVisible();
  await expect(page.getByText(/Anyone with these words can recover your identity/)).toBeVisible();
  await expect(page.getByText('Your key — words 8 to 19')).toBeHidden();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reveal).toBeVisible();

  await reveal.click();
  await unlockWithPin(page, '999999');
  await expect(page.getByText('Incorrect PIN. Please try again.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reveal your recovery words' })).toBeVisible();
  await expect(page.getByText('Your key — words 8 to 19')).toBeHidden();
  await unlockWithPin(page);
  await expect(page.getByRole('heading', { name: 'Reveal your recovery words' })).toBeHidden();
  await expect(page.getByText('Your key — words 8 to 19')).toBeVisible();
});

test('deletion is named before authentication and its final confirmation stays gated', async ({ page }) => {
  await navigateViaHarness(page, 'settings');
  await page.getByRole('button', { name: /Power Mode/ }).click();
  const remove = page.getByRole('button', { name: 'Delete MySignet', exact: true });
  await remove.click();
  await expect(page.getByRole('heading', { name: 'Delete MySignet' })).toBeVisible();
  await expect(page.getByText(/This deletes all data from this device/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete forever' })).toBeHidden();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(remove).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete forever' })).toBeHidden();
  await remove.click();
  await unlockWithPin(page);
  await expect(page.getByRole('button', { name: 'Delete forever' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(remove).toBeVisible();
});

test('cold sign-in unlock describes review; cancellation does not approve the request', async ({ page }) => {
  let callbacks = 0;
  await page.route('https://example.com/callback**', route => {
    callbacks++;
    return route.fulfill({ body: 'Callback' });
  });
  const url = `/?auth=1&challenge=${'a'.repeat(64)}&origin=https://example.com&callback=https://example.com/callback&t=${Math.floor(Date.now() / 1000)}&name=ExampleApp`;
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Review sign-in request' })).toBeVisible();
  await expect(page.getByText('ExampleApp', { exact: true })).toBeVisible();
  await expect(page.getByText(/You can approve or decline it after unlocking/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review sign-in request' })).toBeHidden();
  await expect(page.getByText('Login Request')).toBeHidden();
  expect(callbacks).toBe(0);

  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Review sign-in request' })).toBeVisible();
  await unlockWithPin(page);
  await waitForDecryptedIdentity(page);
  await expect(page.getByText('Login Request')).toBeVisible();
  expect(callbacks).toBe(0);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.waitForURL(/example\.com\/callback/);
  expect(new URL(page.url()).searchParams.get('error')).toBe('denied');
  expect(callbacks).toBe(1);
});
