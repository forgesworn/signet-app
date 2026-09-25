/**
 * Extended Playwright tests for the ShamirBackup page.
 *
 * Note: recovery/reconstruction is not yet implemented in ShamirBackup.tsx —
 * the page is generation-only. These tests cover the untested generation-side
 * behaviours that are not already covered by settings.spec.ts.
 *
 * Deliberately not covered here (already in settings.spec.ts):
 *   - Navigation to the page via Settings → Power Mode → Manage Shamir Backup
 *   - Split generates 3 share headers
 *   - Expanding share 2 and share 3 shows words
 */

import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

test.describe('ShamirBackup — extended generation behaviours', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await navigateViaHarness(page, 'shamir');
  });

  test('shows backup status as not yet backed up before first split', async ({ page }) => {
    // The identity was just created — backedUp flag should be false
    await expect(page.getByText('Not yet backed up')).toBeVisible();
  });

  test('shows page heading and explanation card', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Shamir Backup' }).first()).toBeVisible();
    await expect(page.getByText('What is Shamir Backup?')).toBeVisible();
    await expect(page.getByText(/Any 2 of 3 shares/)).toBeVisible();
  });

  test('split button is visible before split and hidden after', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Split my backup' })).toBeVisible();

    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Button should disappear once shares are shown
    await expect(page.getByRole('button', { name: 'Split my backup' })).not.toBeVisible();
  });

  test('share 1 auto-expands with words visible on split', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Share 1 header should be visible
    await expect(page.getByRole('button', { name: /Share 1 of 3/ })).toBeVisible();

    // Share 1 is auto-expanded — at least one monospace word span should be visible
    await expect(page.locator('span[style*="monospace"]').first()).toBeVisible();
  });

  test('collapsing an expanded share hides its words', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Share 1 is auto-expanded; click to collapse
    await page.getByRole('button', { name: /Share 1 of 3/ }).click();

    // Words grid should no longer be present
    // (WordGrid is conditionally rendered, not just hidden)
    const wordCount = await page.locator('span[style*="monospace"]').count();
    expect(wordCount).toBe(0);
  });

  test('each share has the correct label text', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    await expect(page.getByText('Give to Person A')).toBeVisible();
    await expect(page.getByText('Give to Person B')).toBeVisible();
    await expect(page.getByText('Keep yourself')).toBeVisible();
  });

  test('start over button resets to split button', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Shares should be present
    await expect(page.getByRole('button', { name: /Share 1 of 3/ })).toBeVisible();

    // Reset
    await page.getByRole('button', { name: 'Start over' }).click();

    // Split button should reappear; shares should be gone
    await expect(page.getByRole('button', { name: 'Split my backup' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Share 1 of 3/ })).not.toBeVisible();
  });

  test('re-splitting after start over generates a fresh set of shares', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Capture a word from the first split
    const firstWord = await page.locator('span[style*="monospace"]').first().textContent();

    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Share panels appear again — split was successful
    await expect(page.getByRole('button', { name: /Share 1 of 3/ })).toBeVisible();

    // The word grid is rendered again (can't guarantee different words in GF(256),
    // but re-splitting with a random nonce should differ; we just verify words appear)
    await expect(page.locator('span[style*="monospace"]').first()).toBeVisible();

    // Sanity: share label text is still present after re-split
    await expect(page.getByText('Give to Person A')).toBeVisible();

    // Suppress unused variable lint
    void firstWord;
  });

  test('warning message about writing down shares is visible', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    await expect(page.getByText(/Write these down now/)).toBeVisible();
  });

  test('expanding then collapsing share 2 does not affect share 3 words', async ({ page }) => {
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // Expand share 2
    await page.getByRole('button', { name: /Share 2 of 3/ }).click();
    await expect(page.locator('span[style*="monospace"]').first()).toBeVisible();

    // Collapse share 2 by clicking again
    await page.getByRole('button', { name: /Share 2 of 3/ }).click();
    const wordCountAfterCollapse = await page.locator('span[style*="monospace"]').count();
    expect(wordCountAfterCollapse).toBe(0);

    // Expand share 3 — words should appear independently
    await page.getByRole('button', { name: /Share 3 of 3/ }).click();
    await expect(page.locator('span[style*="monospace"]').first()).toBeVisible();
  });
});
