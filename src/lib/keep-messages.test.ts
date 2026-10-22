import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { LocalSigningBackend } from './signing-backend';
import {
  claimRumor, inviteRumor, parseAckRumor, revokeRumor, unwrapKeepAck, wrapForKeep,
} from './keep-messages';

// The contract's throwaway keys: Keep sk = 63 zeros then 1, owner sk = 63 zeros then 2.
export const KEEP_SK_HEX = '0'.repeat(63) + '1';
export const OWNER_SK_HEX = '0'.repeat(63) + '2';
const keepSk = hexToBytes(KEEP_SK_HEX);
const ownerSk = hexToBytes(OWNER_SK_HEX);
const K = getPublicKey(keepSk);
const O = getPublicKey(ownerSk);
const owner = new LocalSigningBackend(OWNER_SK_HEX);
const NOW = 1_800_000_000;
const GRANT = '11'.repeat(16);
const SECRET = '22'.repeat(32);
const CODE = '33'.repeat(16);

/** What a Keep does to a wrap: open it with the Keep's key, with nostr-tools' own NIP-59 code. */
function openAsKeep(wrap: NostrEvent) {
  expect(wrap.kind).toBe(1059);
  expect(wrap.tags).toEqual([['p', K]]);
  expect(verifyEvent(wrap as never)).toBe(true);
  return unwrapEvent(wrap as never, keepSk);
}

function ackWrap(tags: string[][], o: { signer?: Uint8Array; to?: string; keepTag?: string } = {}) {
  const signer = o.signer ?? keepSk;
  return wrapEvent(
    { kind: 27663, content: '', created_at: NOW, tags: [['keep', o.keepTag ?? K], ...tags] },
    signer, o.to ?? O,
  );
}
const keeps = new Set([K]);

describe('sending (what the Keep receives)', () => {
  it('a claim wrap opens to the contract fields', async () => {
    const wrap = await wrapForKeep(claimRumor(owner, K, CODE, NOW), K, owner);
    const rumor = openAsKeep(wrap);
    expect(rumor.kind).toBe(27660);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.created_at).toBe(NOW);
    expect(rumor.content).toBe('');
    expect(rumor.tags).toEqual([['keep', K], ['code', CODE]]);
    expect(wrap.pubkey).not.toBe(O);
  });

  it('a personal invite carries grant, secret, expiration, p and name', async () => {
    const friend = 'ee'.repeat(32);
    const rumor = openAsKeep(await wrapForKeep(inviteRumor(owner, {
      keep: K, grant: GRANT, secret: SECRET, expiration: NOW + 86400, persona: friend, label: 'Dave',
    }, NOW), K, owner));
    expect(rumor.kind).toBe(27661);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.tags).toEqual([
      ['keep', K], ['grant', GRANT], ['secret', SECRET], ['expiration', String(NOW + 86400)], ['p', friend], ['name', 'Dave'],
    ]);
  });

  it('a guest pass carries ["guest"] and no p', async () => {
    const rumor = openAsKeep(await wrapForKeep(inviteRumor(owner, {
      keep: K, grant: GRANT, secret: SECRET, expiration: NOW + 3600, guest: true,
    }, NOW), K, owner));
    expect(rumor.tags).toEqual([['keep', K], ['grant', GRANT], ['secret', SECRET], ['expiration', String(NOW + 3600)], ['guest']]);
  });

  it('cuts the label to 40 characters', () => {
    const r = inviteRumor(owner, { keep: K, grant: GRANT, secret: SECRET, expiration: NOW + 1, guest: true, label: 'x'.repeat(80) }, NOW);
    expect(r.tags.find(t => t[0] === 'name')![1]).toHaveLength(40);
  });

  it('refuses an invite that is both or neither personal and guest', () => {
    const base = { keep: K, grant: GRANT, secret: SECRET, expiration: NOW + 1 };
    expect(() => inviteRumor(owner, base, NOW)).toThrow();
    expect(() => inviteRumor(owner, { ...base, guest: true, persona: 'ee'.repeat(32) }, NOW)).toThrow();
  });

  it('a revoke wrap carries keep and grant', async () => {
    const rumor = openAsKeep(await wrapForKeep(revokeRumor(owner, K, GRANT, NOW), K, owner));
    expect(rumor.kind).toBe(27662);
    expect(rumor.tags).toEqual([['keep', K], ['grant', GRANT]]);
  });

  it('the seal is signed by the owner and sealed to the Keep (a stranger cannot open it)', async () => {
    const wrap = await wrapForKeep(claimRumor(owner, K, CODE, NOW), K, owner);
    const stranger = hexToBytes('0'.repeat(63) + '3');
    expect(() => unwrapEvent(wrap, stranger)).toThrow();
  });
});

describe('reading an ack', () => {
  it('reads active, revoked and refused acks for a grant', async () => {
    expect(await unwrapKeepAck(ackWrap([['status', 'active'], ['grant', GRANT]]), owner, keeps))
      .toEqual({ keep: K, status: 'active', grant: GRANT, claim: false, at: NOW });
    expect(await unwrapKeepAck(ackWrap([['status', 'revoked'], ['grant', GRANT]]), owner, keeps))
      .toMatchObject({ status: 'revoked', grant: GRANT });
    expect(await unwrapKeepAck(ackWrap([['status', 'refused'], ['grant', GRANT], ['reason', 'full']]), owner, keeps))
      .toMatchObject({ status: 'refused', reason: 'full' });
  });

  it('reads the ack of a claim', async () => {
    expect(await unwrapKeepAck(ackWrap([['status', 'paired'], ['claim']]), owner, keeps))
      .toEqual({ keep: K, status: 'paired', claim: true, at: NOW });
  });

  it('drops a seal signed by anyone but a known Keep (another app\'s wrap to the same persona)', async () => {
    const other = hexToBytes('0'.repeat(63) + '9');
    expect(await unwrapKeepAck(ackWrap([['status', 'active'], ['grant', GRANT]], { signer: other }), owner, keeps)).toBeNull();
  });

  it('drops an ack whose keep tag names a different Keep', async () => {
    expect(await unwrapKeepAck(ackWrap([['status', 'active'], ['grant', GRANT]], { keepTag: 'ab'.repeat(32) }), owner, keeps)).toBeNull();
  });

  it('drops a wrap addressed to a different persona', async () => {
    const third = hexToBytes('0'.repeat(63) + '3');
    expect(await unwrapKeepAck(ackWrap([['status', 'active'], ['grant', GRANT]], { to: getPublicKey(third) }), owner, keeps)).toBeNull();
  });

  it('drops a rumor whose author is not the seal\'s signer', async () => {
    // Build by hand: seal signed by the Keep, rumor claiming another author.
    const rumor = { kind: 27663, content: '', created_at: NOW, tags: [['keep', K], ['status', 'active'], ['grant', GRANT]], pubkey: O };
    const id = (await import('nostr-tools/pure')).getEventHash(rumor);
    const sealed = await new LocalSigningBackend(KEEP_SK_HEX).nip44Encrypt(O, JSON.stringify({ ...rumor, id }));
    const seal = finalizeEvent({ kind: 13, content: sealed, created_at: NOW, tags: [] }, keepSk);
    const eph = hexToBytes('0'.repeat(63) + '7');
    const inner = await new LocalSigningBackend(bytesToHex(eph)).nip44Encrypt(O, JSON.stringify(seal));
    const wrap = finalizeEvent({ kind: 1059, content: inner, created_at: NOW, tags: [['p', O]] }, eph);
    expect(await unwrapKeepAck(wrap, owner, keeps)).toBeNull();
  });

  it('drops a seal with a bad signature', async () => {
    const rumor = { kind: 27663, content: '', created_at: NOW, tags: [['keep', K], ['status', 'active'], ['grant', GRANT]], pubkey: K };
    const id = (await import('nostr-tools/pure')).getEventHash(rumor);
    const sealed = await new LocalSigningBackend(KEEP_SK_HEX).nip44Encrypt(O, JSON.stringify({ ...rumor, id }));
    const seal = finalizeEvent({ kind: 13, content: sealed, created_at: NOW, tags: [] }, keepSk);
    const forged = { ...seal, sig: seal.sig.replace(/^../, seal.sig.startsWith('00') ? '11' : '00') };
    const eph = hexToBytes('0'.repeat(63) + '7');
    const inner = await new LocalSigningBackend(bytesToHex(eph)).nip44Encrypt(O, JSON.stringify(forged));
    const wrap = finalizeEvent({ kind: 1059, content: inner, created_at: NOW, tags: [['p', O]] }, eph);
    expect(await unwrapKeepAck(wrap, owner, keeps)).toBeNull();
  });

  it('drops garbage without throwing', async () => {
    const eph = hexToBytes('0'.repeat(63) + '7');
    const wrap = finalizeEvent({ kind: 1059, content: 'not encrypted', created_at: NOW, tags: [['p', O]] }, eph);
    expect(await unwrapKeepAck(wrap, owner, keeps)).toBeNull();
  });

  it.each([
    ['an unknown status', [['status', 'maybe'], ['grant', GRANT]]],
    ['refused without a reason', [['status', 'refused'], ['grant', GRANT]]],
    ['refused with an unknown reason', [['status', 'refused'], ['grant', GRANT], ['reason', 'because']]],
    ['active without a grant', [['status', 'active']]],
    ['active with a short grant', [['status', 'active'], ['grant', 'ab']]],
    ['paired without the claim tag', [['status', 'paired']]],
    ['two status tags', [['status', 'active'], ['status', 'revoked'], ['grant', GRANT]]],
  ])('refuses %s', (_label, tags) => {
    expect(parseAckRumor({ kind: 27663, created_at: NOW, tags: [['keep', K], ...tags as string[][]] }, K)).toBeNull();
  });

  it('ignores a rumor of another kind', () => {
    expect(parseAckRumor({ kind: 27661, created_at: NOW, tags: [['keep', K], ['status', 'active'], ['grant', GRANT]] }, K)).toBeNull();
  });
});
