import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { ContactIdentityDecryptBudget } from '@forgesworn/signet-contacts';
import { openContactMailboxWrap } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { ContactInviteService } from './contact-invite-service';
import { recordContactArrival, mergeContactInviteVault } from './contact-invite-store';
import { contactExchangeKey } from './contact-exchange-key';
import { inviteFingerprint } from './handshake-proof';
import { handshakeSigil } from './handshake-sigil';
import { purgeAllUserData } from './db';
const publish = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./sync-relays', () => ({ publishToRelays: publish }));
const KEY = 'handshake crypto test', now = 1700000000;
function party(secret: string, directoryId: string) {
  const sk = hexToBytes(secret), pubkey = getPublicKey(sk);
  const completed = vi.fn(async () => 'a'.repeat(32));
  const service = new ContactInviteService({ directoryId, encryptionKey: KEY, budget: new ContactIdentityDecryptBudget(),
    signer: async key => {
      if (key !== pubkey) throw new Error('Wrong identity');
      return { publicKey: pubkey, signEvent: async event => finalizeEvent(event, sk),
        decrypt: async (sender, ct) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(sk, sender)) };
    }, isCurrent: () => true, onChanged: () => {}, mayConnect: () => true, onCompleted: completed });
  return { service, pubkey, directoryId, completed };
}
type Party = ReturnType<typeof party>;
async function deliver(sender: Party, recipient: Party, index: number, bindingId: string, secret: string, channel: 'invite' | 'exchange') {
  const row = (await sender.service.read()).outbox[index];
  const packet = openContactMailboxWrap(row.event, secret);
  expect(packet).not.toBeNull();
  await recordContactArrival(recipient.directoryId, KEY, { id: row.id, inviteId: bindingId, identityPubkey: recipient.pubkey,
    packet: packet!, receivedAt: now + 3, channel });
  return row.id;
}
beforeEach(async () => { await purgeAllUserData(); publish.mockClear(); });
it('real signed exchange requires optical mailbox delivery and author binding, then saves identical mutual sigils without words', async () => {
  const p = party('01'.repeat(32), 'owner'), q = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const [a, b] = p.pubkey < q.pubkey ? [p, q] : [q, p];
  const ai = await a.service.create(a.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
  const bi = await b.service.create(b.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
  const id = await a.service.request(a.pubkey, bi.invite, now + 1, undefined, undefined, true);
  const pending = await a.service.read();
  const arrival = await deliver(a, b, 0, bi.id, bi.invite.secret, 'invite');
  await b.service.openInbox(now + 3);
  await expect(b.service.acceptHandshake(arrival, { ...bi.invite, secret: 'f'.repeat(64) }, { invite: ai.invite }, now + 4)).rejects.toThrow('proof');
  await expect(b.service.acceptHandshake(arrival, bi.invite, { invite: { ...ai.invite, recipient: 'c'.repeat(64) }, echo: inviteFingerprint(bi.invite) }, now + 4)).rejects.toThrow('proof');
  await b.service.acceptHandshake(arrival, bi.invite, { invite: ai.invite, echo: inviteFingerprint(bi.invite) }, now + 4);
  expect((await b.service.read()).exchanges).toHaveLength(1);
  const request = (await a.service.read()).exchanges[0].request;
  const exchangeId = contactExchangeKey(request);
  expect(id).toBe(exchangeId);
  await b.service.flush(now + 5);
  await deliver(b, a, 0, exchangeId, request.reply.secret, 'exchange');
  await a.service.openInbox(now + 6, true); await a.service.flush(now + 7);
  await deliver(a, b, 1, exchangeId, request.reply.secret, 'exchange');
  await b.service.openInbox(now + 8, true); await b.service.flush(now + 8);
  expect(a.completed).not.toHaveBeenCalled(); expect(b.completed).not.toHaveBeenCalled();
  await expect(a.service.materialiseContact(exchangeId)).rejects.toThrow('not ready');
  await expect(a.service.confirmHandshake(exchangeId, now + 9, { own: ai.invite, scanned: { invite: bi.invite }, readAt: now + 2 })).rejects.toThrow('proof');
  await deliver(b, a, 1, ai.id, ai.invite.secret, 'invite');
  await a.service.openInbox(now + 9, false, a.pubkey);
  await a.service.confirmHandshake(exchangeId, now + 9, { own: ai.invite, scanned: { invite: bi.invite, echo: inviteFingerprint(ai.invite) }, readAt: now + 2 });
  await b.service.confirmHandshake(exchangeId, now + 9, { own: bi.invite, scanned: { invite: ai.invite, echo: inviteFingerprint(bi.invite) }, readAt: now + 2 });
  const ae = (await a.service.read()).exchanges[0], be = (await b.service.read()).exchanges[0];
  expect(ae.handshake?.strength).toBe('mutual'); expect(be.handshake?.strength).toBe('mutual');
  const complete = await a.service.read();
  const { handshake: _mark, ...legacyComplete } = ae;
  const legacy = { ...complete, exchanges: [legacyComplete] };
  expect(mergeContactInviteVault(pending, legacy).exchanges[0].handshake?.startedAt).toBe(now + 1);
  expect(mergeContactInviteVault(legacy, pending).exchanges[0].handshake?.startedAt).toBe(now + 1);
  expect(mergeContactInviteVault(legacy, complete).exchanges[0].handshake?.strength).toBe('mutual');
  expect(mergeContactInviteVault(complete, legacy).exchanges[0].handshake?.strength).toBe('mutual');
  expect(ae.wordsConfirmedAt).toBeUndefined(); expect(handshakeSigil(ae)).toBe(handshakeSigil(be));
  expect(a.completed).toHaveBeenCalledTimes(1); expect(b.completed).toHaveBeenCalledTimes(1);
}, 30000);
