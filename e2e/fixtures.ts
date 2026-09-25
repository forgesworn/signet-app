import { type Page } from '@playwright/test';

const DEFAULT_PIN = '123456';
const DEFAULT_NAME = 'Test User';

/**
 * Enter a 6-digit PIN on the keypad.
 * Works for both SetupAuth and AuthScreen keypads.
 */
async function enterPin(page: Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

/**
 * Shared PIN tail for onboarding: `Set up now` → `6-digit PIN` → enter →
 * confirm → `Continue` → wait for Home. Both `createIdentityAndUnlock` and
 * `restoreIdentityAndUnlock` land here once the display name is set.
 */
async function completeSetupAuth(page: Page, pin: string) {
  // SetupAuth: intro screen
  await page.getByRole('button', { name: 'Set up now' }).click();

  // Choose PIN (biometric may or may not be available in headless)
  await page.getByRole('button', { name: /6-digit PIN/ }).click();

  // Enter PIN
  await enterPin(page, pin);

  // Confirm PIN
  await enterPin(page, pin);

  // Wait for "done" screen, then continue
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * Run through full onboarding: create identity, set PIN, land on Home.
 */
export async function createIdentityAndUnlock(
  page: Page,
  options?: {
    name?: string;
    pin?: string;
  },
) {
  const name = options?.name ?? DEFAULT_NAME;
  const pin = options?.pin ?? DEFAULT_PIN;

  await page.goto('/');

  // Welcome screen — two doors. The create door is the canonical fixture path:
  // one persona name, then SetupAuth. Fixtures that need a specific derived
  // pubkey use `restoreIdentityAndUnlock` below instead.
  await page.getByRole('button', { name: 'Create my Signet' }).click();
  await page.getByPlaceholder('A name or handle — not your real name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();

  await completeSetupAuth(page, pin);

  // Should be on Home now (PBKDF2 operations can take 10-30s)
  await page.getByText(name).waitFor({ state: 'visible', timeout: 60_000 });
}

/**
 * Restore the frozen recovery-words test vector, so the derived pubkey is
 * deterministic. Kept separate from `createIdentityAndUnlock` because the
 * create door mints a fresh mnemonic.
 */
export async function restoreIdentityAndUnlock(
  page: Page,
  options?: { name?: string; pin?: string; keypair?: 'natural-person' | 'persona'; words?: string },
) {
  const name = options?.name ?? DEFAULT_NAME;
  const pin = options?.pin ?? DEFAULT_PIN;
  const keypair = options?.keypair ?? 'persona';

  await page.goto('/');
  await page.getByRole('button', { name: 'I already have a Signet' }).click();
  await page.getByRole('button', { name: /recovery words/ }).click();

  const testRecoveryWords = 'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  await page.getByPlaceholder('19 words separated by spaces').fill(options?.words ?? testRecoveryWords);
  await page.getByRole('button', { name: 'Continue' }).click();

  if (keypair === 'natural-person') {
    await page.getByRole('button', { name: 'Use my real name' }).click();
  } else {
    await page.getByRole('button', { name: 'Use a nickname' }).click();
  }
  await page.getByPlaceholder('Your name or nickname').fill(name);
  await page.getByRole('button', { name: 'Restore MySignet' }).click();

  await completeSetupAuth(page, pin);
}

/**
 * Unlock the app from the AuthScreen using PIN.
 */
export async function unlockApp(page: Page, pin?: string) {
  const p = pin ?? DEFAULT_PIN;

  // If biometric screen is showing, switch to PIN
  const pinButton = page.getByRole('button', { name: 'Use PIN instead' });
  if (await pinButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await pinButton.click();
  }

  await enterPin(page, p);

  // Wait for the app to settle after unlock. The carousel home has no
  // role="main" (only Layout-wrapped pages do), so accept either: the carousel
  // viewport (landing on Home) or a Layout main (landing on an approval page).
  await page.locator('.carousel-viewport, div[role="main"]').first().waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Unlock from the AuthScreen with PIN, robust to slow first render after a
 * reload (identity load + PBKDF2 can lag several seconds). Waits for the unlock
 * screen to mount, switches biometric → PIN if needed, then enters the PIN.
 * Unlike `unlockApp` it does NOT assert the destination — the caller lands on
 * either Home or an approval screen depending on the pending request.
 */
export async function unlockWithPin(page: Page, pin?: string) {
  const p = pin ?? DEFAULT_PIN;
  const pinSwitch = page.getByRole('button', { name: 'Use PIN instead' });
  const keypadOne = page.getByRole('button', { name: '1', exact: true });
  // Either the biometric screen ("Use PIN instead") or the PIN keypad shows first.
  await Promise.race([
    pinSwitch.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined),
    keypadOne.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined),
  ]);
  if (await pinSwitch.isVisible().catch(() => false)) {
    await pinSwitch.click();
  }
  await keypadOne.waitFor({ state: 'visible', timeout: 10_000 });
  await enterPin(page, p);
}

/**
 * Tap the real-name confirmation if `requireNpConfirmation` (default-on) gated
 * the Approve button. Covers both the sign-in ("Yes, use my real-name
 * identity") and connect ("Yes, connect with my real-name identity") copy.
 * No-op when a persona is selected (button never appears) or already confirmed.
 */
export async function confirmRealNameIfPrompted(page: Page) {
  await page
    .getByRole('button', { name: /Yes, (use|connect with) my real-name identity/ })
    .click({ timeout: 8_000 })
    .catch(() => {});
}

/**
 * Lock the app by simulating a visibility change.
 * Does NOT work when on venue-entry page (30s grace period).
 */
export async function lockApp(page: Page) {
  await page.evaluate(() => (window as any).__TEST__?.lock?.());

  // Wait for auth screen to appear
  await page.getByText('Enter your PIN').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    // Biometric method shows "Unlock Signet" instead
    return page.getByText('Unlock Signet').waitFor({ state: 'visible', timeout: 5_000 });
  });
}

/**
 * Clear all IndexedDB data and land on a fresh `/`. Use in beforeAll for isolation.
 *
 * The delete runs from a blank same-origin document rather than the app
 * itself: the app holds its IndexedDB connection open and never closes it on
 * `versionchange`, so a `deleteDatabase` issued from inside the app is blocked
 * until the page goes away. Resolving on `blocked` and reloading let the
 * deferred deletion race the reloaded app's own open, and on WebKit the app
 * won often enough to boot into the old identity (the 0.13.0/0.13.1 deploy
 * failures on the mobile-webkit-qr project).
 */
export async function clearDatabase(page: Page) {
  const blank = '**/__e2e/blank';
  await page.route(blank, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>e2e blank</title>',
  }));
  await page.goto('/__e2e/blank');
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('my-signet');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
      // No connection is open from this document, so `blocked` only fires while
      // the previous document is still tearing down; success follows.
    }).then(() => localStorage.clear());
  });
  await page.unroute(blank);
  await page.goto('/');
}

/**
 * Navigate to Settings from Home via the test harness.
 */
export async function navigateToSettings(page: Page) {
  await page.evaluate((p) => (window as any).__TEST__.setPage(p), 'settings');
}

/**
 * Navigate to a page via the DEV-only test harness.
 * Use for pages that have no direct UI navigation path.
 */
export async function navigateViaHarness(page: Page, target: string) {
  await page.evaluate((p) => (window as any).__TEST__.setPage(p), target);
}
