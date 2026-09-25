import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, navigateViaHarness } from './fixtures';

test.describe('one front door', () => {
  test('the welcome screen has exactly two doors plus the Lite link', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create my Signet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'I already have a Signet' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Signet Lite/ })).toHaveAttribute('href', 'https://lite.mysignet.app');
    await expect(page.getByRole('button', { name: /Try as a Guest/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Already on Nostr/i })).toHaveCount(0);
  });

  test('the nsec import lives behind the restore door', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await expect(page.getByRole('button', { name: /Import a Nostr key/ })).toBeVisible();
    await expect(page.getByText(/Signet Lite is lighter/)).toBeVisible();
  });

  test('creating a Signet takes one name and lands on the persona card', async ({ page }) => {
    const started = Date.now();
    await createIdentityAndUnlock(page, { name: 'Shade' });
    expect(Date.now() - started).toBeLessThan(60_000);
    await expect(page.getByText('Shade')).toBeVisible();
  });
});

test.describe('the real identity is dormant by default', () => {
  test('it has no carousel card', async ({ page }) => {
    await createIdentityAndUnlock(page, { name: 'Shade' });
    await expect(page.getByText('Natural Person')).toHaveCount(0);
  });

  test('Settings shows it as not set up, and activation gives it a card', async ({ page }) => {
    await createIdentityAndUnlock(page, { name: 'Shade' });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Personas/ }).click();
    await expect(page.getByText('Real identity — Not set up ›')).toBeVisible();

    await page.getByText('Real identity — Not set up ›').click();
    await page.getByPlaceholder('Your legal name').fill('Real Name');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByPlaceholder('Real Name').fill('Real Name');
    await page.getByRole('button', { name: 'Activate my real identity' }).click();

    // First backup: the words step gates Done behind the checkbox.
    await page.getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Personas/ }).click();
    await expect(page.getByText('Real identity — Real Name ›')).toBeVisible();
  });

  test('Get Verified shows the activation gate', async ({ page }) => {
    await createIdentityAndUnlock(page, { name: 'Shade' });
    // No direct "Get Verified" row exists in the Settings menu — Home's
    // "How verification works" card is the real affordance, and the dev
    // test harness is the same route home.spec.ts uses to reach it.
    await navigateViaHarness(page, 'get-verified');
    await expect(page.getByRole('button', { name: 'Activate my real identity' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible();
  });
});
