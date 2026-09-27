import { test, expect, type Page } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { buildPairingUriV2, pairingCode, randomHex } from '@forgesworn/signet-contacts/wire';
import type { Capability } from '@forgesworn/signet-contacts/wire';
import { clearDatabase, createIdentityAndUnlock, unlockWithPin, lockApp, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';
import { CONTACTS_GRANT_DISCONNECT_LABEL, CONTACTS_GRANT_FORGET_LABEL, contactsGrantReplacesCopy } from '../src/lib/contacts-v2-copy';

/**
 * Regression coverage for the App.tsx fix (2026-09-27) that keeps the
 * encryption key alive for a 30s grace while on 'contacts-grant-approve' /
 * 'contacts-grant-code' — a same-phone contacts-v2 pairing requires the user
 * to switch away to read the app's 6-digit code, and an instant
 * visibility-hidden lock previously stranded the in-flight grant/check.
 */

const DIRECTORY_CAP: Capability = 'signet.contacts.read:directory';

/** Build the same-device `?pair=1` web-carrier URL a v2 pairing QR maps to. */
function buildPairUrl(appPubkey: string, appName: string, challenge: string, relay: string) {
  const uri = buildPairingUriV2({
    appPubkey,
    appName,
    capabilities: [DIRECTORY_CAP],
    directory: 'owner',
    relay,
    nowSec: Math.floor(Date.now() / 1000),
    challenge,
  });
  const query = uri.slice(uri.indexOf('?') + 1);
  return `/?pair=1&${query}`;
}

async function hidePage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function showPage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Find the kind-21237 pairing ack Signet published, addressed to `appPubkey`. */
function findAck(network: ReturnType<typeof privateRelays>, appPubkey: string) {
  return [...network.events.values()].find(
    (e) => e.kind === 21237 && e.tags.some((t) => t[0] === 'p' && t[1] === appPubkey),
  );
}

/** Every kind-21237 pairing ack addressed to `appPubkey` — used when the same
 *  app is approved more than once and there is more than one to tell apart. */
function findAcks(network: ReturnType<typeof privateRelays>, appPubkey: string) {
  return [...network.events.values()].filter(
    (e) => e.kind === 21237 && e.tags.some((t) => t[0] === 'p' && t[1] === appPubkey),
  );
}

test.describe('contacts-v2 grant pairing survives a visibility-hidden lock', () => {
  test('approve survives a hide within 30s; the code-check page survives a longer hide with cancel + unlock recovery', async ({ page, context }) => {
    test.setTimeout(120_000);
    const network = privateRelays();
    await network.install(context);

    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    // Let the contacts-device-id mint (requires encryptionKey, gated on
    // !prefsLoading) land in IndexedDB before we navigate away — otherwise
    // Approve can fail on "not ready" for an unrelated reason.
    await page.waitForTimeout(1_000);

    const appSk = hexToBytes('11'.repeat(32));
    const appPubkey = getPublicKey(appSk);
    const challenge = randomHex(16);
    const appName = 'Contact Keeper';
    const relay = 'wss://pair.test';

    await page.goto(buildPairUrl(appPubkey, appName, challenge, relay));

    // Fresh navigation always lands locked — unlock to reach the approve page.
    await unlockWithPin(page);
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('is asking to use your contacts')).toBeVisible({ timeout: 15_000 });

    // --- Case 1: hide within the 30s grace, show again — still unlocked. ---
    await hidePage(page);
    await page.waitForTimeout(3_000);
    await showPage(page);

    // No PIN prompt, still on the approve page, unlocked.
    await expect(page.getByRole('button', { name: '1', exact: true })).toHaveCount(0);
    await expect(page.getByText('is asking to use your contacts')).toBeVisible();

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Check the code' })).toBeVisible({ timeout: 20_000 });

    // Recover the real grantId/railPubkey from the ack Signet just published,
    // and compute the SAME 6-digit code the consuming app would show on
    // screen — this is the "app side" of the check, done by decrypting the
    // ack rather than a live SDK relay round-trip (documented per the brief).
    await expect.poll(() => !!findAck(network, appPubkey), { timeout: 20_000 }).toBe(true);
    const ack = findAck(network, appPubkey)!;
    const conversationKey = nip44.v2.utils.getConversationKey(appSk, ack.pubkey);
    const ackJson = JSON.parse(nip44.v2.decrypt(ack.content, conversationKey)) as {
      grantId: string; railPubkey: string; challenge: string;
    };
    expect(ackJson.challenge).toBe(challenge);
    const code = pairingCode({
      appPubkey, challenge, grantId: ackJson.grantId, railPubkey: ackJson.railPubkey,
    });

    // --- Case 2: on "Check the code", hide for MORE than 30s. ---
    await hidePage(page);
    await page.waitForTimeout(32_000);
    await showPage(page);

    // The grace window lapsed: a PIN prompt appears (rather than silently
    // dropping back to Home or a dead screen).
    await Promise.race([
      page.getByRole('button', { name: 'Use PIN instead' }).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
      page.getByRole('button', { name: '1', exact: true }).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
    ]);
    const pinSwitch = page.getByRole('button', { name: 'Use PIN instead' });
    if (await pinSwitch.isVisible().catch(() => false)) await pinSwitch.click();
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible({ timeout: 10_000 });

    // Cancel the prompt: the check must be KEPT, and the page must show the
    // Unlock recovery copy — never fall through to Home.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Unlock to finish checking the code. Nothing has been lost.')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.carousel-viewport')).toHaveCount(0);

    // Tap Unlock, enter the PIN, and land back on "Check the code" intact.
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await unlockWithPin(page);
    await expect(page.locator('main').getByRole('heading', { name: 'Check the code' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('6-digit code')).toBeVisible();

    // The correct code gives the match message.
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText(/The codes match\./)).toBeVisible({ timeout: 10_000 });
  });

  test('a locked arrival at the approve page prompts for PIN, and Approve then works', async ({ page, context }) => {
    test.setTimeout(60_000);
    const network = privateRelays();
    await network.install(context);

    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await page.waitForTimeout(1_000);

    // Lock first, then load the ?pair=1 carrier — a fresh navigation always
    // lands locked regardless, but this mirrors "the phone was locked when
    // the pairing link arrived".
    await lockApp(page);

    const appSk = hexToBytes('22'.repeat(32));
    const appPubkey = getPublicKey(appSk);
    const challenge = randomHex(16);
    const appName = 'Locked Arrival App';
    const relay = 'wss://pair2.test';

    await page.goto(buildPairUrl(appPubkey, appName, challenge, relay));

    // Case 3: the PIN prompt must appear automatically — 'contacts-grant-approve'
    // is in `signingPages` — rather than leaving Approve to fail with
    // "not ready" for a device that was never asked to unlock.
    await unlockWithPin(page);
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('is asking to use your contacts')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('This device is not ready to connect an app to your contacts yet.')).toHaveCount(0);
    await expect(page.locator('main').getByRole('heading', { name: 'Check the code' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => !!findAck(network, appPubkey), { timeout: 20_000 }).toBe(true);
  });

  test('re-approving the same app on the same directory supersedes the earlier grant', async ({ page, context }) => {
    test.setTimeout(90_000);
    const network = privateRelays();
    await network.install(context);

    await clearDatabase(page);
    await createIdentityAndUnlock(page);
    await page.waitForTimeout(1_000);

    const appSk = hexToBytes('33'.repeat(32));
    const appPubkey = getPublicKey(appSk);
    const appName = 'Repeat App';
    const relay = 'wss://pair3.test';

    async function approveAndCheck(challenge: string) {
      await page.goto(buildPairUrl(appPubkey, appName, challenge, relay));
      await unlockWithPin(page);
      await expect(page.getByText('is asking to use your contacts')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.locator('main').getByRole('heading', { name: 'Check the code' })).toBeVisible({ timeout: 20_000 });

      const seenBefore = findAcks(network, appPubkey).length;
      await expect.poll(() => findAcks(network, appPubkey).length, { timeout: 20_000 }).toBeGreaterThan(seenBefore - 1);
      const ack = findAcks(network, appPubkey).at(-1)!;
      const conversationKey = nip44.v2.utils.getConversationKey(appSk, ack.pubkey);
      const ackJson = JSON.parse(nip44.v2.decrypt(ack.content, conversationKey)) as {
        grantId: string; railPubkey: string; challenge: string;
      };
      expect(ackJson.challenge).toBe(challenge);
      const code = pairingCode({
        appPubkey, challenge, grantId: ackJson.grantId, railPubkey: ackJson.railPubkey,
      });

      await page.getByLabel('6-digit code').fill(code);
      await page.getByRole('button', { name: 'Check', exact: true }).click();
      await expect(page.getByText(/The codes match\./)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      return ackJson.grantId;
    }

    const firstGrantId = await approveAndCheck(randomHex(16));
    expect(firstGrantId).toBeTruthy();

    // Re-approve the SAME app on the SAME (owner) directory. The approve
    // screen must say up front that this replaces the earlier connection.
    await page.goto(buildPairUrl(appPubkey, appName, randomHex(16), relay));
    await unlockWithPin(page);
    await expect(page.getByText('is asking to use your contacts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(contactsGrantReplacesCopy(appName))).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Check the code' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => findAcks(network, appPubkey).length, { timeout: 20_000 }).toBeGreaterThan(1);
    const secondAck = findAcks(network, appPubkey).at(-1)!;
    const conversationKey2 = nip44.v2.utils.getConversationKey(appSk, secondAck.pubkey);
    const secondAckJson = JSON.parse(nip44.v2.decrypt(secondAck.content, conversationKey2)) as {
      grantId: string; railPubkey: string; challenge: string;
    };
    const secondCode = pairingCode({
      appPubkey, challenge: secondAckJson.challenge, grantId: secondAckJson.grantId, railPubkey: secondAckJson.railPubkey,
    });
    expect(secondAckJson.grantId).not.toBe(firstGrantId);

    await page.getByLabel('6-digit code').fill(secondCode);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText(/The codes match\./)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    // Once the exit-time supersede has run, Companion apps shows exactly one
    // ACTIVE (Disconnect-able) row for this app, and the earlier grant is the
    // ended row (Forget-able) — never two live rows for the same app.
    await navigateViaHarness(page, 'companion-apps');
    await expect(page.getByText(appName).first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(
      () => page.getByRole('button', { name: CONTACTS_GRANT_FORGET_LABEL }).count(),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: CONTACTS_GRANT_DISCONNECT_LABEL })).toHaveCount(1);
  });
});
