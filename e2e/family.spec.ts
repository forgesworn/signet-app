import { nip19 } from 'nostr-tools';
import { test, expect, Page } from '@playwright/test';
import { addDependantViaUi, createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';

const TEST_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

/** Add a family member via npub entry. Waits for ECDH to complete. */
async function addTestMember(page: Page, name = 'Bob Test') {
  await navigateViaHarness(page, 'add');
  await page.getByRole('button', { name: 'Enter their npub' }).click();
  await page.getByPlaceholder('npub1…').fill(nip19.npubEncode(TEST_PUBKEY));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder("What should we call them?").fill(name);
  await page.getByRole('button', { name: 'Add contact' }).click();
  try {
    await expect(page.getByRole('heading', { name: `${name} added` })).toBeVisible({ timeout: 40_000 });
  } catch (error) {
    // Leave room inside the test timeout to say what the page shows instead.
    const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(`"${name} added" never appeared; page shows: ${shown.replace(/\s+/g, ' ').slice(0, 600)}`, { cause: error });
  }
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

    // Contact detail assertions: the key exchange left a mutually verified
    // identity on the record, and the Signet Me words are offered.
    await expect(page.getByRole('heading', { level: 1, name: 'Bob Test' })).toBeVisible();
    await expect(page.getByText(/Mutually verified/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Signet Me' })).toBeVisible();
  });

  test('remove member from family', async ({ page }) => {
    await addTestMember(page);

    await navigateViaHarness(page, 'contacts');
    await page.getByText('Bob Test').click();

    // "Remove contact" opens the confirmation card
    await page.getByRole('button', { name: 'Remove contact' }).click();
    const confirmation = page.locator('.card', { hasText: /Remove Bob Test from your contacts/ });
    await expect(confirmation).toBeVisible();

    // Confirm removal. Scoped to the card: the identity row has its own "Remove".
    await confirmation.getByRole('button', { name: 'Remove', exact: true }).click();

    // Back on the list with no contacts
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
    // Fills the form, confirms the recovery words and lands on the success screen.
    await addDependantViaUi(page, 'Lily', { stay: true });

    // Bunker is off by default in fresh test session — shows the bunker-off CTA
    await expect(page.getByRole('button', { name: /Turn the Bunker on first/ })).toBeVisible();
    // Hand phone and Done for now are always present
    await expect(page.getByRole('button', { name: /Hand this phone to Lily/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Done for now/ })).toBeVisible();
  });

  test('Dependant carousel card shows pairing-status subtitle after creation', async ({ page }) => {
    await addDependantViaUi(page, 'Lily', { stay: true });
    // Navigate back to home via harness (avoids browser history.back() issues)
    await navigateViaHarness(page, 'home');

    // Wait for carousel to be visible
    await page.locator('.carousel-viewport').waitFor({ state: 'visible', timeout: 10_000 });
    // Step down to Lily's dependant card using the keyboard. The ring is
    // persona, visible extras, natural person (once activated), dependants,
    // then add; the real identity is dormant here, so Lily follows the persona.
    const subtitle = page.getByText(/No phone paired — swipe . to settings/);
    for (let row = 1; row <= 4 && !(await subtitle.isVisible()); row++) {
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.nav-dots-v .nav-dot').nth(row)).toHaveClass(/active/, { timeout: 5_000 });
    }

    // Lily's card should now be in the carousel — pairing status subtitle visible
    await expect(page.getByText(/No phone paired — swipe . to settings/)).toBeVisible({ timeout: 10_000 });
  });
});
