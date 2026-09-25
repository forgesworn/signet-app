import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createIdentityAndUnlock, clearDatabase, unlockWithPin, confirmRealNameIfPrompted } from './fixtures';

/**
 * Does the app answer a request shaped exactly like the Android consumers'?
 *
 * Fathom is a Capacitor app, so its `window.location.origin` is
 * `https://localhost` — not a public https origin like the browser harness
 * uses. This drives the app with that shape and listens on the relay from
 * the test process, so a missing publish is visible as a missing event
 * rather than as a consumer that failed to notice one.
 *
 * Opt-in (live relay): set E2E_RELAY.
 */

const RELAY = process.env.E2E_RELAY;
test.skip(!RELAY, 'set E2E_RELAY to run against a live relay');

/** Collect kind-1059 wraps addressed to `recipient` until `deadlineMs`. */
function collectWraps(relayUrl: string, recipient: string, windowMs: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    const socket = new WebSocket(relayUrl);
    const finish = () => { try { socket.close(); } catch { /* gone */ } resolve(events); };
    const timer = setTimeout(finish, windowMs);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', 'fathom-shape', {
      kinds: [1059], '#p': [recipient], since: Math.floor(Date.now() / 1000) - 120,
    }]));
    socket.onmessage = (ev) => {
      let msg: unknown[];
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg[0] === 'EVENT') { events.push(msg[2]); clearTimeout(timer); finish(); }
    };
    socket.onerror = () => { clearTimeout(timer); finish(); };
  });
}

test('the app publishes for a Capacitor-origin consumer', async ({ page }) => {
  test.setTimeout(180_000);

  await clearDatabase(page);
  await createIdentityAndUnlock(page);

  const sessionSk = generateSecretKey();
  const sessionPubkey = getPublicKey(sessionSk);
  const challenge = bytesToHex(generateSecretKey());   // 32 random bytes, hex

  const params = new URLSearchParams({
    auth: '1',
    challenge,
    origin: 'https://localhost',
    callback: 'https://localhost/',
    name: 'Fathom',
    t: String(Math.floor(Date.now() / 1000)),
    relay: RELAY!,
    sessionPubkey,
  });

  const listening = collectWraps(RELAY!, sessionPubkey, 90_000);

  await page.goto('/?' + params.toString());
  await unlockWithPin(page);
  await expect(page.getByText('Login Request')).toBeVisible({ timeout: 30_000 });
  await confirmRealNameIfPrompted(page);
  await page.getByRole('button', { name: 'Approve' }).click();

  const wraps = await listening;
  expect(wraps.length, 'the app published a gift-wrapped response to the relay').toBeGreaterThan(0);
});
