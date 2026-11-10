import { expect, test } from '@playwright/test';
import { createIdentityAndUnlock, unlockWithPin } from './fixtures';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

for (const scenario of ['signing off', 'new connection', 'previous persona'] as const) test(`KithMoot desktop with My Signet: ${scenario}`, async ({ page: signet, context, baseURL }) => {
  const signing = scenario !== 'signing off';
  const kithmoot = process.env.KITHMOOT_BASE_URL;
  test.skip(!kithmoot, 'Run with playwright.kithmoot.config.ts and KITHMOOT_REPO_PATH.');
  const relay = new URL('/__test-relay', kithmoot); relay.protocol = 'wss:';
  // No test keys or protocol events go to public relays. This keeps the
  // actual approval, encrypted response and NIP-46 handshake local.
  await context.routeWebSocket(url => url.href !== relay.href && url.port !== '5474', socket => socket.close());
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }));
  await createIdentityAndUnlock(signet, { name: 'KithMoot Signet tester' });
  if (signing) {
    await signet.getByRole('button', { name: 'Settings', exact: true }).click();
    await signet.getByRole('button', { name: /Security/ }).first().click();
    await signet.getByRole('button', { name: 'Turn the Bunker on', exact: true }).click();
    await expect(signet.getByLabel('Bunker is on', { exact: true })).toBeVisible();
  }
  const clientKey = generateSecretKey();
  const clientSecret = bytesToHex(clientKey);
  const clientPubkey = getPublicKey(clientKey);
  const previousPersona = getPublicKey(generateSecretKey());
  if (scenario === 'previous persona') {
    await signet.evaluate(async ({ clientPubkey, previousPersona }) => {
      const { saveConnectedClient } = await import('/src/lib/db.ts');
      await saveConnectedClient({ clientPubkey, appName: 'KithMoot', connectedAt: 1, lastSeenAt: 1,
        allowAlways: true, boundPubkey: previousPersona });
    }, { clientPubkey, previousPersona });
  }

  const desktop = await context.newPage();
  await desktop.addInitScript(({ relay, clientSecret }) => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }));
    localStorage.setItem('signet:login.clientSk', clientSecret);
  }, { relay: relay.href, clientSecret });
  await desktop.goto(kithmoot! + '?signin=nostr');
  await desktop.locator('[data-choice="remote-signet"]').click();
  const handoff = desktop.locator('#signet-login-open-signet');
  await expect(handoff).toBeVisible();
  const request = new URL(await handoff.getAttribute('href') ?? '');
  await signet.goto(baseURL! + request.pathname + request.search);
  await unlockWithPin(signet);
  await signet.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(desktop.locator('#signet-login-dialog')).toHaveCount(0, { timeout: 45_000 });
  if (!signing) {
    await expect(desktop.locator('#status')).toContainText('Your identity was approved, but a signing connection was not established.');
    expect(await desktop.evaluate(() => localStorage.getItem('signet:login.pubkey'))).toBeNull();
    return;
  }
  await expect.poll(() => desktop.evaluate(() => localStorage.getItem('signet:login.method'))).toBe('bunker');
  const account = await desktop.evaluate(() => localStorage.getItem('signet:login.pubkey'));
  expect(account).toMatch(/^[a-f0-9]{64}$/);
  if (scenario === 'previous persona') {
    expect(account).not.toBe(previousPersona);
    const boundPubkey = await signet.evaluate(async clientPubkey => {
      const { getConnectedClient } = await import('/src/lib/db.ts');
      return (await getConnectedClient(clientPubkey))?.boundPubkey;
    }, clientPubkey);
    expect(boundPubkey).toBe(account);
  }
  if (!await desktop.locator('#roomName').isVisible()) await desktop.locator('#newRoom').click();
  await desktop.locator('#roomName').fill('Actual Signet integration');
  const creatorName = desktop.locator('#newRoomYourName');
  if (await creatorName.isVisible()) await creatorName.fill('KithMoot Signet tester');
  await desktop.locator('#create').click();
  await expect(desktop.locator('#roomArea')).toBeVisible({ timeout: 45_000 });
  await expect(desktop.locator('#chatInput')).toBeEditable();
});
