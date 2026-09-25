import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, navigateToSettings } from './fixtures';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await navigateToSettings(page);
  });

  test('Settings menu shows Profile, Personas, Security & Backup, Connections in order', async ({ page }) => {
    // D10 (UX polish) moved the primary nav items into a single
    // `.card-flush` list of `.row-button` rows — the old
    // `button.btn-secondary` locator no longer matches them.
    const labels = await page.locator('.card-flush .row-button .row-label').allTextContents();
    const expected = ['Profile', 'Personas', 'Security & Backup', 'Connections'];
    let lastIdx = -1;
    for (const label of expected) {
      const idx = labels.findIndex(l => l.includes(label));
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test('Settings menu does NOT show Child Accounts', async ({ page }) => {
    await expect(page.getByText(/Child Accounts/)).toHaveCount(0);
    await expect(page.getByText(/Manage linked children/)).toHaveCount(0);
  });

  test('view backup shows 19 recovery words', async ({ page }) => {
    await page.getByRole('button', { name: /Security/ }).first().click();
    await page.getByRole('button', { name: 'View my recovery words' }).click();

    // SecuritySettings prompts for fresh auth before revealing mnemonic — enter the PIN
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Verify all 19 numbered word slots are present (7 header + 12 payload)
    for (let i = 1; i <= 19; i++) {
      await expect(page.locator('span').filter({ hasText: new RegExp(`^${i}$`) }).first()).toBeVisible();
    }
  });

  test('theme toggle changes appearance', async ({ page }) => {
    await page.getByRole('button', { name: 'Dark' }).click();

    // Verify the data-theme attribute was set on the document element
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');

    // Switch to Light and verify
    await page.getByRole('button', { name: 'Light' }).click();
    const lightTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(lightTheme).toBe('light');

    // Switch to System and verify attribute is removed
    await page.getByRole('button', { name: 'System' }).click();
    const systemTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(systemTheme).toBeNull();
  });

  test('power mode reveals Advanced entry', async ({ page }) => {
    await page.getByRole('button', { name: /Power Mode/ }).click();
    await expect(page.getByText('Advanced', { exact: false }).first()).toBeVisible();
  });

  test('power mode Advanced contains bridge and relay', async ({ page }) => {
    await page.getByRole('button', { name: /Power Mode/ }).click();
    await page.getByRole('button', { name: /Advanced/ }).click();
    await expect(page.getByText('Identity Bridge', { exact: true })).toBeVisible();
    await expect(page.getByText('Relays', { exact: true })).toBeVisible();
  });

  test('connected sites shows empty state', async ({ page }) => {
    await page.getByRole('button', { name: /Connections/ }).click();
    await expect(page.getByText('No connected sites')).toBeVisible();
  });

  test('relay URL editing persists', async ({ page }) => {
    await page.getByRole('button', { name: /Power Mode/ }).click();
    await page.getByRole('button', { name: /Advanced/ }).click();
    const relaySection = page.locator('.card').filter({ has: page.getByText('Relays', { exact: true }) }).first();
    await relaySection.getByPlaceholder('wss://relay.example.com').fill('wss://relay.trotters.cc');
    await relaySection.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('relay.trotters.cc')).toBeVisible();

    // Navigate away and back to verify persistence — Power Mode is still on from above
    await page.getByRole('button', { name: 'Go back' }).click();
    await navigateToSettings(page);
    // Power Mode stays enabled (React state persists within the session)
    await page.getByRole('button', { name: /Advanced/ }).click();
    await expect(page.getByText('relay.trotters.cc')).toBeVisible();
  });

  test('identity bridge shows content and coming soon', async ({ page }) => {
    await page.getByRole('button', { name: /Power Mode/ }).click();
    await page.getByRole('button', { name: /Advanced/ }).click();
    await page.getByRole('button', { name: 'Open Identity Bridge' }).click();

    // A bridge links the real identity to the persona, so a dormant real
    // identity meets the activation gate first (persona-first spec §7.3).
    await expect(page.getByRole('button', { name: 'Activate my real identity' })).toBeVisible();
    await page.getByRole('button', { name: 'Activate my real identity' }).click();
    await page.getByPlaceholder('Your legal name').fill('Real Name');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByPlaceholder('Real Name').fill('Real Name');
    await page.getByRole('button', { name: 'Activate my real identity' }).click();
    await page.getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Done' }).click();

    // Verify page content
    await expect(page.getByRole('heading', { name: 'Identity Bridge' })).toBeVisible();
    await expect(page.getByText('What is an Identity Bridge?')).toBeVisible();
    await expect(page.getByText('Your Identities')).toBeVisible();
    await expect(page.getByText('Natural Person').first()).toBeVisible();
    await expect(page.getByText('Anonymous Persona').first()).toBeVisible();

    // Click Learn more -> Coming soon
    await page.getByRole('button', { name: 'Learn more' }).click();
    await expect(page.getByText('Coming soon')).toBeVisible();

    // Dismiss returns to Learn more button
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('button', { name: 'Learn more' })).toBeVisible();
  });

  test('invalid relay URL keeps save disabled', async ({ page }) => {
    await page.getByRole('button', { name: /Power Mode/ }).click();
    await page.getByRole('button', { name: /Advanced/ }).click();
    const relaySection = page.locator('.card').filter({ has: page.getByText('Relays', { exact: true }) }).first();

    // Enter invalid URL (http:// instead of wss://)
    await relaySection.getByPlaceholder('wss://relay.example.com').fill('http://evil.com');
    await expect(relaySection.getByRole('button', { name: 'Add' })).toBeDisabled();

    // Enter valid wss:// URL and verify save becomes enabled
    await relaySection.getByPlaceholder('wss://relay.example.com').fill('wss://relay.valid.example');
    await expect(relaySection.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  test('shamir backup navigates (now in Security & Backup)', async ({ page }) => {
    await page.getByRole('button', { name: /Security/ }).first().click();
    await page.getByRole('button', { name: 'Manage Shamir Backup' }).click();
    await expect(page.getByRole('heading', { name: /Shamir/ }).first()).toBeVisible();
  });

  test('shamir split generates 3 shares with words', async ({ page }) => {
    await page.getByRole('button', { name: /Security/ }).first().click();
    await page.getByRole('button', { name: 'Manage Shamir Backup' }).click();
    await expect(page.getByRole('heading', { name: /Shamir/ }).first()).toBeVisible();

    // Trigger the split
    await page.getByRole('button', { name: 'Split my backup' }).click();

    // All 3 share headers should appear
    await expect(page.getByRole('button', { name: 'Share 1 of 3' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share 2 of 3' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share 3 of 3' })).toBeVisible();

    // Share 1 is auto-expanded — verify monospace word elements are visible
    const share1Words = page.locator('span[style*="font-mono"]').first();
    await expect(share1Words).toBeVisible();

    // Expand Share 2 and verify words appear
    await page.getByRole('button', { name: 'Share 2 of 3' }).click();
    await expect(page.locator('span[style*="font-mono"]').first()).toBeVisible();

    // Expand Share 3 and verify words appear
    await page.getByRole('button', { name: 'Share 3 of 3' }).click();
    await expect(page.locator('span[style*="font-mono"]').first()).toBeVisible();
  });

  test('personas page lists keypairs', async ({ page }) => {
    await page.getByRole('button', { name: /Personas/ }).click();
    await expect(page.getByRole('heading', { name: 'Personas' })).toBeVisible();
    await expect(page.getByText('Real identity', { exact: true })).toBeVisible();
    await expect(page.getByText('Anonymous keypairs', { exact: true })).toBeVisible();
    await expect(page.getByText('Default persona', { exact: false })).toBeVisible();
  });

  test('change security tier persists', async ({ page }) => {
    await page.getByRole('button', { name: /Security/ }).first().click();
    await page.getByRole('button', { name: /Standard/ }).click();
    await expect(page.getByRole('button', { name: /Standard/ })).toHaveClass(/btn-tile-selected/);

    // Navigate away and back to verify persistence
    await page.getByRole('button', { name: 'Go back' }).click();
    await navigateToSettings(page);
    await page.getByRole('button', { name: /Security/ }).first().click();
    await expect(page.getByRole('button', { name: /Standard/ })).toHaveClass(/btn-tile-selected/);

    // Switch to Expert and verify
    await page.getByRole('button', { name: /Expert/ }).click();
    await expect(page.getByRole('button', { name: /Expert/ })).toHaveClass(/btn-tile-selected/);
  });
});

