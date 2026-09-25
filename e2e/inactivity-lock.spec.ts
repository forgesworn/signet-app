import { test, expect, type Page } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase } from './fixtures';

// Short inactivity timeout for testing (2s instead of 15min)
const TEST_TIMEOUT_MS = 2000;

async function setTestInactivityTimeout(page: Page, ms = TEST_TIMEOUT_MS) {
  await page.evaluate((t) => (window as any).__TEST__.setInactivityTimeout(t), ms);
  // Trigger a mouse move so the running timer is reset with the new value
  await page.mouse.move(200, 200);
}

test.describe('Inactivity auto-lock', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('locks after the inactivity timeout expires', async ({ page }) => {
    await setTestInactivityTimeout(page);

    await page.waitForTimeout(TEST_TIMEOUT_MS + 1000);

    await expect.poll(async () => page.evaluate(() => (window as any).__TEST__.isLocked())).toBe(true);
  });

  test('interaction resets the inactivity timer', async ({ page }) => {
    const timeout = 3000;
    await setTestInactivityTimeout(page, timeout);

    // Advance to just before the timeout — still unlocked
    await page.waitForTimeout(timeout - 500);
    await expect(page.locator('.carousel-viewport')).toBeVisible();
    await expect.poll(async () => page.evaluate(() => (window as any).__TEST__.isLocked())).toBe(false);

    // Interact — resets the timer to another full timeout from now
    await page.mouse.move(300, 300);

    // Advance past the original deadline — still unlocked (timer was reset)
    await page.waitForTimeout(timeout - 500);
    await expect(page.locator('.carousel-viewport')).toBeVisible();
    await expect.poll(async () => page.evaluate(() => (window as any).__TEST__.isLocked())).toBe(false);

    // Advance past the reset deadline — now locked
    await page.waitForTimeout(timeout + 500);
    await expect.poll(async () => page.evaluate(() => (window as any).__TEST__.isLocked())).toBe(true);
  });
});
