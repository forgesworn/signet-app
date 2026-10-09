import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { ContactIdentityDecryptBudget } from '@forgesworn/signet-contacts';
import { openContactMailboxWrap } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { ContactInviteService } from './contact-invite-service';
import { recordContactArrival, mergeContactInviteVault } from './contact-invite-store';
import { contactExchangeKey } from './contact-exchange-key';
import { bindingTemplate, createHandshakeSession, openReveal, sealReveal, verifyRevealBinding, type HandshakeSession, type RevealBody } from './handshake-reveal';
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
it('real signed exchange needs reveals bound to both camera reads and author binding, then saves identical mutual sigils without words', async () => {
  const p = party('01'.repeat(32), 'owner'), q = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const [a, b] = p.pubkey < q.pubkey ? [p, q] : [q, p];
  const ai = await a.service.create(a.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
  const bi = await b.service.create(b.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
  const sa = createHandshakeSession(), sb = createHandshakeSession();
  // Each camera read the other's session; each persona signs for both sessions.
  const sign = async (who: Party, own: HandshakeSession, peer: string, invite: typeof ai): Promise<RevealBody> =>
    ({ v: 2, to: peer, invite: invite.invite, binding: await who.service.signRevealBinding(who.pubkey, bindingTemplate(own, peer, invite.invite, now)) });
  const fromA = openReveal(sealReveal(await sign(a, sa, sb.publicKey, ai), sb.publicKey, now), sb, now + 1)!;
  const fromB = openReveal(sealReveal(await sign(b, sb, sa.publicKey, bi), sa.publicKey, now), sa, now + 1)!;
  expect(verifyRevealBinding(fromA, sa.publicKey, sb) && verifyRevealBinding(fromB, sb.publicKey, sa)).toBe(true);
  const id = await a.service.request(a.pubkey, fromB.invite, now + 1, undefined, undefined, true);
  const pending = await a.service.read();
  const arrival = await deliver(a, b, 0, bi.id, bi.invite.secret, 'invite');
  await b.service.openInbox(now + 3);
  await expect(b.service.acceptHandshake(arrival, { ...bi.invite, secret: 'f'.repeat(64) }, { invite: fromA.invite }, now + 4)).rejects.toThrow('proof');
  await expect(b.service.acceptHandshake(arrival, bi.invite, { invite: { ...fromA.invite, recipient: 'c'.repeat(64) } }, now + 4)).rejects.toThrow('proof');
  await b.service.acceptHandshake(arrival, bi.invite, { invite: fromA.invite }, now + 4);
  expect((await b.service.read()).exchanges).toHaveLength(1);
  // No second, optical acceptance exists any more: the reveal is the return-scan proof.
  expect((await b.service.read()).outbox.filter(o => o.messageType === 'acceptance')).toHaveLength(1);
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
  const evidenceA = { inviteId: ai.id, ownSession: sa, cameraPeerSession: sb.publicKey, peerExpiresAt: now + 120, peerReveal: fromB, readAt: now + 2 };
  // A wrong camera read, or a reveal not covering this session, is not mutual.
  await expect(a.service.confirmHandshake(exchangeId, now + 9, { ...evidenceA, cameraPeerSession: createHandshakeSession().publicKey })).rejects.toThrow('proof');
  await expect(a.service.confirmHandshake(exchangeId, now + 9, { ...evidenceA, ownSession: createHandshakeSession() })).rejects.toThrow('proof');
  await expect(a.service.confirmHandshake(exchangeId, now + 9, { ...evidenceA, inviteId: bi.id })).rejects.toThrow('proof');
  // A's phone got B's session by an NFC tap: the same proof, recorded one rung lower.
  await a.service.confirmHandshake(exchangeId, now + 9, { ...evidenceA, via: 'tap' });
  await b.service.confirmHandshake(exchangeId, now + 9, { inviteId: bi.id, ownSession: sb, cameraPeerSession: sa.publicKey, peerExpiresAt: now + 120, peerReveal: fromA, readAt: now + 2 });
  const ae = (await a.service.read()).exchanges[0], be = (await b.service.read()).exchanges[0];
  expect(ae.handshake?.strength).toBe('tapped'); expect(be.handshake?.strength).toBe('mutual');
  const complete = await a.service.read();
  const { handshake: _mark, ...legacyComplete } = ae;
  const legacy = { ...complete, exchanges: [legacyComplete] };
  expect(mergeContactInviteVault(pending, legacy).exchanges[0].handshake?.startedAt).toBe(now + 1);
  expect(mergeContactInviteVault(legacy, pending).exchanges[0].handshake?.startedAt).toBe(now + 1);
  expect(mergeContactInviteVault(legacy, complete).exchanges[0].handshake?.strength).toBe('tapped');
  expect(mergeContactInviteVault(complete, legacy).exchanges[0].handshake?.strength).toBe('tapped');
  // Merging two confirmations keeps the stronger: mutual over tapped.
  const mutualCopy = { ...complete, exchanges: [{ ...ae, handshake: { ...ae.handshake!, strength: 'mutual' as const } }] };
  expect(mergeContactInviteVault(complete, mutualCopy).exchanges[0].handshake?.strength).toBe('mutual');
  expect(mergeContactInviteVault(mutualCopy, complete).exchanges[0].handshake?.strength).toBe('mutual');
  expect(ae.wordsConfirmedAt).toBeUndefined(); expect(handshakeSigil(ae)).toBe(handshakeSigil(be));
  expect(a.completed).toHaveBeenCalledTimes(1); expect(b.completed).toHaveBeenCalledTimes(1);
}, 30000);
