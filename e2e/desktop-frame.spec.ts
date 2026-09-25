import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, confirmRealNameIfPrompted } from './fixtures';

test.describe('Desktop phone-frame (wide viewport)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test('renders the framed app with arrows on home; up disabled at first identity', async ({ page }) => {
    await createIdentityAndUnlock(page);
    await confirmRealNameIfPrompted(page);
    await expect(page.locator('.desk--wide')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous card' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next card' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous identity' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next identity' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous identity' })).toBeDisabled();
  });

  test('hides arrows on non-carousel pages (Settings)', async ({ page }) => {
    await createIdentityAndUnlock(page);
    await confirmRealNameIfPrompted(page);
    // Scope to the Primary nav so the tab button is unambiguous (the arrows in
    // .desk-stage live outside the nav, so this doesn't affect them).
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.desk--wide')).toBeVisible();
    await expect(page.locator('.desk-arrow')).toHaveCount(0);
  });
});

test.describe('Mobile (narrow viewport) is unframed', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('no desk frame and no arrows on mobile', async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await confirmRealNameIfPrompted(page);
    await expect(page.locator('.desk--wide')).toHaveCount(0);
    await expect(page.locator('.desk-arrow')).toHaveCount(0);
  });
});
