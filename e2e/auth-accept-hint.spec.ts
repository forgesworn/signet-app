import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock, restoreIdentityAndUnlock, clearDatabase } from './fixtures';

/**
 * Sign-in-with-Signet `accept=` consumer-hint flows. Exercises the four scenarios called out
 * in the original scope-locking comment:
 *   - filter-match (accept=persona with persona available)
 *   - filter-empty inline-add (accept=persona with no persona → Add persona now)
 *   - NP-only + ceiling (selecting NP requires explicit confirmation)
 *   - accept_reason caption surfaces consumer's string
 */

function buildUrl(params: Record<string, string>) {
  const base = new URLSearchParams({
    auth: '1',
    challenge: 'a'.repeat(64),
    origin: 'https://example.com',
    callback: 'https://example.com/callback',
    t: String(Math.floor(Date.now() / 1000)),
    name: 'TestSite',
    ...params,
  });
  return '/?' + base.toString();
}

async function unlock(page: import('@playwright/test').Page) {
  const pinButton = page.getByRole('button', { name: 'Use PIN instead' });
  if (await pinButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await pinButton.click();
  }
  for (const digit of '123456') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

test.describe('Sign in with Signet — accept= consumer hint', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('accept=persona with persona available → NP hidden, persona selected', async ({ page }) => {
    // The default fixture identity (persona-primary, NP dormant) already
    // excludes NP from the picker by construction (spec §6) — that proves
    // nothing about the accept= HINT filter specifically. Use an identity
    // with an ACTIVE NP (named "Test User" here) so "NP hidden" is actually
    // exercising the hint, not just dormancy.
    await clearDatabase(page);
    await restoreIdentityAndUnlock(page, { keypair: 'natural-person' });
    await page.goto(buildUrl({ accept: 'persona' }));
    await unlock(page);

    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });

    // The default caption (no accept_reason supplied) is deterministic.
    await expect(page.getByText('This site asked for a persona')).toBeVisible();

    // Persona row is shown; the NP row (by default name "Test User") is not.
    await expect(page.getByRole('button', { name: /Test User/ })).not.toBeVisible();

    // Approving just works — persona is the default selection.
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });
    expect(page.url()).toContain('pubkey=');
    expect(page.url()).not.toContain('fromNP=true');
  });

  test('accept_reason caption displays consumer-supplied text', async ({ page }) => {
    await page.goto(buildUrl({
      accept: 'persona',
      accept_reason: 'AxeNStax uses persona identities for player privacy',
    }));
    await unlock(page);

    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('AxeNStax uses persona identities for player privacy')).toBeVisible();
  });

  test('accept=persona with no persona → empty state with inline add + NP fallback', async ({ page }) => {
    // The NP fallback only renders for an ACTIVATED real identity (spec §6 /
    // ApproveAuth's np-dormant exclusion) — the default `createIdentityAndUnlock`
    // fixture leaves NP dormant, so this case needs an identity restored onto
    // the NP slot instead. We force the empty-state by asking for
    // extra-persona, which is reliably absent on a fresh identity either way.
    await clearDatabase(page);
    await restoreIdentityAndUnlock(page, { keypair: 'natural-person' });
    await page.goto(buildUrl({ accept: 'extra-persona' }));
    await unlock(page);

    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });

    // Empty-state card is visible.
    await expect(page.getByText("This site asked for an extra persona")).toBeVisible();

    // Inline add-persona button is present.
    await expect(page.getByRole('button', { name: 'Add persona now' })).toBeVisible();

    // NP fallback is also present.
    await expect(page.getByRole('button', { name: /Sign in with my .* instead/ })).toBeVisible();
  });

  test('NP fallback → confirmation gate + fromNP=true in redirect', async ({ page }) => {
    // Same reason as the previous case — the NP fallback needs an activated
    // real identity to render at all.
    await clearDatabase(page);
    await restoreIdentityAndUnlock(page, { keypair: 'natural-person' });
    await page.goto(buildUrl({ accept: 'extra-persona' }));
    await unlock(page);

    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });

    // Take the NP fallback.
    await page.getByRole('button', { name: /Sign in with my .* instead/ }).click();

    // NP-ceiling confirmation card appears.
    await expect(page.getByText("You're about to sign in with your real-name identity")).toBeVisible();

    // Approve is disabled until the confirmation button is tapped.
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeDisabled();

    // Confirm, then approve.
    await page.getByRole('button', { name: 'Yes, use my real-name identity' }).click();
    await expect(approve).toBeEnabled();
    await approve.click();

    // Redirect carries fromNP=true.
    await page.waitForURL(/example\.com\/callback/, { timeout: 10_000 });
    expect(page.url()).toContain('fromNP=true');
  });

  test('no accept param → unchanged behaviour (all keypairs shown)', async ({ page }) => {
    // Sanity: legacy consumers that don't send accept= still see today's UX —
    // every available keypair, unfiltered. `guardianOptions` excludes a
    // dormant real identity unconditionally (spec §6), so this needs an
    // identity with an ACTIVATED NP to prove "no hint" really means
    // "unfiltered" rather than accidentally passing because NP is hidden
    // anyway.
    await clearDatabase(page);
    await restoreIdentityAndUnlock(page, { keypair: 'natural-person' });
    await page.goto(buildUrl({}));
    await unlock(page);

    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });

    // No caption above the picker.
    await expect(page.getByText('This site asked for')).not.toBeVisible();

    // NP row is present.
    await expect(page.getByRole('button', { name: /Test User/ })).toBeVisible();
  });
});
