import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

test.describe('Venue Entry', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
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

  // FIXME: "Back to home" relies on navigation history that the test-harness
  // setPage() jump bypasses, so back-nav doesn't land on the home carousel here.
  // Needs a rewrite once a harness nav-stack hook exists. Tracked in the E2E-rot issue.
  test.fixme('back navigation returns to home', async ({ page }) => {
    await navigateViaHarness(page, 'venue-entry');
    await page.getByRole('button', { name: 'Back to home' }).click();
    await expect(page.locator('.carousel-viewport')).toBeVisible();
  });
});
