/**
 * NOT A TEST — screenshot harness for the sign-flows documentation site.
 *
 * Captures real mobile renders (390x844) of every reachable signing/approval
 * screen and writes them into the sign-flows documentation assets dir.
 *
 * Run explicitly:
 *   SIGNFLOWS_CAPTURE=1 npx playwright test e2e/_capture-signflows.spec.ts
 *
 * Each capture is its own test so one failure never blocks the others.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, lockApp, navigateViaHarness } from './fixtures';
import { generateSecretKey } from 'nostr-tools/pure';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

test.skip(process.env.SIGNFLOWS_CAPTURE !== '1', 'Screenshot capture harness: set SIGNFLOWS_CAPTURE=1 to run it.');

const OUT = process.env.SIGNFLOWS_SCREENSHOT_DIR
  ?? path.resolve(process.cwd(), 'e2e/results/sign-flows/screens');
const RELAY = process.env.E2E_RELAY_URL ?? 'wss://relay.trotters.cc';

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400); // let animations settle
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

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

test('01 onboarding doors + name-choice + pin setup', async ({ page }) => {
  await clearDatabase(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create my Signet' })).toBeVisible({ timeout: 15_000 });
  await shot(page, '01-onboarding-doors');

  // Walk the import path to the name-choice step
  await page.getByRole('button', { name: 'I already have a Signet' }).click();
  await page.getByRole('button', { name: /12 backup words/ }).click();
  await page.getByPlaceholder('word1 word2 word3 ...').fill(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Use my real name' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '02-name-choice');

  await page.getByRole('button', { name: 'Use my real name' }).click();
  await page.getByPlaceholder('Your name or nickname').fill('Alex Rivera');
  await page.getByRole('button', { name: 'Restore MySignet' }).click();
  await page.getByRole('button', { name: 'Set up now' }).click();
  await expect(page.getByRole('button', { name: /6-digit PIN/ })).toBeVisible({ timeout: 10_000 });
  await shot(page, '03-setup-auth-method');
});

test('04 home + venue entry + bunker panel + auth screen', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await shot(page, '04-home');

  // Venue entry QR (NP-only signed kind-21235) — reached via the carousel; use harness
  try {
    await navigateViaHarness(page, 'venue-entry');
    await page.getByTestId('qr-payload').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '05-venue-entry');
  } catch { /* non-fatal */ }

  // Bunker serve panel (app-as-NIP-46-server)
  try {
    await navigateViaHarness(page, 'home');
    await page.getByRole('button', { name: /Bunker/ }).first().click({ timeout: 6_000 });
    await page.waitForTimeout(700);
    await shot(page, '06-bunker-panel');
    await page.keyboard.press('Escape').catch(() => {});
  } catch { /* non-fatal */ }

  // Lock screen (PIN unlock) — use the harness lock(), more reliable than visibilitychange
  try {
    await navigateViaHarness(page, 'home');
    await page.evaluate(() => (window as any).__TEST__.lock());
    await Promise.race([
      page.getByText('Enter your PIN').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {}),
      page.getByText('Unlock Signet').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {}),
      page.getByRole('button', { name: '1', exact: true }).waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {}),
    ]);
    await shot(page, '07-auth-screen');
  } catch { /* non-fatal */ }
});

test('08 sign-in approval (Sign in with Signet)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await page.goto(authUrl());
  await unlockWithPin(page).catch(() => {});
  await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 20_000 });
  // This screen already shows the inline real-name confirm gate (Approve stays
  // disabled until "Yes, use my real-name identity" is tapped).
  await shot(page, '08-approve-auth');
});

test('10 connect approval (NIP-46 nostrconnect)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  await page.evaluate(() => {
    (window as any).__TEST__.setPendingConnectRequest({
      clientPubkey: 'aa'.repeat(32),
      relayUrl: 'wss://relay.example.com',
      appName: 'Damus',
      appUrl: 'https://damus.io',
    });
    (window as any).__TEST__.setPage('approve-connect');
  });
  await expect(page.getByRole('heading', { name: 'Connection Request' })).toBeVisible({ timeout: 10_000 });
  await shot(page, '10-approve-connect');
});

test('11 verification approval (credential presentation)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  const VERIFIER = 'd'.repeat(64);
  await page.evaluate((v) => {
    (window as any).__TEST__.addCredential({
      id: 'cred-age-18',
      documentId: 'doc-001',
      keypairType: 'natural-person',
      event: JSON.stringify({ id: 'cred-age-18', kind: 31000, pubkey: v, tags: [], content: '', sig: 'a'.repeat(128), created_at: 1700000000 }),
      verifierPubkey: v,
      verifiedAt: 1700000000,
      verifierStatus: 'confirmed',
    });
  }, VERIFIER);
  await page.evaluate((ts) => {
    (window as any).__TEST__.setPendingVerifyRequest({
      type: 'signet-verify-request',
      requestId: 'req-doc-001',
      requiredAgeRange: '18+',
      relayUrl: 'wss://relay.trotters.cc',
      timestamp: ts,
    });
    (window as any).__TEST__.setPage('approve-verification');
  }, Math.floor(Date.now() / 1000));
  await page.waitForTimeout(800);
  await shot(page, '11-approve-verification');
});

test('12 add-dependant approval (third-party child creation)', async ({ page }) => {
  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });
  const url = '/?' + new URLSearchParams({
    action: 'add-dependant',
    origin: 'https://kidgames.example',
    name: 'KidGames',
    callback: 'https://kidgames.example/cb',
    child_name: 'Sam',
    t: String(Math.floor(Date.now() / 1000)),
    challenge: 'a'.repeat(64),
  }).toString();
  await page.goto(url);
  await unlockWithPin(page).catch(() => {});
  await page.waitForTimeout(1000);
  await shot(page, '12-approve-add-dependant');
});

test('13 cross-device relay ack (Signed in)', async ({ page }) => {
  // Mock the relay so the gift-wrap publish gets an OK without an external server.
  await page.routeWebSocket('wss://**', ws => {
    ws.onMessage(message => {
      try {
        const data = JSON.parse(String(message));
        if (Array.isArray(data) && data[0] === 'EVENT') {
          ws.send(JSON.stringify(['OK', (data[1] as any).id, true, '']));
        }
        if (Array.isArray(data) && data[0] === 'REQ') {
          ws.send(JSON.stringify(['EOSE', data[1]]));
        }
      } catch { /* ignore */ }
    });
  });

  await clearDatabase(page);
  await createIdentityAndUnlock(page, { name: 'Alex Rivera' });

  const sessionPrivKey = generateSecretKey();
  const sessionPubkey = bytesToHex(schnorr.getPublicKey(sessionPrivKey));
  const challenge = bytesToHex(sha256(new TextEncoder().encode('shot-' + Date.now())));

  await page.goto(authUrl({ challenge, relay: 'wss://relay.example.com', sessionPubkey, post: 'https://couch-arcade.example/play' }));
  await unlockWithPin(page).catch(() => {});
  // PBKDF2 decrypt after reload can take 10–30s before the approval screen mounts.
  await expect(page.getByText(/wants to log you in/)).toBeVisible({ timeout: 60_000 });
  // Tap the inline real-name confirm to enable Approve, then approve.
  await page.getByRole('button', { name: /Yes, use my real-name identity/ }).click({ timeout: 8_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible({ timeout: 30_000 });
  await shot(page, '13-relay-auth-ack');
});
