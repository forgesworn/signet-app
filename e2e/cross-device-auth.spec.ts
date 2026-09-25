import { test, expect } from '@playwright/test';
import { confirmRealNameIfPrompted, createIdentityAndUnlock, clearDatabase } from './fixtures';
import { waitForAuthResponse } from '../../signet-verify/src/signet-verify';
import { generateSecretKey } from 'nostr-tools/pure';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const RELAY = process.env.E2E_RELAY_URL ?? 'wss://relay.trotters.cc';
const ORIGIN = 'https://example.com';

test.describe('Sign in with Signet — cross-device relay delivery', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('approve publishes auth response via relay; consumer receives and verifies', async ({ page }) => {
    // ── Consumer side (Node): generate session keypair, start subscription ──
    const sessionPrivKey = generateSecretKey();
    const sessionPubkey = bytesToHex(schnorr.getPublicKey(sessionPrivKey));
    const challenge = bytesToHex(
      sha256(new TextEncoder().encode('e2e-' + Date.now())),
    );

    const authPromise = waitForAuthResponse({
      requestId: challenge,
      relayUrl: RELAY,
      sessionPrivKey,
      expectedOrigin: ORIGIN,
      timeout: 30_000,
    });

    // Small grace so the REQ is in before publish
    await page.waitForTimeout(500);

    // ── Phone side (browser): navigate to auth URL with relay params ──
    const authUrl = '/?' + new URLSearchParams({
      auth: '1',
      challenge,
      origin: ORIGIN,
      callback: ORIGIN + '/callback',
      name: 'E2E Cross-Device',
      t: String(Math.floor(Date.now() / 1000)),
      relay: RELAY,
      sessionPubkey,
    }).toString();

    await page.goto(authUrl);

    // Unlock (PIN keypad)
    const pinButton = page.getByRole('button', { name: 'Use PIN instead' });
    if (await pinButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await pinButton.click();
    }
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    // Approval screen
    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });

    // Approve — triggers relay publish (no redirect in relay mode)
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    // In-app ack screen appears (phone stays in Signet)
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible({ timeout: 15_000 });

    // ── Consumer side: subscription resolves with verified auth event ──
    const result = await authPromise;
    expect(result.authEvent.kind).toBe(21236);
    expect(result.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.authEvent.sig).toMatch(/^[0-9a-f]{128}$/);
    const challengeTag = result.authEvent.tags.find(t => t[0] === 'challenge');
    const originTag = result.authEvent.tags.find(t => t[0] === 'origin');
    expect(challengeTag?.[1]).toBe(challenge);
    expect(originTag?.[1]).toBe(ORIGIN);
  });

  test('deny publishes rejection via relay; consumer sees denied', async ({ page }) => {
    const sessionPrivKey = generateSecretKey();
    const sessionPubkey = bytesToHex(schnorr.getPublicKey(sessionPrivKey));
    const challenge = bytesToHex(
      sha256(new TextEncoder().encode('e2e-deny-' + Date.now())),
    );

    const authPromise = waitForAuthResponse({
      requestId: challenge,
      relayUrl: RELAY,
      sessionPrivKey,
      expectedOrigin: ORIGIN,
      timeout: 30_000,
    });

    await page.waitForTimeout(500);

    const authUrl = '/?' + new URLSearchParams({
      auth: '1',
      challenge,
      origin: ORIGIN,
      callback: ORIGIN + '/callback',
      name: 'E2E Cross-Device Deny',
      t: String(Math.floor(Date.now() / 1000)),
      relay: RELAY,
      sessionPubkey,
    }).toString();

    await page.goto(authUrl);

    const pinButton = page.getByRole('button', { name: 'Use PIN instead' });
    if (await pinButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await pinButton.click();
    }
    for (const digit of '123456') {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }

    await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Deny' }).click();

    // In-app "Declined" ack appears on the phone side
    await expect(page.getByRole('heading', { name: /declined|rejected/i })).toBeVisible({ timeout: 15_000 });

    // Consumer side: subscription rejects with 'denied'
    await expect(authPromise).rejects.toThrow('denied');
  });
});
