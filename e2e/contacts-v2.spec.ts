import { test, expect, Page } from '@playwright/test';
import { nip19 } from 'nostr-tools';
import { privateRelays } from './helpers/private-relays';

test.beforeEach(async ({ context }) => { await privateRelays().install(context); });
import { createIdentityAndUnlock, clearDatabase, navigateViaHarness } from './fixtures';
import {
  tierChipLabel, tierProvenanceSuffix,
  CANCEL_LABEL, CONFIRM_LABEL, CONTACTS_GRANTS_LIST_TITLE, CONTACTS_GRANTS_LIST_EMPTY,
  CONTACTS_GRANT_CAPABILITY_COPY, CONTACTS_GRANT_DISCONNECT_LABEL, CONTACTS_GRANT_FORGET_LABEL,
  contactsGrantDisconnectConfirm,
} from '../src/lib/contacts-v2-copy';

/** A well-known secp256k1 x-coordinate, reused from `e2e/family.spec.ts` as a stand-in real pubkey. */
const TEST_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

/**
 * Adding a dependant, or reaching a dependant's Advanced page, both need the
 * guardian's real identity active first (spec §7.3 — "you are the guardian on
 * record"). A fresh `createIdentityAndUnlock` identity has it dormant, so
 * `navigateViaHarness(page, 'add-dependant')` lands on the RequireRealIdentity
 * gate instead of the form. Walk the real activation ceremony (explanation →
 * legal name → typed confirm → first-backup words) the same way
 * `e2e/_capture-ux-audit.spec.ts` does — it's a no-op when the gate isn't
 * showing (npActive already true).
 */
/**
 * `Locator.isVisible()` checks the current state and does not poll — the
 * async writes below (activating the real identity persists an encrypted
 * identity record) can easily outlast a snapshot check taken the instant the
 * previous action resolves. `waitFor` is the actual polling wait.
 */
async function waitVisible(locator: ReturnType<Page['getByRole']>, timeout: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
}

async function activateRealIdentityIfGated(page: Page, legalName = 'Guardian Person') {
  const activate = page.getByRole('button', { name: 'Activate my real identity' });
  if (!(await waitVisible(activate, 3_000))) return;
  await activate.click();
  await page.locator('#legal-name').fill(legalName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder(legalName).fill(legalName);
  await page.getByRole('button', { name: 'Activate my real identity' }).click();
  // Fresh identity + never backed up ⇒ the first-backup words step follows,
  // once the async activation write resolves.
  const checkbox = page.getByRole('checkbox');
  if (await waitVisible(checkbox, 30_000)) {
    await checkbox.click();
    await page.getByRole('button', { name: 'Done' }).click();
  }
}

async function addKeylessContact(page: Page, name: string, email?: string) {
  await navigateViaHarness(page, 'contact-new');
  await page.getByLabel('Name').fill(name);
  if (email) await page.getByLabel('Email (optional)').fill(email);
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });
}

async function addDependant(page: Page, name: string) {
  await navigateViaHarness(page, 'add-dependant');
  await activateRealIdentityIfGated(page);
  await page.getByLabel(/Their name/i).fill(name);
  await page.getByRole('button', { name: 'Create identity' }).click();
  await expect(page.getByText(new RegExp(`${name}'s identity is ready`))).toBeVisible({ timeout: 60_000 });
}

/**
 * Wait for the carousel to actually settle on `index` along `axis`, instead
 * of a fixed sleep. `NavDots` (`src/components/NavDots.tsx`) renders one dot
 * per row/column and gives the CURRENT one an `active` class off the exact
 * same `row`/`col` props `Carousel` uses to pick which card renders in
 * `.carousel-screen` — so ".active` on dot N" and "card N is what's on
 * screen" update in the same React commit. That makes the dot a reliable
 * settle marker: no separate `data-*` attribute exposes `animating` directly,
 * but this is the state it gates.
 */
async function waitForCarouselSettled(page: Page, axis: 'v' | 'h', index: number) {
  await expect(page.locator(`.nav-dots-${axis} .nav-dot`).nth(index)).toHaveClass(/active/, { timeout: 5_000 });
}

/**
 * The dependant's Advanced page (`persona-advanced` with a `depPubkey`
 * target) has no direct harness route — `pendingPersonaAdvancedTarget` is
 * only ever set by the carousel card's gear-fab
 * (`src/components/SettingsCard.tsx`), which also supplies the dependant id
 * the route needs. Reach it the way a guardian actually would: back to Home,
 * step the carousel down to the dependant's card, across to its settings
 * column, then the gear-fab. The carousel always lands here at row 0 / col 0
 * (a fresh Home render, first carousel interaction of the test).
 */
async function openDependantAdvanced(page: Page, dependantName: string) {
  await page.getByRole('button', { name: /Done for now/ }).click();
  await expect(page.locator('.carousel-viewport')).toBeVisible({ timeout: 10_000 });

  const card = page.getByText(dependantName, { exact: false }).first();
  let row = 0;
  for (let i = 0; i < 8 && !(await card.isVisible().catch(() => false)); i++) {
    await page.keyboard.press('ArrowDown');
    row += 1;
    await waitForCarouselSettled(page, 'v', row);
  }
  await expect(card).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press('ArrowRight');
  await waitForCarouselSettled(page, 'h', 1);
  await page.keyboard.press('ArrowRight');
  await waitForCarouselSettled(page, 'h', 2);
  await page.keyboard.press('ArrowRight');
  await waitForCarouselSettled(page, 'h', 3);
  await page.locator('.gear-fab').click({ timeout: 8_000 });
}

/**
 * Pin a real public key as a ken (`KenAdd`'s hex-paste flow), with a display
 * name. Share/Vouch in the family manager need a real identity to copy —
 * `shareableIdentities` (`src/lib/contacts-v2-family-ops.ts`) reads the
 * source's `identities`, which is empty for a keyless contact — so this
 * submits a real npub rather than only switching `KenAdd` to paste mode.
 */
async function addKenContact(page: Page, name: string, pubkeyHex: string) {
  await navigateViaHarness(page, 'ken-add');
  await page.getByRole('button', { name: 'Paste an npub' }).click();
  await page.getByPlaceholder('npub1…').fill(nip19.npubEncode(pubkeyHex));
  await page.getByPlaceholder('Display name (optional)').fill(name);
  await page.getByRole('button', { name: 'Pin key' }).click();
  await expect(page.getByRole('heading', { name: `${name} added` })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Done' }).click();
}

test.describe('Contacts v2', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('opens scoped contacts from the five-column carousel and keeps the column between rows', async ({ page }) => {
    await addKeylessContact(page, 'Corner Shop');
    await navigateViaHarness(page, 'home');
    await expect(page.locator('.nav-dots-h .nav-dot')).toHaveCount(5);
    await page.keyboard.press('ArrowRight');
    await waitForCarouselSettled(page, 'h', 1);
    await page.keyboard.press('ArrowRight');
    await waitForCarouselSettled(page, 'h', 2);
    await expect(page.getByRole('heading', { name: 'Test User’s contacts' })).toBeVisible();
    await expect(page.getByText('Corner Shop', { exact: true })).toBeVisible();
    const search = page.getByRole('searchbox');
    await search.fill('Corner');
    await search.press('ArrowLeft');
    await waitForCarouselSettled(page, 'h', 2);
    await search.blur();
    await page.keyboard.press('ArrowDown');
    await waitForCarouselSettled(page, 'v', 1);
    await waitForCarouselSettled(page, 'h', 2);
    await page.keyboard.press('ArrowUp');
    await waitForCarouselSettled(page, 'v', 0);
    await waitForCarouselSettled(page, 'h', 2);
    await page.getByRole('searchbox').fill('Corner');
    await page.getByRole('button', { name: 'View contacts', exact: true }).click();
    await expect(page.getByRole('button', { name: /Open Corner Shop/ })).toBeVisible();
    await expect(page.getByPlaceholder('Search contacts')).toHaveValue('Corner');
  });

  test('adds a contact with no Nostr key and marks it unverified', async ({ page }) => {
    await addKeylessContact(page, 'Corner Shop');
    await navigateViaHarness(page, 'contacts');
    await expect(page.getByText('Corner Shop')).toBeVisible();
    await expect(page.getByText('No key verified')).toBeVisible();
  });

  test('blocks and unblocks from the detail page, and filters Blocked', async ({ page }) => {
    await addKeylessContact(page, 'Dave');
    await navigateViaHarness(page, 'contacts');
    await page.getByRole('button', { name: /Open Dave/ }).click();

    await page.getByRole('button', { name: 'Block' }).click();
    await page.getByLabel('Reason (optional)').fill('spam');
    await page.getByRole('button', { name: 'Block Dave' }).click();
    await expect(page.getByText('Blocked by you')).toBeVisible();

    await navigateViaHarness(page, 'contacts');
    await page.getByRole('button', { name: 'Kin' }).click();
    await expect(page.getByText('Dave')).toHaveCount(0);
    await page.getByRole('button', { name: 'Blocked' }).click();
    await expect(page.getByText('Dave')).toBeVisible();

    await page.getByRole('button', { name: /Open Dave/ }).click();
    await page.getByRole('button', { name: 'Unblock' }).click();
    await expect(page.getByRole('button', { name: 'Block' })).toBeVisible();
  });

  test('shares and vouches from the family manager', async ({ page }) => {
    // C0 (fixed): `FamilyContacts.tsx` `confirmBulk`/`cellAction` used to push
    // every `add-identity` request as `{ ..., value: id }` where `id` is
    // `contacts-v2-family-ops.ts`'s `shareableIdentities()` output, typed
    // `Omit<AddIdentityValue, 'itemId'>` — no `itemId` was ever attached, so
    // the reducer's `validateOperation` rejected every one of these ops and
    // `applyOps` threw mid-batch. Fixed by minting a fresh `itemId` at the
    // point each request is built (`addIdentityRequests` in
    // `FamilyContacts.tsx`), the same way `useContactsV2.ts`'s `addIdentity`
    // already did for the single-directory path. Unit-covered by
    // `FamilyContacts.test.tsx`'s "every request confirmBulk builds … is
    // independently valid" test, which runs every request through
    // `buildOperation` + `validateOperation`. This is the live end-to-end
    // confirmation.

    await addDependant(page, 'Sam');
    await addKenContact(page, 'Dave', TEST_PUBKEY);
    // The reimport hook (debounced, `useContactsV2Reimport`) folds the new
    // `ken` row into a v2 record — wait for it to land in the owner's own
    // Contacts before touching the family manager, so Share/Vouch below act
    // on the real record rather than a still-pending import.
    await navigateViaHarness(page, 'contacts');
    await expect(page.getByText('Dave')).toBeVisible({ timeout: 20_000 });

    await navigateViaHarness(page, 'family-list');
    await page.getByRole('button', { name: 'Manage contacts across the family' }).click();
    // Tier-1 gate: the app is already unlocked, so the cached key satisfies it.
    // `exact: true` — a loose match also catches "1 of 2 directories" row-sub text.
    await expect(page.getByText('Directories', { exact: true })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /Dave/ }).click();
    // Scoped to the `<div className="row">` for Sam's directory specifically
    // (a `<div>`, not the `<button class="row row-button">` row header) — the
    // bulk-selection checkbox row below is also class "row" and also
    // contains "Sam", but only while its panel is open, never at the same
    // time as the assertions below (each waits until its Confirm closes the
    // panel first). `.row-sub` (rather than the whole row) because
    // `cellSummary()`'s text and `ContactTierChip`'s own badge text can both
    // read "Ken" at once — two matches for a bare `getByText`.
    const samRow = page.locator('div.row', { hasText: 'Sam' });
    const samRowSummary = samRow.locator('.row-sub');

    // Share: copies name + public keys only, landing in Sam's directory as a
    // direct Ken record — present, no provenance suffix (not vouched).
    // `cellSummary()` is `tierChipLabel(tier)` with no suffix here, but the
    // row-sub itself is `${cell.localName} · ${cellSummary(cell)}` once a
    // local name is present (FamilyContacts.tsx) — the shared source is
    // "Dave", so it prefixes both expectations below.
    await page.getByRole('button', { name: 'Share with my dependants' }).click();
    await page.getByRole('checkbox', { name: 'Sam' }).check();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(samRowSummary).toHaveText(`Dave · ${tierChipLabel('ken')}`, { timeout: 20_000 });

    // Vouch: adds a revocable vouch on top of that same record, at Kin with a
    // role — the cell's effective tier and provenance both move.
    // `cellSummary()` passes `guardianName: null` to `tierProvenanceSuffix`
    // regardless of the real guardian's name, unlike `ContactTierChip`'s own
    // badge — so this exact string is the row-sub text specifically.
    await page.getByRole('button', { name: 'Vouch as Kin for…' }).click();
    await page.getByRole('checkbox', { name: 'Sam' }).check();
    await page.getByLabel('Role for Sam').fill('Family friend');
    await page.getByRole('button', { name: 'Confirm' }).click();
    const vouchedCell = `Dave · ${tierChipLabel('kin')} ${tierProvenanceSuffix('guardian-vouched', null)}`;
    await expect(samRowSummary).toHaveText(vouchedCell, { timeout: 20_000 });

    // The vouch is FOR Sam's directory only — Dave's own record in the
    // owner's directory (the vouch source) stays a plain Ken, untouched.
    await navigateViaHarness(page, 'contacts');
    const daveRow = page.getByRole('button', { name: /Open Dave/ });
    await expect(daveRow.getByText(tierChipLabel('ken'), { exact: true })).toBeVisible();
  });

  test('requires a contacts choice before removing a dependant', async ({ page }) => {
    await addDependant(page, 'Sam');
    await openDependantAdvanced(page, 'Sam');
    const remove = page.getByRole('button', { name: 'Remove Sam' });
    await expect(remove).toBeDisabled();
    await page.getByRole('button', { name: 'Archive contacts' }).click();
    await expect(page.getByText(/stay as an encrypted read-only snapshot/)).toBeVisible();
    await expect(remove).toBeEnabled();
  });
});

/**
 * The connected-apps v2 list.
 *
 * The real approval path cannot be driven headlessly — the pairing ack is a
 * hard gate (Task 22 ruling), so without a reachable rendezvous relay every
 * approval fails by design. `__TEST__.seedContactsGrantV2` writes the row
 * through the same encrypted writer the approval handler uses and bumps the
 * same version, so everything downstream of the ack — which is the half this
 * list renders — is genuinely exercised.
 */
test.describe('Contacts v2 — connected apps', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  async function seedGrant(page: Page, grantId: string, appName: string) {
    await page.evaluate(
      ([id, name]) => (window as unknown as { __TEST__: { seedContactsGrantV2: (g: unknown) => Promise<void> } })
        .__TEST__.seedContactsGrantV2({ grantId: id, appName: name }),
      [grantId, appName] as const,
    );
  }

  test('says so plainly when no app is connected', async ({ page }) => {
    await navigateViaHarness(page, 'companion-apps');
    await expect(page.getByRole('heading', { name: CONTACTS_GRANTS_LIST_TITLE })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(CONTACTS_GRANTS_LIST_EMPTY)).toBeVisible();
  });

  test('lists a live grant with its capabilities in plain English', async ({ page }) => {
    await navigateViaHarness(page, 'companion-apps');
    await expect(page.getByRole('heading', { name: CONTACTS_GRANTS_LIST_TITLE })).toBeVisible({ timeout: 20_000 });
    await seedGrant(page, 'f'.repeat(32), 'Flock');

    await expect(page.getByText('Flock')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:directory'])).toBeVisible();
    // Every capability line is the copy module's, never a raw capability id.
    await expect(page.getByText(/signet\.contacts\./)).toHaveCount(0);
    await expect(page.getByRole('button', { name: CONTACTS_GRANT_DISCONNECT_LABEL })).toBeVisible();
  });

  test('disconnects behind an inline confirm, then offers Forget on the ended row', async ({ page }) => {
    await navigateViaHarness(page, 'companion-apps');
    await expect(page.getByRole('heading', { name: CONTACTS_GRANTS_LIST_TITLE })).toBeVisible({ timeout: 20_000 });
    await seedGrant(page, 'e'.repeat(32), 'Flock');
    await expect(page.getByText('Flock')).toBeVisible({ timeout: 20_000 });

    // Disconnect is a two-step: the confirm carries the honesty line about
    // what revocation cannot undo, which is the whole point of the pause.
    await page.getByRole('button', { name: CONTACTS_GRANT_DISCONNECT_LABEL }).click();
    await expect(page.getByText(contactsGrantDisconnectConfirm('Flock'))).toBeVisible();
    await page.getByRole('button', { name: CANCEL_LABEL }).click();
    await expect(page.getByRole('button', { name: CONTACTS_GRANT_DISCONNECT_LABEL })).toBeVisible();

    await page.getByRole('button', { name: CONTACTS_GRANT_DISCONNECT_LABEL }).click();
    await page.getByRole('button', { name: CONFIRM_LABEL }).click();

    // The local row is the authority: it reads as ended immediately, whatever
    // the (unreachable, in this harness) relay does with the tombstone.
    const forget = page.getByRole('button', { name: CONTACTS_GRANT_FORGET_LABEL });
    await expect(forget).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: CONTACTS_GRANT_DISCONNECT_LABEL })).toHaveCount(0);

    // R-13: a revoked row is kept for audit until the owner drops it.
    await forget.click();
    await expect(page.getByText(CONTACTS_GRANTS_LIST_EMPTY)).toBeVisible({ timeout: 20_000 });
  });
});
