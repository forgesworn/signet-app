import { beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { appInviteTag, ContactIdentityDecryptBudget, parseAppInviteReply, type AppInviteRequest } from '@forgesworn/signet-contacts';
import { purgeAllUserData, saveContactGrantV2, updateContactGrantV2 } from './db';
import { ContactInviteService } from './contact-invite-service';
import { handleContactAppInvite } from './contact-app-invites';
import type { AppGrantV2 } from '../types';
const publish = vi.hoisted(() => vi.fn(async (_event: import('signet-protocol').NostrEvent, _relays: string[]) => true));
vi.mock('./sync-relays', () => ({ publishToRelays: publish }));
const key = 'app introduction test', now = 1700000000;
const appSk = hexToBytes('03'.repeat(32)), railSk = hexToBytes('04'.repeat(32));
const owner = getPublicKey(hexToBytes('01'.repeat(32)));
const grant: AppGrantV2 = { grantId: 'a'.repeat(32), directoryId: 'owner', ownerIdentityPubkey: owner,
  appPubkey: getPublicKey(appSk), appName: 'Example game', createdAt: now, updatedAt: now,
  railPubkey: getPublicKey(railSk), railPrivateKey: '04'.repeat(32), relay: 'wss://app.example',
  capabilities: ['signet.contacts.invites:create'], maxStalenessSeconds: 3600, appLabels: {}, seenOperationIds: [] };
beforeEach(async () => { await purgeAllUserData(); publish.mockReset().mockResolvedValue(true); });
it('issues one private named invite on replay and returns no contact or completion state', async () => {
  await saveContactGrantV2(grant, key);
  const signer = vi.fn();
  const service = new ContactInviteService({ directoryId: 'owner', encryptionKey: key, signer,
    budget: new ContactIdentityDecryptBudget(), isCurrent: () => true, onChanged() {}, mayConnect: () => true });
  const request: AppInviteRequest = { v: 1, grantId: grant.grantId, requestId: 'b'.repeat(32), createdAt: now, action: 'create-invite', mode: 'single-use' };
  const event = finalizeEvent({ kind: 30078, created_at: now, tags: [['d', appInviteTag(grant.grantId)]],
    content: nip44.v2.encrypt(JSON.stringify(request), nip44.v2.utils.getConversationKey(appSk, grant.railPubkey)) }, appSk);
  const args = { grantId: grant.grantId, event, encryptionKey: key, service, identities: [owner], relays: ['wss://contact.example'], now, isCurrent: () => true };
  expect(await handleContactAppInvite(args)).toBe(true);
  expect(await handleContactAppInvite(args)).toBe(true);
  const state = await service.read();
  expect(state.invites).toHaveLength(1);
  expect(state.invites[0]).toMatchObject({ name: 'via Example game', app: { grantId: grant.grantId, autoAcceptUntil: now + 300 } });
  expect(signer).not.toHaveBeenCalled();
  const response = publish.mock.calls.at(-1)![0] as unknown as typeof event;
  const plaintext = nip44.v2.decrypt(response.content, nip44.v2.utils.getConversationKey(appSk, grant.railPubkey));
  expect(parseAppInviteReply(plaintext, request, now)?.status).toBe('issued');
  expect(plaintext).not.toContain('Example game');
  expect(plaintext).not.toContain('contacts');
  await updateContactGrantV2(grant.grantId, key, old => ({ ...old, revokedAt: now + 1 }));
  expect(await handleContactAppInvite({ ...args, now: now + 1 })).toBe(false);
  expect(publish).toHaveBeenCalledTimes(2);
}, 30000);
it('refuses malformed signatures and missing capability before identity-key work', async () => {
  await saveContactGrantV2({ ...grant, capabilities: [] }, key);
  const signer = vi.fn();
  const service = new ContactInviteService({ directoryId: 'owner', encryptionKey: key, signer,
    budget: new ContactIdentityDecryptBudget(), isCurrent: () => true, onChanged() {}, mayConnect: () => true });
  const request = { v: 1, grantId: grant.grantId, requestId: 'b'.repeat(32), createdAt: now, action: 'create-invite', mode: 'single-use' };
  const event = finalizeEvent({ kind: 30078, created_at: now, tags: [['d', appInviteTag(grant.grantId)]],
    content: nip44.v2.encrypt(JSON.stringify(request), nip44.v2.utils.getConversationKey(appSk, grant.railPubkey)) }, appSk);
  const args = { grantId: grant.grantId, event, encryptionKey: key, service, identities: [owner], relays: ['wss://contact.example'], now, isCurrent: () => true };
  expect(await handleContactAppInvite(args)).toBe(false);
  expect(await handleContactAppInvite({ ...args, event: { ...event, sig: '0'.repeat(128) } })).toBe(false);
  expect((await service.read()).invites).toEqual([]);
  expect(signer).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
}, 30000);
