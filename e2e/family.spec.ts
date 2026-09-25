import { nip19 } from 'nostr-tools';
import { test, expect, Page } from '@playwright/test';
import { createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

const TEST_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

/** Add a family member via npub entry. Waits for ECDH to complete. */
async function addTestMember(page: Page, name = 'Bob Test') {
  await navigateViaHarness(page, 'add');
  await page.getByRole('button', { name: 'Enter their npub' }).click();
  await page.getByPlaceholder('npub1…').fill(nip19.npubEncode(TEST_PUBKEY));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder("What should we call them?").fill(name);
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: `${name} added` })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Done' }).click();
}

test.describe('Family Management', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('empty family shows prompt', async ({ page }) => {
    await navigateViaHarness(page, 'family-list');
    await expect(page.getByText('No dependants yet')).toBeVisible();
  });

  test('add member via npub', async ({ page }) => {
    await addTestMember(page);

    await navigateViaHarness(page, 'contacts');
    await expect(page.getByText('Bob Test')).toBeVisible();
  });

  test('view member detail shows name and Signet Me words', async ({ page }) => {
    await addTestMember(page);

    await navigateViaHarness(page, 'contacts');
    await page.getByText('Bob Test').click();

    // Member detail page assertions
    await expect(page.getByRole('heading', { level: 1, name: 'Bob Test' })).toBeVisible();
    await expect(page.getByText(/Connected/)).toBeVisible();
    await expect(page.getByText(/Signet Me/)).toBeVisible();
  });

  test('remove member from family', async ({ page }) => {
    await addTestMember(page);

    await navigateViaHarness(page, 'contacts');
    await page.getByText('Bob Test').click();

    // Click "Remove from family" to show confirmation dialog
    await page.getByRole('button', { name: 'Remove contact' }).click();
    await expect(page.getByText(/Remove Bob Test from your contacts/)).toBeVisible();

    // Confirm removal
    await page.getByRole('button', { name: 'Remove' }).click();

    // Should return to Family page with no members
    await expect(page.getByText('No contacts yet')).toBeVisible();
  });

  test('show-qr displays payload', async ({ page }) => {
    await navigateViaHarness(page, 'add');
    await page.getByRole('button', { name: 'Show my QR code' }).click();

    const payload = page.getByTestId('qr-payload');
    await expect(payload).toBeVisible();

    const text = await payload.textContent();
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed.pubkey).toBeTruthy();
    expect(parsed.pubkey).toHaveLength(64);
    expect(parsed.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('invalid public address rejected', async ({ page }) => {
    await navigateViaHarness(page, 'add');
    await page.getByRole('button', { name: 'Enter their npub' }).click();

    // Too short
    await page.getByPlaceholder('npub1…').fill('abcdef');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(/public address starting with npub1/i)).toBeVisible();
  });
});

test.describe('AddDependant — 3-button success flow', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('AddDependant success screen shows 3 buttons in correct order', async ({ page }) => {
    await navigateViaHarness(page, 'add-dependant');
    await page.getByLabel(/Their name/i).fill('Lily');
    await page.getByRole('button', { name: 'Create identity' }).click();

    // Wait for success
    await expect(page.getByText(/Lily's identity is ready/)).toBeVisible({ timeout: 60_000 });

    // Bunker is off by default in fresh test session — shows the bunker-off CTA
    await expect(page.getByRole('button', { name: /Turn the Bunker on first/ })).toBeVisible();
    // Hand phone and Done for now are always present
    await expect(page.getByRole('button', { name: /Hand this phone to Lily/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Done for now/ })).toBeVisible();
  });

  test('Dependant carousel card shows pairing-status subtitle after creation', async ({ page }) => {
    await navigateViaHarness(page, 'add-dependant');
    await page.getByLabel(/Their name/i).fill('Lily');
    await page.getByRole('button', { name: 'Create identity' }).click();

    await expect(page.getByText(/Lily's identity is ready/)).toBeVisible({ timeout: 60_000 });
    // Navigate back to home via harness (avoids browser history.back() issues)
    await navigateViaHarness(page, 'home');

    // Wait for carousel to be visible
    await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 10_000 });
    // Navigate down to Lily's dependant card using keyboard
    // Row order: 0=app-settings, 1=natural-person, 2=persona, 3=Lily(dependant), 4=add
    // Start at row 1, need to press ArrowDown twice to reach row 3
    await page.locator('.carousel-viewport').click();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);

    // Lily's card should now be in the carousel — pairing status subtitle visible
    await expect(page.getByText(/No phone paired — swipe . to settings/)).toBeVisible({ timeout: 10_000 });
  });
});
