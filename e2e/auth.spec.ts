import { test, expect, type Page } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, confirmRealNameIfPrompted, navigateViaHarness } from './fixtures';
import { verifyEvent } from 'nostr-tools/pure';

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
    // Reconstruct the event exactly as a redirect consumer does (signet-login
    // redirect.ts, vitark signin-proof.ts): challenge and origin, no app tag.
    // The relay path carries the app tag instead; see cross-device-auth.spec.ts.
    const params = new URL(url).searchParams;
    expect(verifyEvent({
      pubkey: params.get('pubkey')!, kind: 21236,
      created_at: Number(params.get('t')), content: '',
      tags: [['challenge', 'a'.repeat(64)], ['origin', 'https://example.com']],
      id: params.get('eventId')!, sig: params.get('signature')!,
    })).toBe(true);
  });

  test('deny auth redirects with error=denied', async ({ page }) => {
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    expect(page.url()).toContain('error=denied');
  });

  /** The knownPlaces rows in IndexedDB, read without the encryption key (routing metadata is in clear). */
  async function readKnownPlaces(page: Page): Promise<Array<{ origin?: string; pubkey: string; kind: string }>> {
    return page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('my-signet');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const req = db.transaction('knownPlaces', 'readonly').objectStore('knownPlaces').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    }));
  }

  test('approved site is recorded as a known place, not on the Connected apps page', async ({ page }) => {
    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    // Return to the app. Guardian auth is on-demand: a plain reload shows Home
    // (locked) with no unlock prompt.
    await page.goto('/');
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });

    const places = await readKnownPlaces(page);
    expect(places.some(p => p.kind === 'sign-in' && p.origin === 'https://example.com')).toBe(true);

    // The Connected apps page lists Nostr Connect clients and phone apps only.
    await navigateViaHarness(page, 'connections');
    await expect(page.getByText('No connected apps')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Forget', exact: true })).toHaveCount(0);
  });

  test('the place is saved before the redirect leaves the page', async ({ page }) => {
    // Hold the place's write transaction open briefly. Redirecting before
    // tx.done used to abort it and lose the row.
    await page.addInitScript(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
        const tx = original.apply(this, args);
        const names = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]);
        if (args[1] === 'readwrite' && names.includes('knownPlaces')) {
          const store = tx.objectStore('knownPlaces');
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

    await page.goto(buildAuthUrl());
    await unlockWithPin(page);

    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 15_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });

    await page.goto('/');
    await expect(page.getByText('Test User')).toBeVisible({ timeout: 15_000 });
    const places = await readKnownPlaces(page);
    expect(places.some(p => p.kind === 'sign-in' && p.origin === 'https://example.com')).toBe(true);
  });
});
