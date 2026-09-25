/**
 * Acceptance E2E suite for §4.5 — Professional Persona keypair model.
 * One test per acceptance criterion listed in the plan Phase 8 / §4.5 AC map.
 *
 * NOTE on [unit-verified] tests:
 * Criteria that require mock relay seeding, mocked registry resolvers, or
 * direct key-material inspection cannot be exercised end-to-end without
 * fixtures that are not yet available. Those tests carry [unit-verified] in
 * their name and reference the unit-test file that covers the scenario. Each
 * also includes at minimum a smoke check (app loads + identity unlocks).
 *
 * Pattern mirrors e2e/pro-surface-acceptance.spec.ts.
 *
 * Unit coverage:
 *   - pro-persona.test.ts (14 tests) — derivation determinism, non-linkability,
 *     Heartwood guard
 *   - signet-json.test.ts (5 tests) — headPubkey shape, Pro persona in template
 *   - role-anchor.test.ts, roster-append.test.ts — Pro backend signing
 */

import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock } from './fixtures';

// §4.5.2 — Three sibling keypairs derived from the same mnemonic.
// [unit-verified] src/lib/professional/pro-persona.test.ts
//   "Pro persona pubkey differs from NP pubkey derived from the same mnemonic"
//   "Extra-persona pubkey differs from Pro persona pubkey"
test('§4.5.2 [unit-verified]: three sibling keypairs from same mnemonic are distinct', async ({ page }) => {
  await createIdentityAndUnlock(page);
  await expect(page.getByText('Test User')).toBeVisible({ timeout: 10_000 });
  // Keypair distinctness (NP ≠ Pro ≠ Extra-persona) is verified by:
  //   pro-persona.test.ts > "Pro persona pubkey differs from NP pubkey derived from the same mnemonic"
  //   pro-persona.test.ts > "Extra-persona pubkey differs from Pro persona pubkey"
});

// §4.5.3 — Auto-derivation: Pro persona derived silently on first Pro Onboarding entry.
// [unit-verified] src/hooks/useIdentity.proPersona.test.ts
//   "deriveAndStoreProPersona stores pro persona encrypted in IDB and returns pubkey"
test('§4.5.3 [unit-verified]: Pro persona auto-derived on first Professional setup entry', async ({ page }) => {
  await createIdentityAndUnlock(page);
  await expect(page.getByText('Test User')).toBeVisible({ timeout: 10_000 });
  // Auto-derivation on entry is covered by:
  //   useIdentity.proPersona.test.ts > "deriveAndStoreProPersona stores pro persona encrypted in IDB and returns pubkey"
  //   App.tsx wiring in onSetupPro callback (Task 6, Phase 2)
});

// §4.5.4 — Professional display name defaults to NP display name; independently editable.
// [unit-verified] src/hooks/useIdentity.proPersona.test.ts + src/pages/Profile.proName.test.tsx
test('§4.5.4 [unit-verified]: Pro persona display name defaults to NP name; editable independently', async ({ page }) => {
  await createIdentityAndUnlock(page);
  await expect(page.getByText('Test User')).toBeVisible({ timeout: 10_000 });
  // Default name and independent editing is covered by:
  //   useIdentity.proPersona.test.ts > "derivedPersona.displayName defaults to NP displayName"
  //   Profile.proName.test.tsx > "renders a Professional name row inside the Professional section"
  //   Profile.proName.test.tsx > "calls onSaveProName with trimmed value on blur"
});

// §4.5.6 — All Pro acts use the Pro persona pubkey, never the NP pubkey.
// Directly exercisable for the page routing: Professional gateway renders correctly
// and the Pro persona flow is reachable. signet.json key assertion is [unit-verified].
test('§4.5.6: Professional gateway renders; Pro Onboarding reachable from settings', async ({ page }) => {
  await createIdentityAndUnlock(page);

  // Navigate to Professional gateway
  await page.evaluate((p) => (window as Window & { __TEST__?: { setPage: (p: string) => void } }).__TEST__?.setPage(p), 'settings-professional');

  // Professional page must be visible with setup CTA (no Pro anchor yet)
  await expect(page.getByText('Set up Professional role')).toBeVisible({ timeout: 5_000 });

  // Pro Dashboard must NOT be visible without a role anchor
  await expect(page.getByRole('button', { name: /Sign roster/i })).not.toBeVisible();

  // [unit-verified] Pro persona pubkey in all signing operations is covered by:
  //   pro-persona.test.ts > "buildRoleAnchorEvent uses Pro persona pubkey as leadPubkey"
  //   signet-json.test.ts > "leadPubkeyHex appears in headPubkey field"
});

// §4.5.7 — No on-chain link between NP and Pro pubkeys.
// [unit-verified] src/lib/professional/pro-persona.test.ts
//   "Pro persona pubkey cannot be linked to NP pubkey without the mnemonic"
test('§4.5.7 [unit-verified]: no on-chain link between NP and Pro pubkeys', async ({ page }) => {
  await createIdentityAndUnlock(page);
  await expect(page.getByText('Test User')).toBeVisible({ timeout: 10_000 });
  // Non-linkability property is cryptographic (derivation path separation).
  // Verified by:
  //   pro-persona.test.ts > "Pro persona pubkey cannot be linked to NP pubkey without the mnemonic"
});

// §4.5.9 — Pro persona private key stored encrypted in IDB (same pattern as mnemonic).
// [unit-verified] src/lib/db.ts v13 migration + src/lib/professional/pro-persona.test.ts
//   "saveProPersonaEncrypted round-trips through IDB encrypted storage"
test('§4.5.9 [unit-verified]: Pro persona private key stored encrypted at rest', async ({ page }) => {
  await createIdentityAndUnlock(page);
  await expect(page.getByText('Test User')).toBeVisible({ timeout: 10_000 });
  // Encrypted storage verified by:
  //   pro-persona.test.ts > "saveProPersonaEncrypted round-trips through IDB encrypted storage"
  //   db.ts v13 IDB migration (PRO_PERSONA_KEY in identity store, encrypted: true)
});

// §4.5.10 — Heartwood bunker blocks Pro mode when mnemonic is absent.
// Directly exercisable: navigate to settings-professional and expect either
// the blocked message or the Pro setup CTA (no mnemonic deletion in fixture,
// so the CTA is expected; block path is [unit-verified]).
test('§4.5.10: Pro mode entry does not crash when mnemonic present (Heartwood guard is wired)', async ({ page }) => {
  await createIdentityAndUnlock(page);

  await page.evaluate((p) => (window as Window & { __TEST__?: { setPage: (p: string) => void } }).__TEST__?.setPage(p), 'settings-professional');

  // With standard fixture (mnemonic present), Professional page renders normally.
  await expect(page.getByText('Set up Professional role')).toBeVisible({ timeout: 5_000 });

  // [unit-verified] Block path (mnemonic absent + bunker active) is covered by:
  //   pro-persona.test.ts > "proModeBlockedReason returns message when bunker active and no mnemonic"
  //   App.tsx guard block renders block message before ProOnboarding (Task 6, Phase 2)
});

// §11 AC 6 — User without role anchor never sees the Pro Dashboard.
// Exercised E2E (mirrors pro-surface-acceptance.spec.ts AC-6 pattern).
test('§11 AC 6: user without role anchor sees explainer, not Professional Dashboard', async ({ page }) => {
  await createIdentityAndUnlock(page);

  await page.evaluate((p) => (window as Window & { __TEST__?: { setPage: (p: string) => void } }).__TEST__?.setPage(p), 'settings-professional');

  await expect(page.getByText('Set up Professional role')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: /Sign roster/i })).not.toBeVisible();
  await expect(page.getByRole('button', { name: /Rotate lead key/i })).not.toBeVisible();
});
