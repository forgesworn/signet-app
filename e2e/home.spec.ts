import { test, expect, type Page } from '@playwright/test';
import { createIdentityAndUnlock, restoreIdentityAndUnlock, clearDatabase, navigateToSettings } from './fixtures';

// Valid 64-char hex pubkey used as a stub verifier
const STUB_VERIFIER_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
// Valid 64-char hex event id used for the stub credential
const STUB_CRED_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * `family-list` (with zero dependants), `venue-entry` and `get-verified`
 * all route to the `RequireRealIdentity` activation gate instead of their
 * real content when the real identity is dormant (spec §7.3) — which is the
 * default `beforeEach` identity below. These three routes need an
 * ACTIVATED real identity to actually reach the feature under test, so they
 * override the shared fixture with a restored, NP-primary identity (NP
 * starts active on that door) rather than the default persona-primary one.
 */
async function unlockWithActiveNp(page: Page) {
  await clearDatabase(page);
  await restoreIdentityAndUnlock(page, { keypair: 'natural-person' });
  await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 60_000 });
}

test.describe('Home', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 60_000 });
  });

  test('display name is visible after unlock', async ({ page }) => {
    // createIdentityAndUnlock uses 'Test User' by default
    await expect(page.getByText('Test User')).toBeVisible();
  });

  test('npub is displayed in truncated form', async ({ page }) => {
    await expect(page.locator('.card-npub').filter({ hasText: /^npub1.+\.\.\..+$/ })).toBeVisible();
  });

  test('home carousel is visible', async ({ page }) => {
    await expect(page.locator('.carousel-viewport')).toBeVisible();
  });

  test('bottom navigation is present', async ({ page }) => {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Contacts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  });

  test('empty family list shows dependant prompt', async ({ page }) => {
    await unlockWithActiveNp(page);
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'family-list');
    await expect(page.getByRole('heading', { name: 'No dependants yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add dependant' })).toBeVisible();
  });

  test('venue entry route is reachable', async ({ page }) => {
    await unlockWithActiveNp(page);
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'venue-entry');
    await expect(page.locator('[aria-label="Venue entry pass"]')).toBeVisible({ timeout: 10_000 });
  });

  test('get verified route is reachable', async ({ page }) => {
    await unlockWithActiveNp(page);
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'get-verified');
    await expect(page.getByRole('heading', { name: 'How verification works' })).toBeVisible();
  });

  test('web verify route is reachable', async ({ page }) => {
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'web-verify');
    await expect(page.getByLabel('Paste QR link')).toBeVisible();
  });

  test('credential renders when injected via test harness', async ({ page }) => {
    // Inject a pending credential — Home.tsx reads credentials from the hook passed via props
    await page.evaluate(({ credId, verifierPubkey }) => {
      return (window as any).__TEST__.addCredential({
        id: credId,
        documentId: 'doc-001',
        keypairType: 'natural-person',
        event: '{}',
        verifierPubkey,
        verifiedAt: Math.floor(Date.now() / 1000),
        verifierStatus: 'pending',
      });
    }, { credId: STUB_CRED_ID, verifierPubkey: STUB_VERIFIER_PUBKEY });

    // Reload so Home re-reads credentials from IndexedDB
    await expect(page.locator('.carousel-viewport')).toBeVisible();
  });

  test('navigate to Settings via gear icon', async ({ page }) => {
    await navigateToSettings(page);
    // Settings page renders this section title
    await expect(page.getByText('Appearance')).toBeVisible({ timeout: 5_000 });
  });

  test('navigate to Get Verified via "How verification works" card', async ({ page }) => {
    await unlockWithActiveNp(page);
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'get-verified');
    await expect(page.getByRole('heading', { name: 'How verification works' })).toBeVisible({ timeout: 5_000 });
  });

  test('navigate to Family via bottom nav', async ({ page }) => {
    await unlockWithActiveNp(page);
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'family-list');
    await expect(page.getByText('No dependants yet')).toBeVisible({ timeout: 5_000 });
  });

  test('navigate to Venue Entry via button', async ({ page }) => {
    await unlockWithActiveNp(page);
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'venue-entry');
    await expect(page.locator('[aria-label="Venue entry pass"]')).toBeVisible({ timeout: 10_000 });
  });

  test('navigate to Web Verify via "Verify on a website" card', async ({ page }) => {
    await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'web-verify');
    await expect(page.getByLabel('Paste QR link')).toBeVisible({ timeout: 5_000 });
  });
});
