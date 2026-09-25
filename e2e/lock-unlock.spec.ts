import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, lockApp, unlockApp } from './fixtures';

test.describe('Lock and Unlock', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('PIN unlock after lock', async ({ page }) => {
    await lockApp(page);
    await unlockApp(page);
    await expect(page.getByText('Test User')).toBeVisible();
  });

  test('wrong PIN rejected', async ({ page }) => {
    await lockApp(page);

    // Switch to PIN if needed
    const pinButton = page.getByRole('button', { name: 'Use PIN instead' });
    if (await pinButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await pinButton.click();
    }

    // Enter wrong PIN
    for (const digit of '999999') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Wait for PBKDF2 to finish
    await expect(page.getByText(/Incorrect PIN/i)).toBeVisible({ timeout: 15_000 });
  });

  test('lockout after 5 failed PIN attempts', async ({ page }) => {
    await lockApp(page);

    // Switch to PIN if needed
    const pinButton = page.getByRole('button', { name: 'Use PIN instead' });
    if (await pinButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await pinButton.click();
    }

    // Enter wrong PIN 5 times
    for (let attempt = 0; attempt < 5; attempt++) {
      for (const digit of '999999') {
        await page.getByRole('button', { name: digit, exact: true }).click();
      }
      if (attempt < 4) {
        // Wait for error then PIN to clear before next attempt
        await expect(page.getByText(/Incorrect PIN/i)).toBeVisible({ timeout: 15_000 });
      }
    }

    // After 5 failed attempts, should show lockout message
    await expect(page.getByText(/Too many failed attempts/i)).toBeVisible({ timeout: 15_000 });
  });

  test('visibility change locks app', async ({ page }) => {
    // Verify we're on home
    await expect(page.getByText('Test User')).toBeVisible();

    await lockApp(page);
    await expect(page.getByText(/Enter your PIN|Unlock Signet/)).toBeVisible();
  });
});
