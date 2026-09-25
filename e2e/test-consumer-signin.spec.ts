import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, confirmRealNameIfPrompted } from './fixtures';

/**
 * End-to-end proof that a real sign-in through MySignet produces a
 * signature a consumer can verify.
 *
 * Unlike `auth.spec.ts` — which asserts the callback URL merely *contains*
 * `signature=` — this drives the actual test-consumer harness, whose callback
 * page rebuilds the kind-21236 event and checks the BIP-340 signature. A pass
 * means the bytes are right, not just present.
 *
 * The harness server is started here (not in playwright.config.ts) so the
 * rest of the suite, and CI's deploy gate, are unaffected by it.
 */

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-consumer');
const HARNESS_PORT = 5185;  // not 5175 — never fight a harness the user has open
const HARNESS_ORIGIN = `http://localhost:${HARNESS_PORT}`;
const LOG_PATH = path.join(HARNESS_DIR, 'results', 'log.jsonl');
/** Whichever dev server is running — https locally when mkcert certs exist. */
const APP_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:5174';
const APP_HOST_RE = new RegExp(new URL(APP_ORIGIN).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

let harness: ChildProcess | undefined;

/** Lines already in the shared log before this run — never delete them: the
 *  same file holds results a human recorded by hand from a phone. */
let logLinesBefore = 0;

test.beforeAll(async () => {
  if (existsSync(LOG_PATH)) {
    logLinesBefore = readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean).length;
  }
  harness = spawn('python3', ['server.py'], {
    cwd: HARNESS_DIR,
    env: {
      ...process.env,
      SIGNET_HARNESS_PORT: String(HARNESS_PORT),
      SIGNET_HARNESS_BIND: '127.0.0.1',
      // Force plain http for the test even when the harness has a LAN
      // certificate for phone testing — localhost is a valid consumer
      // origin either way, and http keeps the spec independent of a cert.
      SIGNET_HARNESS_CERT: path.join(HARNESS_DIR, 'cert', 'absent-on-purpose.pem'),
      SIGNET_HARNESS_KEY: path.join(HARNESS_DIR, 'cert', 'absent-on-purpose-key.pem'),
    },
    stdio: 'ignore',
  });
  // Wait for it to answer.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${HARNESS_ORIGIN}/index.html`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('harness server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
});

test.afterAll(() => {
  harness?.kill();
});

test.describe('test-consumer harness', () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createIdentityAndUnlock(page);
  });

  test('a real sign-in verifies cryptographically at the consumer', async ({ page }) => {
    await page.goto(`${HARNESS_ORIGIN}/`);

    // Point the harness at this dev build rather than the live site.
    await page.locator('#target').fill(APP_ORIGIN);
    await page.locator('#target').dispatchEvent('change');

    // "Basic sign-in" is the baseline scenario.
    await page.locator('.scenario', { hasText: 'Basic sign-in' }).getByRole('button', { name: 'Run' }).click();

    await page.waitForURL(APP_HOST_RE, { timeout: 15_000 });
    await unlockWithPin(page);
    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 20_000 });
    await confirmRealNameIfPrompted(page);
    await page.getByRole('button', { name: 'Approve' }).click();

    // Back at the harness callback, which does the real verification.
    await page.waitForURL(new RegExp(`${HARNESS_PORT}/callback\\.html`), { timeout: 20_000 });
    await expect(page.locator('#hero')).toContainText('Signed ✓', { timeout: 15_000 });
    await expect(page.locator('#checks')).toContainText('the rebuilt kind-21236 event hashes to exactly the id Signet signed');
    await expect(page.locator('#report-status')).toContainText('results/log.jsonl', { timeout: 10_000 });

    // And the outcome is on disk for anyone debugging after the fact.
    const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(logLinesBefore);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.verdict).toBe('signed');
    expect(last.scenarioId).toBe('basic');
  });

  test('a denied sign-in is reported as denied, not as a failure', async ({ page }) => {
    await page.goto(`${HARNESS_ORIGIN}/`);
    await page.locator('#target').fill(APP_ORIGIN);
    await page.locator('#target').dispatchEvent('change');
    await page.locator('.scenario', { hasText: 'Basic sign-in' }).getByRole('button', { name: 'Run' }).click();

    await page.waitForURL(APP_HOST_RE, { timeout: 15_000 });
    await unlockWithPin(page);
    await expect(page.getByText('Login Request')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Deny' }).click();

    await page.waitForURL(new RegExp(`${HARNESS_PORT}/callback\\.html`), { timeout: 20_000 });
    await expect(page.locator('#hero')).toContainText('Sign-in denied');
  });
});
