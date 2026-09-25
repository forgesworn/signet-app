/**
 * NOT A TEST — throwaway screenshot harness for a designer's alignment audit.
 *
 * Captures mobile renders (390x844) of every reachable page and every
 * carousel card/column state, plus a light/dark pass and a desktop-frame
 * pass, and writes them to UX_CAPTURE_DIR (or the default scratchpad path
 * below). Each capture is its own test so one failure never blocks the rest.
 *
 * Run explicitly:
 *   UX_CAPTURE=1 npx playwright test e2e/_capture-ux-audit.spec.ts --project=mobile-chromium --workers=1 --reporter=line
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createIdentityAndUnlock, restoreIdentityAndUnlock, clearDatabase, unlockWithPin, lockApp, navigateViaHarness, confirmRealNameIfPrompted } from './fixtures';

test.skip(process.env.UX_CAPTURE !== '1', 'Screenshot capture harness: set UX_CAPTURE=1 to run it.');

// This machine's checkout has a local mkcert cert/ dir, which flips the Vite
// dev server to HTTPS (see vite.config.ts `hasCerts`) — the shared
// playwright.config.ts baseURL is plain http://, which 500s against it.
// Scope an https override to just this spec file rather than touching the
// shared config (other specs / machines without cert/ still want http://).
test.use({ baseURL: 'https://localhost:5174', ignoreHTTPSErrors: true });

const OUT = process.env.UX_CAPTURE_DIR
  ?? path.resolve(process.cwd(), 'e2e/results/ux-audit');

/** Screenshot the viewport, plus a fullPage variant when content overflows it. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(350); // let CSS transitions/animations settle
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
  const isTall = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 40,
  ).catch(() => false);
  if (isTall) {
    await page.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true }).catch(() => {});
  }
}

/** Move the carousel horizontally (card→qr→contacts→settings→camera→card…) via the document-level ArrowKey handler in Carousel.tsx. */
async function colRight(page: Page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(450); // swipe commit fires ~320ms after the animation starts
  }
}
/** Move the carousel vertically (down = toward the bottom of the ring: NP→Persona→extras→dependants→Add). Explicitly returns to column 0 for these identity-card captures; the app itself preserves the column. */
async function rowDown(page: Page, times = 1) {
  while (!(await page.locator('.nav-dots-h .nav-dot').nth(0).evaluate(el => el.classList.contains('active')))) {
    await colRight(page);
  }
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(450);
  }
}

/**
 * Navigate to `target` via the DEV harness AND keep the real browser History
 * entry in sync. `App.tsx`'s navigation (`useNavigation.ts`) is backed by
 * real `pushState` / `history.back()`, but `__TEST__.setPage` only flips
 * React state — it never touches history. Left unsynced, a later
 * `navigateBack()` (e.g. AddDependant's "Done for now" button, or any Layout
 * back chevron) can pop to whatever STALE history entry was pushed before
 * this harness jump instead of the page the harness just switched to —
 * landing back on an earlier persona-advanced page instead of Home. Use this
 * instead of the bare `navigateViaHarness` whenever a real navigateTo/Back
 * follows.
 */
async function navigateHome(page: Page) {
  await navigateViaHarness(page, 'home');
  await page.evaluate(() => window.history.replaceState({ page: 'home' }, ''));
}

test.setTimeout(180_000);

/**
 * Some consequential actions (adding a persona, etc.) are gated behind a
 * "fresh auth" re-entry of the PIN (`requestFreshAuth` in App.tsx), shown as
 * a PIN keypad overlaying the current screen. No-ops if it doesn't appear.
 */
async function dismissFreshAuthIfPrompted(page: Page, pin = '123456') {
  const heading = page.getByRole('heading', { name: 'Enter your PIN' });
  if (await heading.isVisible({ timeout: 3_000 }).catch(() => false)) {
    for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
    await heading.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Onboarding
// ─────────────────────────────────────────────────────────────────────────

test('01 onboarding: welcome doors', async ({ page }) => {
  await clearDatabase(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create my Signet' })).toBeVisible({ timeout: 15_000 });
  await shot(page, '01-onboarding-welcome-doors');
});

test('01a onboarding: create-door name step', async ({ page }) => {
  await clearDatabase(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create my Signet' }).click();
  await expect(page.getByPlaceholder('A name or handle — not your real name')).toBeVisible({ timeout: 10_000 });
  await shot(page, '01a-onboarding-create-name-step');
});

test('02 onboarding: restore + recovery words + name-choice + name step', async ({ page }) => {
  await clearDatabase(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'I already have a Signet' }).click();
  await expect(page.getByRole('heading', { name: 'I already have a Signet' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '02-onboarding-restore-doors');

  await page.getByRole('button', { name: /recovery words/ }).click();
  await expect(page.getByPlaceholder('19 words separated by spaces')).toBeVisible({ timeout: 10_000 });
  await shot(page, '03-onboarding-recovery-words-step');

  const testRecoveryWords = 'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  await page.getByPlaceholder('19 words separated by spaces').fill(testRecoveryWords);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Use my real name' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '04-onboarding-name-choice');

  await page.getByRole('button', { name: 'Use my real name' }).click();
  await expect(page.getByPlaceholder('Your name or nickname')).toBeVisible({ timeout: 10_000 });
  await shot(page, '05-onboarding-name-step');

  await page.getByPlaceholder('Your name or nickname').fill('Alex Rivera');
  await page.getByRole('button', { name: 'Restore MySignet' }).click();

  await expect(page.getByRole('button', { name: 'Set up now' })).toBeVisible({ timeout: 15_000 });
  await shot(page, '06-setupauth-intro');

  await page.getByRole('button', { name: 'Set up now' }).click();
  await expect(page.getByRole('button', { name: /6-digit PIN/ })).toBeVisible({ timeout: 10_000 });
  await shot(page, '07-setupauth-choose-method');

  await page.getByRole('button', { name: /6-digit PIN/ }).click();
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible({ timeout: 10_000 });
  await shot(page, '08-setupauth-pin-entry');

  for (const d of '123456') await page.getByRole('button', { name: d, exact: true }).click();
  await expect(page.getByText('Confirm your PIN')).toBeVisible({ timeout: 10_000 });
  await shot(page, '09-setupauth-pin-confirm');

  for (const d of '123456') await page.getByRole('button', { name: d, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '10-setupauth-done');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Fresh identity: the Persona row is the landing row (row 0) — the real
// identity is dormant by default and has NO carousel card at all (spec §5) —
// all 5 columns, plus gear-fab -> persona-advanced.
// ─────────────────────────────────────────────────────────────────────────

test('11 home carousel: Persona row (landing card), all 5 columns', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  await shot(page, '11-home-persona-card');

  await colRight(page);
  await shot(page, '12-home-persona-qr');

  await colRight(page);
  await shot(page, '13-home-persona-contacts');
  await colRight(page);
  await shot(page, '13-home-persona-settings');

  await colRight(page);
  await shot(page, '14-home-persona-camera');
});

test('12 gear-fab: Persona -> persona-advanced', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  await colRight(page, 3); // card -> qr -> contacts -> settings
  await page.locator('.gear-fab').click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, '15-persona-advanced-persona');
});

// ─────────────────────────────────────────────────────────────────────────
// 2b. Activation gating: the NP row does not exist until activated. Capture
// the RequireRealIdentity gate interstitial (a dormant-NP identity hitting a
// real-name-only feature) and the ActivateRealIdentity page itself, then the
// NP row it produces once activated (restored via the recovery-words door's
// "Use my real name" choice, which starts NP already active — persona still
// sits at row 0, NP is row 1 since there are no extra personas).
// ─────────────────────────────────────────────────────────────────────────

test('12a gate interstitial: RequireRealIdentity on Get Verified', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  await navigateViaHarness(page, 'get-verified');
  await expect(page.getByRole('button', { name: 'Activate my real identity' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '15a-gate-interstitial-require-real-identity');
});

test('12b activation page: explanation -> name -> typed confirm -> backup', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  await navigateViaHarness(page, 'get-verified');
  await page.getByRole('button', { name: 'Activate my real identity' }).click({ timeout: 10_000 });
  await expect(page.getByPlaceholder('Your legal name')).toBeVisible({ timeout: 10_000 });
  await shot(page, '15b-activation-name-step');

  await page.getByPlaceholder('Your legal name').fill('Alex Rivera Real');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByPlaceholder('Alex Rivera Real')).toBeVisible({ timeout: 10_000 });
  await shot(page, '15c-activation-typed-confirm');

  await page.getByPlaceholder('Alex Rivera Real').fill('Alex Rivera Real');
  await page.getByRole('button', { name: 'Activate my real identity' }).click();
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '15d-activation-backup-words');
});

test('13 home carousel: NP row (activated), all 5 columns + gear-fab', async ({ page }) => {
  await clearDatabase(page);
  await restoreIdentityAndUnlock(page, { name: 'Alex Rivera', keypair: 'natural-person' });
  await confirmRealNameIfPrompted(page);
  await rowDown(page); // Persona (row 0) -> NP (row 1), col resets to 0
  await shot(page, '16-home-np-card');

  await colRight(page);
  await shot(page, '17-home-np-qr');

  await colRight(page);
  await shot(page, '18-home-np-contacts');
  await colRight(page);
  await shot(page, '18-home-np-settings');
  await page.locator('.gear-fab').click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, '19-persona-advanced-np');

  await navigateViaHarness(page, 'home');
  await page.waitForTimeout(500);
  await rowDown(page); // back to NP row — the landing row is always Persona (row 0)
  await colRight(page, 4); // card -> qr -> contacts -> settings -> camera
  await shot(page, '20-home-np-camera');
});

test('14 home carousel: Add row (fresh identity)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  await rowDown(page, 1); // Persona -> Add (no NP row until activated)
  await shot(page, '21-home-add-card');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Add an extra persona + a dependant through the UI, then screenshot
// the new rows and their gear-fab -> persona-advanced pages.
// ─────────────────────────────────────────────────────────────────────────

test('15 add extra persona + dependant via UI, screenshot both rows', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);

  // Navigate to the Add row (Persona -> Add for a fresh identity — no NP row
  // until activated).
  await rowDown(page, 1);
  await shot(page, '22-add-card-choose');

  // Add persona
  await page.getByRole('button', { name: 'Add persona' }).click();
  await expect(page.getByPlaceholder('e.g. CryptoAlice')).toBeVisible({ timeout: 5_000 });
  await shot(page, '23-add-card-persona-name-step');
  await page.getByPlaceholder('e.g. CryptoAlice').fill('Night Owl');
  await page.getByRole('button', { name: 'Create persona' }).click();
  // Adding a persona is a consequential action gated behind fresh-auth PIN re-entry.
  await dismissFreshAuthIfPrompted(page);
  // `buildRows` inserts extra personas BEFORE the Add row (persona,
  // extras..., natural-person (only if activated), dependants..., add — see
  // carousel-utils.ts), and useCarousel never re-lands on row change: it
  // keeps whatever numeric `row` index the user was on. So the position we
  // were just viewing (row 1 — the Add row on a fresh, NP-dormant identity)
  // now renders the freshly-created persona's IdentityCard, not a
  // reset-to-'choose' AddCard — the Add row itself shifted down to row 2.
  await expect(page.getByText('Night Owl').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot(page, '25-home-extra-persona-card');
  await colRight(page);
  await shot(page, '26-home-extra-persona-qr');
  await colRight(page);
  await shot(page, '27-home-extra-persona-contacts');
  await colRight(page);
  await shot(page, '27-home-extra-persona-settings');
  await page.locator('.gear-fab').click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, '28-persona-advanced-extra-persona');

  // Back to Home. NOTE: `useCarousel` (row/col state) lives in App.tsx at the
  // TOP level (`const carousel = useCarousel(...)`, called unconditionally
  // outside any `page === 'home'` guard) — it is NOT scoped to <Carousel>,
  // so leaving/returning to the home page does NOT reset row/col; only
  // `<Carousel>`'s own JSX un/re-mounts. We're still sitting at row 1 / col 3
  // (the extra-persona settings column we were on before the gear-fab push).
  // One more ArrowDown reaches the Add row, now shifted to row 2.
  // Use navigateHome (not the bare harness call) — a real navigateTo/back
  // follows shortly (Add Dependant, then "Done for now"), and the harness
  // alone would desync app state from the real browser History entry left
  // behind by the earlier gear-fab -> persona-advanced push.
  await navigateHome(page);
  await page.waitForTimeout(500);
  await rowDown(page, 1);
  await expect(page.getByRole('button', { name: 'Add someone you look after' })).toBeVisible({ timeout: 10_000 });

  // Add dependant — navigates to a full page, but the real identity is
  // still dormant, so this hits the RequireRealIdentity gate first (spec
  // §7.3: "you are the guardian on record" needs the real identity).
  // Activate now — `activationReturnTo` is 'add-dependant', so completing
  // activation lands directly back on the real Add Dependant form.
  await page.getByRole('button', { name: 'Add someone you look after' }).click();
  await expect(page.getByRole('button', { name: 'Activate my real identity' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Activate my real identity' }).click();
  await page.getByPlaceholder('Your legal name').fill('Alex Rivera Real');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('Alex Rivera Real').fill('Alex Rivera Real');
  await page.getByRole('button', { name: 'Activate my real identity' }).click();
  await page.getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByLabel(/Their name/i)).toBeVisible({ timeout: 10_000 });
  await shot(page, '24-add-dependant-form');

  await page.getByLabel(/Their name/i).fill('Sam Rivera');
  const dob = new Date();
  dob.setFullYear(dob.getFullYear() - 10);
  const dobStr = dob.toISOString().slice(0, 10);
  await page.locator('#dependant-dob').fill(dobStr);
  await page.getByRole('button', { name: 'Create identity' }).click();
  await dismissFreshAuthIfPrompted(page);

  // Creation lands on an in-page "<name>'s identity is ready" success step
  // (not an immediate navigate-away) offering pair-now / hand-phone-over /
  // done-for-now choices. Screenshot it, then dismiss via "Done for now",
  // which calls onBack -> navigateBack() (a real browser history.back() —
  // see useNavigation.ts). navigateHome's history.replaceState above is what
  // makes this land back on 'home' rather than a stale earlier entry.
  await expect(page.getByText(/identity is ready/)).toBeVisible({ timeout: 15_000 });
  await shot(page, '24a-add-dependant-success');
  await page.getByRole('button', { name: /Done for now/ }).click();
  await page.getByText('Alex Rivera').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Activating the real identity mid-flow (above) inserted a NEW NP row
  // into the ring. Rows are now: Persona(0), extra-persona "Night Owl"(1),
  // NP "Alex Rivera Real"(2), dependant "Sam Rivera"(3), Add(4). Carousel
  // row/col state was left at row 2 / col 0 by the `rowDown(page, 1)` above
  // — that slot was the Add row BEFORE activation existed, but the NP
  // insertion shifted things, so row 2 now renders NP's IdentityCard, not
  // the dependant's. One more ArrowDown reaches the dependant (row 3).
  await rowDown(page, 1);
  await shot(page, '29-home-dependant-card');
  await colRight(page);
  await shot(page, '30-home-dependant-qr');
  await colRight(page);
  await shot(page, '31-home-dependant-contacts');
  await colRight(page);
  await shot(page, '31-home-dependant-settings');
  await page.locator('.gear-fab').click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, '32-persona-advanced-dependant');

  // Family list overview (guardian's dependants).
  await navigateViaHarness(page, 'family-list');
  await page.waitForTimeout(500);
  await shot(page, '32a-family-list');

  // GuardianSettings for the dependant. The DEV test harness's `setPage` is a
  // bare page setter (`__TEST__.setPage`, see App.tsx) with no way to also
  // carry a dependantId, and App.tsx's 'settings' page only renders
  // GuardianSettings when `activeDependant` is set — so reach it the way a
  // real user would: tap the dependant settings column's "Autonomy Level"
  // row, which calls onNavigateDeepPage('settings', { dependantId }). Row/col
  // state is untouched by the family-list detour above, so navigating home
  // lands us right back on the dependant settings column (row 3 / col 3) —
  // no rowDown/colRight needed.
  await navigateHome(page);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Autonomy Level/ }).click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, '32b-guardian-settings-dependant');
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Bottom nav tabs + every settings subpage via the harness.
// ─────────────────────────────────────────────────────────────────────────

test('16 bottom nav: Contacts, Bunker, Settings', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);

  const nav = page.getByRole('navigation', { name: 'Primary' });
  try {
    await nav.getByRole('button', { name: 'Contacts' }).click();
    await page.waitForTimeout(500);
    await shot(page, '33-tab-contacts-empty');
  } catch { /* non-fatal */ }

  try {
    await navigateViaHarness(page, 'home');
    await page.waitForTimeout(300);
    await nav.getByRole('button', { name: 'Bunker' }).click();
    await page.waitForTimeout(700);
    await shot(page, '34-tab-bunker-panel');
    // BunkerPanel is a modal dialog with no Escape handler — close it via its
    // own button (bounded timeout so a miss fails fast, not into the test's
    // full 180s budget via an un-timed click blocked by the overlay).
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 5_000 }).catch(() => {});
  } catch { /* non-fatal */ }

  try {
    await navigateViaHarness(page, 'home');
    await page.waitForTimeout(300);
    await nav.getByRole('button', { name: 'Settings' }).click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    await shot(page, '35-tab-settings-menu');
  } catch { /* non-fatal */ }
});

const SETTINGS_SUBPAGES: string[] = [
  'settings-security', 'settings-profile', 'settings-personas', 'settings-advanced',
  'settings-developer', 'settings-professional', 'connections', 'companion-apps',
  'my-documents', 'get-verified', 'verify-someone', 'shamir', 'identity-bridge',
  'vouch-someone', 'family-list', 'manage-carousel', 'activity', 'venue-entry',
  'photo-capture', 'badge-embed', 'add-dependant', 'import-dependant',
  'pair-dependant-device', 'pair-dependant-app', 'migrate-heartwood', 'pro-onboarding',
  'ken-add', 'roster', 'web-verify', 'edit-public-profile',
];

for (let i = 0; i < SETTINGS_SUBPAGES.length; i++) {
  const target = SETTINGS_SUBPAGES[i];
  const n = String(36 + i).padStart(2, '0');
  test(`17-${n} settings subpage: ${target}`, async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
    await confirmRealNameIfPrompted(page);
    try {
      await navigateViaHarness(page, target);
      await page.waitForTimeout(800);
      await shot(page, `${n}-settings-page-${target}`);
    } catch {
      await shot(page, `${n}-settings-page-${target}-ERROR`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Approval screens
// ─────────────────────────────────────────────────────────────────────────

function authUrl(extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    auth: '1',
    challenge: 'a'.repeat(64),
    origin: 'https://couch-arcade.example',
    callback: 'https://couch-arcade.example/cb',
    name: 'Couch Arcade',
    t: String(Math.floor(Date.now() / 1000)),
    ...extra,
  });
  return '/?' + params.toString();
}

test('18 approval: approve-auth (Sign in with Signet)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await page.goto(authUrl());
  await unlockWithPin(page).catch(() => {});
  await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 30_000 });
  await shot(page, '67-approve-auth');
});

test('19 approval: ApprovalOverlay via pending auth request on home', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  try {
    await page.evaluate((ts) => {
      (window as any).__TEST__.setPendingAuthRequest({
        challenge: 'a'.repeat(64),
        origin: 'https://couch-arcade.example',
        callback: 'https://couch-arcade.example/cb',
        name: 'Couch Arcade',
        timestamp: ts,
      });
    }, Math.floor(Date.now() / 1000));
    await page.waitForTimeout(1000);
    await shot(page, '68-approval-overlay');
  } catch {
    await shot(page, '68-approval-overlay-ERROR');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Lock screen
// ─────────────────────────────────────────────────────────────────────────

test('20 lock: AuthScreen (PIN pad)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);
  await lockApp(page).catch(() => {});
  await shot(page, '69-auth-screen-locked');
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Dark theme
// ─────────────────────────────────────────────────────────────────────────

test('21 dark theme sweep', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await confirmRealNameIfPrompted(page);

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await shot(page, '70-dark-home-np-card');

  try {
    await colRight(page, 2); // -> settings col
    await page.locator('.gear-fab').click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await shot(page, '71-dark-persona-advanced');
  } catch { /* non-fatal */ }

  try {
    await navigateViaHarness(page, 'settings');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(500);
    await shot(page, '72-dark-settings-menu');
  } catch { /* non-fatal */ }

  try {
    await navigateViaHarness(page, 'settings-security');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(500);
    await shot(page, '73-dark-settings-security');
  } catch { /* non-fatal */ }

  try {
    await navigateViaHarness(page, 'home');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('button', { name: 'Bunker' }).click();
    await page.waitForTimeout(700);
    await shot(page, '74-dark-bunker-panel');
  } catch { /* non-fatal */ }

  try {
    await lockApp(page);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(300);
    await shot(page, '75-dark-auth-screen');
  } catch { /* non-fatal */ }
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Desktop frame (wide viewport, light theme)
// ─────────────────────────────────────────────────────────────────────────

test.describe('desktop frame', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('22 desktop frame: home, settings column, SettingsMenu, persona-advanced', async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
    await confirmRealNameIfPrompted(page);
    await shot(page, '76-desktop-home');

    try {
      await page.getByRole('button', { name: 'Next card' }).click();
      await page.waitForTimeout(450);
      await page.getByRole('button', { name: 'Next card' }).click();
      await page.waitForTimeout(450);
      await page.getByRole('button', { name: 'Next card' }).click();
      await page.waitForTimeout(450);
      await shot(page, '77-desktop-settings-column');

      await page.locator('.gear-fab').click({ timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(500);
      await shot(page, '78-desktop-persona-advanced');
    } catch { /* non-fatal */ }

    try {
      await navigateViaHarness(page, 'settings');
      await page.waitForTimeout(500);
      await shot(page, '79-desktop-settings-menu');
    } catch { /* non-fatal */ }
  });
});
