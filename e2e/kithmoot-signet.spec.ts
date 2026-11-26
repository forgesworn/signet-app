import { expect, test } from '@playwright/test';
import { createIdentityAndUnlock, unlockAfterReload, unlockWithPin } from './fixtures';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

test.use({ actionTimeout: 20_000 });

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
    await signet.getByRole('button', { name: /Bunker & Scanning/ }).click();
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
  if (!await desktop.locator('#roomName').isVisible()) {
    if (await desktop.locator('#newRoom').isVisible()) await desktop.locator('#newRoom').click();
    else {
      await desktop.locator('#newMenuButton').click();
      await desktop.locator('#newMenuRoom').click();
    }
  }
  await desktop.locator('#roomName').fill('Actual Signet integration');
  const creatorName = desktop.locator('#newRoomYourName');
  if (await creatorName.isVisible()) await creatorName.fill('KithMoot Signet tester');
  await desktop.locator('#create').click();
  await expect(desktop.locator('#roomArea')).toBeVisible({ timeout: 45_000 });
  await expect(desktop.locator('#chatInput')).toBeEditable();
});

test('KithMoot approvals can be managed by persona', async ({ page: signet, context }) => {
  const kithmoot = process.env.KITHMOOT_BASE_URL;
  test.skip(!kithmoot, 'Run with playwright.kithmoot.config.ts and KITHMOOT_REPO_PATH.');
  const relay = new URL('/__test-relay', kithmoot); relay.protocol = 'wss:';
  await context.routeWebSocket(url => url.href !== relay.href && url.port !== '5474', socket => socket.close());
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }));

  const primary = 'Aster Test';
  const second = 'Bracken Test';
  await createIdentityAndUnlock(signet, { name: primary });
  const signerOrigin = new URL(signet.url()).origin;

  await signet.getByRole('button', { name: 'Settings', exact: true }).click();
  await signet.getByRole('button', { name: /^Personas / }).click();
  await signet.getByRole('button', { name: '+ Add persona', exact: true }).click();
  await signet.getByPlaceholder('Persona name', { exact: true }).fill(second);
  await signet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(signet.getByText(second, { exact: true })).toBeVisible();
  await signet.evaluate(async relayUrl => {
    const { getPreferences, savePreferences } = await import('/src/lib/db.ts');
    await savePreferences({ ...await getPreferences(), relayUrl });
  }, relay.href);

  await signet.goto(signerOrigin);
  const pinGate = signet.getByRole('button', { name: '1', exact: true }).and(signet.locator('.auth-screen button'));
  const settings = signet.getByRole('button', { name: 'Settings', exact: true });
  await unlockAfterReload(signet);
  await settings.click();
  await signet.getByRole('button', { name: /Bunker & Scanning/ }).click();
  await signet.getByRole('button', { name: 'Turn the Bunker on', exact: true }).click();
  await expect(signet.getByLabel('Bunker is on', { exact: true })).toBeVisible();

  const consumer = await context.newPage();
  await consumer.addInitScript(url => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url, read: true, write: true }] }));
  }, relay.href);
  await consumer.goto(kithmoot! + '?signin=nostr');
  const avatar = consumer.locator('#railPersonas');
  const approve = async (name: string) => {
    await consumer.locator('[data-choice="remote-signet"]').click();
    const link = consumer.locator('#signet-login-open-signet');
    await expect(link).toBeVisible();
    const auth = new URL((await link.getAttribute('href'))!);
    await signet.goto(signerOrigin + auth.pathname + auth.search);
    const approveButton = signet.getByRole('button', { name: 'Approve', exact: true });
    await expect(pinGate.or(approveButton).first()).toBeVisible();
    if (await pinGate.isVisible()) await unlockWithPin(signet);
    const select = signet.getByRole('button', { name: new RegExp(name) }).first();
    await expect(select.or(signet.getByText(name, { exact: true })).first()).toBeVisible();
    if (await select.isVisible() && await select.isEnabled()) await select.click();
    await approveButton.click();
    await expect(avatar).toHaveAttribute('aria-label', 'Account menu for ' + name, { timeout: 45_000 });
  };
  await approve(primary);
  await avatar.click();
  await consumer.locator('#addSignetPersona').click();
  await approve(second);

  await signet.goto(signerOrigin);
  await unlockAfterReload(signet);
  await settings.click();
  await signet.getByRole('button', { name: /^Connected apps/ }).click();
  const rows = signet.locator('.connections-row');
  await expect(rows).toHaveCount(2);
  const primaryRow = rows.filter({ hasText: primary });
  const secondRow = rows.filter({ hasText: second });
  await expect(primaryRow).toHaveCount(1);
  await expect(secondRow).toHaveCount(1);
  await secondRow.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await secondRow.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(secondRow).toHaveCount(0);
  await expect(primaryRow.getByText('ALWAYS ALLOWED')).toBeVisible();

  await signet.getByRole('button', { name: 'Bunker', exact: true }).click();
  const bunker = signet.getByRole('dialog', { name: 'Bunker', exact: true });
  await bunker.getByRole('button', { name: '+5 min', exact: true }).click();
  await expect(bunker.getByText('Socket: listening on ' + relay.host + relay.pathname, { exact: false })).toBeVisible();
  await bunker.getByRole('button', { name: 'Close', exact: true }).click();
  await signet.getByRole('button', { name: 'Home', exact: true }).click();

  const selectPersona = async (name: string) => {
    await avatar.click();
    await consumer.locator('#personaChoices').getByRole('button', { name, exact: true }).click();
    await expect(avatar).toHaveAttribute('aria-label', 'Account menu for ' + name, { timeout: 45_000 });
  };
  const showContactCard = async () => {
    await consumer.locator('#railPeople').click();
    await consumer.locator('#peopleAdd').click();
    await consumer.getByRole('menuitem', { name: 'Show my card', exact: true }).click();
  };
  const card = consumer.getByRole('dialog', { name: 'My card', exact: true });
  const cardLink = card.getByRole('textbox', { name: 'My contact card link' });
  await selectPersona(primary);
  await showContactCard();
  await expect(cardLink).toBeVisible();
  await expect(cardLink).toHaveValue(/#/);
  await card.getByRole('button', { name: 'Close', exact: true }).click();

  await selectPersona(second);
  const decryptRequest = signet.getByRole('dialog', { name: /wants to: Decrypt/ });
  await expect(decryptRequest.getByText(second, { exact: true })).toBeVisible();
  await decryptRequest.getByRole('button', { name: 'Deny', exact: true }).click();
  await showContactCard();
  const request = signet.getByRole('dialog', { name: /wants to sign/ });
  await expect(request.getByText(second, { exact: true })).toBeVisible();
  await request.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(card).toContainText(/denied/i);
  await expect(cardLink).toBeHidden();
  await card.getByRole('button', { name: 'Close', exact: true }).click();

  await selectPersona(primary);
  await avatar.click();
  await consumer.locator('#addSignetPersona').click();
  await approve(second);
  await showContactCard();
  await expect(cardLink).toHaveValue(/#/);
});
