import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, confirmRealNameIfPrompted, navigateViaHarness } from './fixtures';

function buildAuthUrl(overrides?: { challenge?: string; timestamp?: number }) {
  const challenge = overrides?.challenge ?? 'a'.repeat(64);
  const timestamp = overrides?.timestamp ?? Math.floor(Date.now() / 1000);
  return `/?auth=1&challenge=${challenge}&origin=https://example.com&callback=https://example.com/callback&t=${timestamp}&name=TestSite`;
}

test.describe('Sign in with Signet', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('URL auth shows approval screen', async ({ page }) => {
    // Navigate with auth params — app reads URL params on mount, shows auth screen
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    // After unlock, should show approve auth screen
    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('example.com')).toBeVisible();
  });

  test('expired timestamp is ignored', async ({ page }) => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    await page.goto(buildAuthUrl({ timestamp: tenMinutesAgo }));

    // Expired request is rejected → no pending action. Guardian auth is
    // on-demand, so a plain load shows Home (locked), not an unlock prompt or
    // the approval screen.
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Login Request')).toBeHidden();
  });

  test('approve auth redirects with pubkey and signature', async ({ page }) => {
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });

    // requireNpConfirmation (default-on) gates the real-name Approve.
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    const url = page.url();
    expect(url).toContain('pubkey=');
    expect(url).toContain('signature=');
    expect(url).toContain('npub=');
  });

  test('deny auth redirects with error=denied', async ({ page }) => {
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    expect(page.url()).toContain('error=denied');
  });

  test('approved site appears in connections', async ({ page }) => {
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    // Return to the app. Guardian auth is on-demand: a plain reload shows Home
    // (locked) with no unlock prompt; the connections view reads local state and
    // doesn't require unlock.
    await page.goto('/');
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });

    // Connections need no encryption key; the locked Home has no Settings button,
    // so reach the page via the test harness.
    await navigateViaHarness(page, 'connections');

    // Approved site should appear — "Revoke" button is inside the visible card
    await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible({ timeout: 15_000 });
  });

  test('revoke connection removes site', async ({ page }) => {
    // Hold the connection's write transaction open briefly. Redirecting before
    // tx.done used to abort it and lose the row the user needs for revocation.
    await page.addInitScript(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
        const tx = original.apply(this, args);
        const names = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]);
        if (args[1] === 'readwrite' && names.includes('authorizedSites')) {
          const store = tx.objectStore('authorizedSites');
          const until = performance.now() + 500;
          const hold = () => {
            if (performance.now() >= until) return;
            try { store.get('__test_keep_transaction_alive__').onsuccess = hold; } catch { /* transaction already settled */ }
          };
          hold();
        }
        return tx;
      };
    });

    // Approve a site first
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    // Return to the app (on-demand auth: locked Home, no unlock prompt).
    await page.goto('/');
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });

    // Go to connections (via harness — locked Home has no Settings) and revoke
    await navigateViaHarness(page, 'connections');
    await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Revoke' }).click();
    // Revoke is a two-step confirm.
    await page.getByRole('button', { name: 'Confirm' }).click();

    // After revoke, should show empty state
    await expect(page.getByText('No connected sites')).toBeVisible();
  });
});
