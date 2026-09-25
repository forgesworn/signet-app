import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, confirmRealNameIfPrompted } from './fixtures';

/**
 * The cross-device (relay) sign-in path, end to end.
 *
 * Signet does not redirect in this mode — it gift-wraps its answer to the
 * consumer's session key and publishes it to the relay the consumer named.
 * The harness page stays open, subscribed, and unwraps what arrives.
 *
 * This talks to a REAL relay, so it is opt-in: set E2E_RELAY to run it.
 *
 *   E2E_RELAY=wss://relay.trotters.cc E2E_BASE_URL=https://localhost:5174 \
 *     npx playwright test e2e/test-consumer-relay.spec.ts --project=mobile-chromium
 */

const RELAY = process.env.E2E_RELAY;
const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-consumer');
const HARNESS_PORT = 5186;
const HARNESS_ORIGIN = `http://localhost:${HARNESS_PORT}`;
const LOG_PATH = path.join(HARNESS_DIR, 'results', 'log.jsonl');
const APP_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:5174';

let harness: ChildProcess | undefined;

test.skip(!RELAY, 'set E2E_RELAY to run the relay-mode test against a live relay');

test.beforeAll(async () => {
  harness = spawn('python3', ['server.py'], {
    cwd: HARNESS_DIR,
    env: {
      ...process.env,
      SIGNET_HARNESS_PORT: String(HARNESS_PORT),
      SIGNET_HARNESS_BIND: '127.0.0.1',
      SIGNET_HARNESS_CERT: path.join(HARNESS_DIR, 'cert', 'absent-on-purpose.pem'),
      SIGNET_HARNESS_KEY: path.join(HARNESS_DIR, 'cert', 'absent-on-purpose-key.pem'),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${HARNESS_ORIGIN}/relay.html`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('harness server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
});

test.afterAll(() => { harness?.kill(); });

test('cross-device sign-in completes over the relay', async ({ page, context }) => {
  test.setTimeout(180_000);

  await clearDatabase(page);
  await createIdentityAndUnlock(page);

  // The consumer: a page that stays open, listening.
  const consumer = await context.newPage();
  await consumer.goto(`${HARNESS_ORIGIN}/relay.html`);
  await consumer.locator('#target').fill(APP_ORIGIN);
  await consumer.locator('#target').dispatchEvent('change');
  await consumer.locator('#relay').fill(RELAY!);
  await consumer.locator('#relay').dispatchEvent('change');
  await consumer.getByRole('button', { name: 'Start a cross-device sign-in' }).click();

  await expect(consumer.locator('#progress')).toContainText('listening', { timeout: 30_000 });

  // The signer: the sign-in URL the consumer just built, opened separately —
  // exactly what scanning the QR on another device does.
  const signInUrl = (await consumer.locator('#link-box code').innerText()).trim();
  await page.goto(signInUrl);
  await unlockWithPin(page);
  await expect(page.getByText('Login Request')).toBeVisible({ timeout: 30_000 });
  await confirmRealNameIfPrompted(page);
  await page.getByRole('button', { name: 'Approve' }).click();

  // Back on the consumer, the answer must arrive over the relay and verify.
  await expect(consumer.locator('#hero')).toContainText('Signed ✓', { timeout: 60_000 });
  await expect(consumer.locator('#checks')).toContainText('the signed event carries exactly the challenge we sent');

  expect(existsSync(LOG_PATH)).toBe(true);
  const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  expect(last.mode).toBe('relay');
  expect(last.verdict).toBe('signed');
});

test('an attempt survives the consumer tab being reloaded mid-flight', async ({ page, context }) => {
  test.setTimeout(180_000);

  await clearDatabase(page);
  await createIdentityAndUnlock(page);

  const consumer = await context.newPage();
  await consumer.goto(`${HARNESS_ORIGIN}/relay.html`);
  await consumer.locator('#target').fill(APP_ORIGIN);
  await consumer.locator('#target').dispatchEvent('change');
  await consumer.locator('#relay').fill(RELAY!);
  await consumer.locator('#relay').dispatchEvent('change');
  await consumer.getByRole('button', { name: 'Start a cross-device sign-in' }).click();
  await expect(consumer.locator('#progress')).toContainText('listening', { timeout: 30_000 });

  const signInUrl = (await consumer.locator('#link-box code').innerText()).trim();

  // What a phone does to a background tab: throw it away. The session key is
  // the only thing that can decrypt the answer, so a restart would lose it.
  await consumer.reload();
  await expect(consumer.locator('#hero')).toContainText('Resumed', { timeout: 20_000 });

  await page.goto(signInUrl);
  await unlockWithPin(page);
  await expect(page.getByText('Login Request')).toBeVisible({ timeout: 30_000 });
  await confirmRealNameIfPrompted(page);
  await page.getByRole('button', { name: 'Approve' }).click();

  await expect(consumer.locator('#hero')).toContainText('Signed ✓', { timeout: 60_000 });
});
