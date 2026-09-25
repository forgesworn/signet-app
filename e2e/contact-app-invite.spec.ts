import { test, expect, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { createSignetIdentity, destroyIdentity } from 'signet-protocol';
import { createMnemonicRecoveryWords } from 'nsec-tree';
import { appInviteTag, parseAppInviteReply, type AppInviteRequest } from '@forgesworn/signet-contacts';
import { restoreIdentityAndUnlock, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';

test.use({ actionTimeout: 15000 });
test('paired apps introduce two people without directory access, then the owner can undo silently', async ({ page, context, browser }) => {
  test.setTimeout(180000);
  const network = privateRelays(); await network.install(context);
  const mnemonicA = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mnemonicB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const identityA = createSignetIdentity(mnemonicA), identityB = createSignetIdentity(mnemonicB);
  const ownA = bytesToHex(identityA.persona.identity.publicKey), ownB = bytesToHex(identityB.persona.identity.publicKey);
  destroyIdentity(identityA); destroyIdentity(identityB);
  await restoreIdentityAndUnlock(page);
  await page.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://contacts.test'));
  const second = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await network.install(second);
    const b = await second.newPage();
    await restoreIdentityAndUnlock(b, { name: 'Second person', words: createMnemonicRecoveryWords(mnemonicB) });
    await b.evaluate(() => (window as any).__TEST__.setRelayUrl('wss://contacts.test'));
    const appSk = hexToBytes('03'.repeat(32)), railASk = hexToBytes('04'.repeat(32)), railBSk = hexToBytes('05'.repeat(32));
    const app = getPublicKey(appSk), grantA = 'a'.repeat(32), grantB = 'b'.repeat(32);
    async function seed(target: Page, id: string, own: string, rail: Uint8Array, capability: string) {
      await target.evaluate(async input => (window as any).__TEST__.seedContactsGrantV2(input), {
        grantId: id, appName: 'Example game', ownerIdentityPubkey: own, appPubkey: app,
        railPubkey: getPublicKey(rail), railPrivateKey: bytesToHex(rail), relay: 'wss://app.test', capabilities: [capability],
      });
    }
    await seed(page, grantA, ownA, railASk, 'signet.contacts.invites:create');
    await seed(b, grantB, ownB, railBSk, 'signet.contacts.invites:receive');
    async function request(value: AppInviteRequest, rail: Uint8Array) {
      const railPubkey = getPublicKey(rail);
      const event = finalizeEvent({ kind: 30078, created_at: value.createdAt, tags: [['d', appInviteTag(value.grantId)]],
        content: nip44.v2.encrypt(JSON.stringify(value), nip44.v2.utils.getConversationKey(appSk, railPubkey)) }, appSk);
      network.events.set(event.id, event);
      const responseTag = appInviteTag(value.grantId, value.requestId);
      const response = () => [...network.events.values()].find(e => e.pubkey === railPubkey && e.tags.some(t => t[0] === 'd' && t[1] === responseTag));
      await expect.poll(response, { timeout: 30000 }).toBeTruthy();
      const json = nip44.v2.decrypt(response()!.content, nip44.v2.utils.getConversationKey(appSk, railPubkey));
      return parseAppInviteReply(json, value, Math.floor(Date.now() / 1000))!;
    }
    const first = await request({ v: 1, grantId: grantA, requestId: 'c'.repeat(32), createdAt: Math.floor(Date.now() / 1000), action: 'create-invite', mode: 'single-use' }, railASk);
    expect(first.status).toBe('issued');
    expect(first.invite?.recipient).toBe(ownA);
    const reply = await request({ v: 1, grantId: grantB, requestId: 'd'.repeat(32), createdAt: Math.floor(Date.now() / 1000), action: 'receive-invite', invite: first.invite }, railBSk);
    expect(reply.status).toBe('queued'); expect(reply.invite).toBeUndefined();
    await navigateViaHarness(page, 'contact-invites');
    await navigateViaHarness(b, 'contact-invites');
    await expect(page.getByText(/Connected — words not checked/)).toBeVisible({ timeout: 60000 });
    await expect(b.getByText(/Connected — words not checked/)).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Open contact', exact: true }).click();
    await expect(page.getByText(/Added via Example game, not checked/)).toBeVisible();
    await page.getByRole('button', { name: 'Undo app connection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No contacts yet', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open / })).toHaveCount(0);
    await navigateViaHarness(page, 'companion-apps');
    await expect(page.getByRole('checkbox', { name: /Automatically accept/ })).toBeChecked();
    await page.getByRole('checkbox', { name: /Automatically accept/ }).click();
    await expect(page.getByRole('checkbox', { name: /Automatically accept/ })).not.toBeChecked();
  } finally { await second.close().catch(() => {}); }
});
