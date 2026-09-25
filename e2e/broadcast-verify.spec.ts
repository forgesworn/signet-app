import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase } from './fixtures';

test.describe('BroadcastChannel same-device verify', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('verify request from another tab shows approval screen', async ({ page, context }) => {
    // Open a second page in the same browser context and same origin (BroadcastChannel requires same-origin)
    const sender = await context.newPage();
    await sender.goto('http://localhost:5174', { waitUntil: 'domcontentloaded' });

    // Post a valid verify request from the sender tab
    await sender.evaluate(() => {
      const channel = new BroadcastChannel('signet-verify-request');
      channel.postMessage({
        type: 'signet-verify-request',
        requestId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        requiredAgeRange: '18+',
        timestamp: Math.floor(Date.now() / 1000),
      });
      channel.close();
    });

    // The app tab should navigate to the approval screen
    // Without a stored credential, it shows the "get verified" prompt
    await expect(page.getByRole('heading', { name: 'Verify Age' })).toBeVisible({ timeout: 5_000 });

    await sender.close();
  });
});
