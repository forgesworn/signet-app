import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, restoreIdentityAndUnlock, clearDatabase } from './fixtures';

const LITE_DEFAULT_PUBKEY = '669452f36131312d1932b63cc0695b3861a15105dfeb13781ed1af5b8aff6dc5';

test.describe('Onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test('create identity with real name', async ({ page }) => {
    // The create door is always persona-primary now — a real-name identity
    // comes from the restore path's name-choice step instead.
    await restoreIdentityAndUnlock(page, { name: 'Alice Test', keypair: 'natural-person' });
    // Landing is always the persona row (row 0, spec §5) even when NP is
    // primary — the restored NP name shows one row down.
    await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 60_000 });
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    await expect(page.getByText('Alice Test')).toBeVisible({ timeout: 15_000 });
  });

  test('create identity as persona', async ({ page }) => {
    await createIdentityAndUnlock(page, { name: 'DarkWolf99' });
    await expect(page.getByText('DarkWolf99')).toBeVisible();
  });

  test('invalid mnemonic rejected', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: /recovery words/ }).click();

    await page.getByPlaceholder('19 words separated by spaces').fill('invalid words that are not a real mnemonic phrase at all');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Recovery words are 19 or 31 words')).toBeVisible();
  });

  test('bad checksum mnemonic rejected', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: /recovery words/ }).click();

    await page.getByRole('button', { name: 'I have an older 12-word backup' }).click();
    // 12 valid BIP-39 words but invalid checksum
    await page.getByPlaceholder('12 words separated by spaces').fill('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText("doesn't look right")).toBeVisible();
  });

  test('import via mnemonic derives correct keys', async ({ page }) => {
    const recoveryWords = 'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: /recovery words/ }).click();

    // Phrase step
    await page.getByPlaceholder('19 words separated by spaces').fill(recoveryWords);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Name-choice step
    await page.getByRole('button', { name: 'Use my real name' }).click();

    // Name step
    await page.getByPlaceholder('Your name or nickname').fill('Restored User');
    await page.getByRole('button', { name: 'Restore MySignet' }).click();

    // SetupAuth intro
    await page.getByRole('button', { name: 'Set up now' }).click();

    // Choose PIN
    await page.getByRole('button', { name: /6-digit PIN/ }).click();

    // Enter PIN twice
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Done screen
    await page.getByRole('button', { name: 'Continue' }).click();

    // Landing is always the persona row (row 0, spec §5) even when NP is
    // primary — the restored NP name and npub show one row down.
    await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 60_000 });
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);

    // Home should show the restored name (PBKDF2 can be slow)
    await expect(page.getByText('Restored User')).toBeVisible({ timeout: 60_000 });

    // Verify the derived npub matches the expected key for this test vector
    // Natural person pubkey: 7964f124878b3528f1e1c3e946512f340d761a29a9d1d5a445faa5a2ebd62574
    // npub: npub109j0zfy83v6j3u0pc055v5f0xsxhvx3f48gatfz9l2j6967ky46qmhvaha
    await expect(page.getByText('npub109j0z')).toBeVisible();
  });

  test('restore from Signet Lite preserves the Lite identity pubkey', async ({ page }) => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: 'Restore from Signet Lite' }).click();

    await page.locator('textarea').fill(mnemonic);
    await page.getByPlaceholder('default').fill('default');
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByPlaceholder('Your name or nickname').fill('Lite Migrant');
    await page.getByRole('button', { name: 'Restore Lite Identity' }).click();

    await page.getByRole('button', { name: 'Set up now' }).click();
    await page.getByRole('button', { name: /6-digit PIN/ }).click();
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Lite Migrant')).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => page.evaluate(() => (window as any).__TEST__?.getActivePubkey())).toBe(LITE_DEFAULT_PUBKEY);
    await expect(page.getByText('npub1v6299u')).toBeVisible();
  });

  test('empty name rejected on import', async ({ page }) => {
    // Phase F: cold-create door retired. Empty-name guard is tested via the
    // import flow — name step (same component, same disabled logic).
    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: /recovery words/ }).click();

    const testRecoveryWords = 'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await page.getByPlaceholder('19 words separated by spaces').fill(testRecoveryWords);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Name-choice step — pick real name
    await page.getByRole('button', { name: 'Use my real name' }).click();

    // With empty name, "Restore MySignet" button should be disabled
    await expect(page.getByRole('button', { name: 'Restore MySignet' })).toBeDisabled();

    // Whitespace-only name should also keep it disabled
    await page.getByPlaceholder('Your name or nickname').fill('   ');
    await expect(page.getByRole('button', { name: 'Restore MySignet' })).toBeDisabled();
  });

  test('PIN mismatch rejected', async ({ page }) => {
    // Phase F: cold-create door retired. Use the import door to reach SetupAuth.
    await page.goto('/');
    await page.getByRole('button', { name: 'I already have a Signet' }).click();
    await page.getByRole('button', { name: /recovery words/ }).click();

    const testRecoveryWords = 'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await page.getByPlaceholder('19 words separated by spaces').fill(testRecoveryWords);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Name-choice step
    await page.getByRole('button', { name: 'Use my real name' }).click();

    // Name step
    await page.getByPlaceholder('Your name or nickname').fill('Mismatch Test');
    await page.getByRole('button', { name: 'Restore MySignet' }).click();

    // SetupAuth intro
    await page.getByRole('button', { name: 'Set up now' }).click();

    // Choose PIN
    await page.getByRole('button', { name: /6-digit PIN/ }).click();

    // Enter first PIN
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Enter different confirmation PIN
    for (const digit of '654321') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Should show mismatch error
    await expect(page.getByText(/don't match|mismatch/i)).toBeVisible({ timeout: 5_000 });
  });
});
