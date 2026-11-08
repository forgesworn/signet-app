import { test, expect } from '@playwright/test';
import { activateRealIdentity, createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

test.describe('Venue Entry', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    // The venue pass is signed by the real identity, which starts dormant: the
    // route shows the activation gate until it is activated.
    await navigateViaHarness(page, 'venue-entry');
    await activateRealIdentity(page);
  });

  test('QR code displayed with correct payload', async ({ page }) => {
    await navigateViaHarness(page, 'venue-entry');

    const payload = page.getByTestId('qr-payload');
    await expect(payload).toBeVisible({ timeout: 10_000 });

    const payloadText = await payload.textContent();
    expect(payloadText).toBeTruthy();
    const event = JSON.parse(payloadText!);
    expect(event.kind).toBe(21235);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['t', 'signet-venue-entry']),
      ]),
    );
    expect(event.sig).toBeTruthy();
  });

  test('countdown timer is visible', async ({ page }) => {
    await navigateViaHarness(page, 'venue-entry');

    const arc = page.getByLabel(/seconds until refresh/);
    await expect(arc).toBeVisible({ timeout: 10_000 });
  });

  // The harness's setPage() jump pushes no history entry, so navigateBack()
  // would pop to whatever the activation steps left below. Reset the app's own
  // history depth to its bottom first: a page reached with nothing below it
  // goes straight home on Back (useNavigation).
  test('back navigation returns to home', async ({ page }) => {
    await page.evaluate(() => window.history.replaceState({ page: 'home', depth: 0 }, ''));
    await navigateViaHarness(page, 'venue-entry');
    await page.getByRole('button', { name: 'Back to home' }).click();
    await expect(page.locator('.carousel-viewport')).toBeVisible();
  });
});
