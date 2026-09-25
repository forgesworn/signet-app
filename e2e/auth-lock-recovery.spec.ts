import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, confirmRealNameIfPrompted } from './fixtures';

function buildAuthUrl(overrides?: { challenge?: string; timestamp?: number }) {
  const challenge = overrides?.challenge ?? 'a'.repeat(64);
  const timestamp = overrides?.timestamp ?? Math.floor(Date.now() / 1000);
  return `/?auth=1&challenge=${challenge}&origin=https://example.com&callback=https://example.com/callback&t=${timestamp}&name=TestSite`;
}

/**
 * Regression test for the "Identity keys are not yet decrypted — please unlock
 * first" strand: the app auto-locks (inactivity timer / 30s visibility-hidden
 * grace timer) while the "Sign in with Signet" approval screen is open, which
 * reverts the identity to public-only and destroys the signing backends. Before
 * the fix the screen kept rendering (npub + name are public) but every Approve
 * tap threw, with no way to re-unlock. The fix re-prompts unlock and signs.
 */
test.describe('Sign in with Signet — auto-lock recovery', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('already-running app consumes a QR-opened auth URL on first focus', async ({ page }) => {
    await page.evaluate(() => (window as any).__TEST__.setPage('settings-security'));
    await expect(page.getByRole('heading', { name: 'Security & Backup' })).toBeVisible({ timeout: 10_000 });

    await page.evaluate((url) => {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new Event('focus'));
    }, buildAuthUrl());

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('example.com wants to log you in')).toBeVisible();
  });

  test('auto-lock while on the approval screen does not strand the user', async ({ page }) => {
    await page.goto(buildAuthUrl());

    // Unlock to reach the approval screen.
    await unlockWithPin(page);
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });

    // The auto-lock that fires while the approval screen is open.
    await page.evaluate(() => (window as any).__TEST__.lock());

    // Fix: the approval screen re-prompts unlock the moment the lock lands,
    // instead of leaving a dead, locked-but-looks-unlocked screen.
    await unlockWithPin(page);
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeHidden({ timeout: 15_000 });

    // Back on the approval screen, now re-unlocked.
    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Identity keys are not yet decrypted')).toBeHidden();

    // Approve must SIGN and redirect back — not throw the locked-key error.
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });
    expect(page.url()).toContain('pubkey=');
    expect(page.url()).toContain('signature=');
  });
});
