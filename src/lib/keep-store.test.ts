import { describe, expect, it } from 'vitest';
import {
  CLAIM_ACK_SKEW_S, KEEP_LOOKUP_CAP, applyAck, clampAckTime, inviteStatusLabel, markRevokeSent, newPendingKeep, parseKeepLookups, parseStoredKeeps,
  repairKeep, withInvite, withKeep, withLookupKey,
  type StoredInvite, type StoredKeep,
} from './keep-store';

const K = 'ab'.repeat(32);
const O = 'cd'.repeat(32);
const G = '11'.repeat(16);
const invite = (o: Partial<StoredInvite> = {}): StoredInvite => ({
  grant: G, secret: '22'.repeat(32), kind: 'guest', label: 'Guest pass', createdAt: 100, expiration: 200, status: 'waiting', ...o,
});
const pending = (): StoredKeep => newPendingKeep({ keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: O, code: '33'.repeat(16), now: 50 });
const paired = (): StoredKeep => { const { code: _c, ...rest } = pending(); return { ...rest, status: 'paired' }; };

describe('stored Keep record', () => {
  it('is account-level: claimedBy and personas = [claimedBy]', () => {
    const keep = pending();
    expect(keep).toMatchObject({ keep: K, claimedBy: O, personas: [O], status: 'pending', code: '33'.repeat(16), invites: [] });
  });

  it('round-trips through the parser and rejects malformed lists', () => {
    const list = [withInvite(paired(), invite())];
    expect(parseStoredKeeps(JSON.parse(JSON.stringify(list)))).toEqual(list);
    expect(parseStoredKeeps({})).toBeNull();
    expect(parseStoredKeeps([{ ...pending(), keep: 'nope' }])).toBeNull();
    expect(parseStoredKeeps([pending(), pending()])).toBeNull();
    expect(parseStoredKeeps([withInvite(paired(), invite({ status: 'weird' as never }))])).toBeNull();
    expect(parseStoredKeeps([{ ...pending(), personas: ['x'] }])).toBeNull();
  });
});

describe('a record made before the times of an update and an accept were kept', () => {
  it('reads them as made at the claim, and is still readable', () => {
    const B = 'ee'.repeat(32);
    const raw = JSON.parse(JSON.stringify({
      ...paired(), claimedAt: 777, rev: 1,
      personas: [O, B],
      links: { [O]: { sections: ['games'], active: true }, [B]: { sections: ['games'], active: false, accept: { rev: 2, sentAt: 5 } } },
      update: { rev: 2, signer: O, personas: [{ persona: O, sections: ['games'] }], sentAt: 5 },
    }));
    const [k] = parseStoredKeeps([raw])!;
    expect(k.update!.composedAt).toBe(777);
    expect(k.links[B].accept!.composedAt).toBe(777);
  });
});

describe('applyAck', () => {
  const ack = (o: object) => ({ keep: K, claim: false, status: 'active' as const, grant: G, at: 1000, ...o });

  it('paired drops the claim code', () => {
    const next = applyAck([pending()], { keep: K, status: 'paired', claim: true, at: 5 });
    expect(next[0].status).toBe('paired');
    expect(next[0].code).toBeUndefined();
  });

  it('a claim ack dated well before the claim is from an earlier pairing and is ignored', () => {
    const k = { ...pending(), claimedAt: 100_000 };
    const list = [k];
    expect(applyAck(list, { keep: K, status: 'paired', claim: true, at: 100_000 - 601 })).toBe(list);
    expect(applyAck(list, { keep: K, status: 'paired', claim: true, at: 100_000 - 60 })[0].status).toBe('paired');
  });

  it('repairKeep goes back to pending with the new code, relays and name, and keeps the invites', () => {
    const k = repairKeep(withInvite(paired(), invite()), { name: 'New', relays: ['wss://z.example'], code: '44'.repeat(16), now: 999 });
    expect(k).toMatchObject({ status: 'pending', code: '44'.repeat(16), name: 'New', relays: ['wss://z.example'], claimedAt: 999 });
    expect(k.invites).toHaveLength(1);
  });

  it('a repeated paired ack changes nothing (same list back)', () => {
    const list = [paired()];
    expect(applyAck(list, { keep: K, status: 'paired', claim: true, at: 5 })).toBe(list);
  });

  it('active, revoked and refused set the invite state', () => {
    const list = [withInvite(paired(), invite())];
    expect(applyAck(list, ack({}))[0].invites[0].status).toBe('active');
    expect(applyAck(list, ack({ status: 'refused', reason: 'full' }))[0].invites[0]).toMatchObject({ status: 'refused', reason: 'full' });
    expect(applyAck(list, ack({ status: 'revoked' }))[0].invites[0].status).toBe('revoked');
  });

  it('a revoke is final: a late active ack does not undo it', () => {
    const revoked = applyAck([withInvite(paired(), invite())], ack({ status: 'revoked', at: 10 }));
    const after = applyAck(revoked, ack({ status: 'active', at: 99 }));
    expect(after).toBe(revoked);
  });

  it('an older ack does not replace a newer one', () => {
    const active = applyAck([withInvite(paired(), invite())], ack({ at: 500 }));
    expect(applyAck(active, ack({ status: 'refused', reason: 'full', at: 400 }))).toBe(active);
    expect(applyAck(active, ack({ status: 'refused', reason: 'full', at: 600 }))[0].invites[0].status).toBe('refused');
  });

  it('ignores an ack for an unknown Keep or grant', () => {
    const list = [withInvite(paired(), invite())];
    expect(applyAck(list, ack({ keep: 'ee'.repeat(32) }))).toBe(list);
    expect(applyAck(list, ack({ grant: '99'.repeat(16) }))).toBe(list);
  });

  it('an ack for a Keep other than the stored one never touches it', () => {
    const other = withKeep([paired()], { ...paired(), keep: 'ee'.repeat(32) });
    const next = applyAck(other, ack({ keep: 'ee'.repeat(32), status: 'refused', reason: 'full' }));
    expect(next.find(k => k.keep === K)).toEqual(other.find(k => k.keep === K));
  });
});

describe('labels', () => {
  it('uses the contract words', () => {
    expect(inviteStatusLabel(invite())).toBe('Waiting for the Keep');
    expect(inviteStatusLabel(invite({ status: 'active' }))).toBe('Active');
    expect(inviteStatusLabel(invite({ status: 'revoked' }))).toBe('Revoked');
    expect(inviteStatusLabel(invite({ status: 'refused', reason: 'expired' }))).toBe('Refused (it had already expired)');
  });
  it('shows a sent revoke as pending until the Keep answers', () => {
    const k = markRevokeSent(withInvite(paired(), invite({ status: 'active' })), G);
    expect(inviteStatusLabel(k.invites[0])).toMatch(/waiting for the Keep/i);
  });
});

describe('K1d records read as K1e', () => {
  const k1d = () => {
    const { scope: _s, rev: _r, links: _l, seen: _e, ...rest } = paired();
    return JSON.parse(JSON.stringify(rest));
  };

  it('become scope one, revision 0, with the claimer as the only active owner persona', () => {
    const [k] = parseStoredKeeps([k1d()])!;
    expect(k).toMatchObject({ scope: 'one', rev: 0, personas: [O], seen: [O] });
    expect(k.links).toEqual({ [O]: { sections: ['games'], addedRev: 0, active: true } });
    expect(k.update).toBeUndefined();
  });

  it('keep every K1d field, invites included', () => {
    const old = { ...k1d(), invites: [invite()] };
    expect(parseStoredKeeps([old])![0]).toMatchObject({ keep: K, name: 'Home', claimedBy: O, status: 'paired', invites: [invite()] });
  });

  it('a K1e record round-trips unchanged', () => {
    const list = [withInvite(paired(), invite({ gamesFor: O }))];
    expect(parseStoredKeeps(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  it('is refused whole when a K1e field is bad (never read as empty)', () => {
    expect(parseStoredKeeps([{ ...paired(), scope: 'some' }])).toBeNull();
    expect(parseStoredKeeps([{ ...paired(), rev: -1 }])).toBeNull();
    expect(parseStoredKeeps([{ ...paired(), links: { x: { sections: [], active: true } } }])).toBeNull();
    expect(parseStoredKeeps([{ ...paired(), links: { [O]: { sections: [1], active: true } } }])).toBeNull();
    expect(parseStoredKeeps([{ ...paired(), update: { rev: 1 } }])).toBeNull();
    expect(parseStoredKeeps([withInvite(paired(), invite({ gamesFor: 'x' }))])).toBeNull();
  });

  it('a new pending Keep carries the scope it was claimed with', () => {
    const k = newPendingKeep({ keep: K, name: 'H', relays: ['wss://a.example'], claimedBy: O, code: '33'.repeat(16), now: 1, scope: 'all' });
    expect(k).toMatchObject({ scope: 'all', rev: 0, personas: [O] });
  });

  it('pairing again keeps the list, the revision and the personas met, makes the others accept again, and sends the games invites again', () => {
    const base = { ...paired(), scope: 'all' as const, rev: 4, update: { rev: 6, signer: O, personas: [], sentAt: 1, composedAt: 1 } };
    const B = 'ee'.repeat(32);
    const C = 'ff'.repeat(32);
    const withB = {
      ...base, personas: [O, B], seen: [O, B, C],
      links: { ...base.links, [B]: { sections: ['games'], addedRev: 3, active: true, accept: undefined } },
    };
    const kept = withInvite(withB, invite({ gamesFor: O, status: 'active', ackAt: 9 }));
    const again = repairKeep({ ...kept, ackCursors: { [O]: 5 } }, { name: 'N', relays: ['wss://z.example'], code: '44'.repeat(16), now: 99 });
    // scope stays unless the new claim says otherwise; the unanswered update's revision is not reused
    expect(again).toMatchObject({ status: 'pending', scope: 'all', rev: 6, personas: [O, B], seen: [O, B, C] });
    expect(again.update).toBeUndefined();
    expect(again.ackCursors).toBeUndefined();
    expect(again.links[O]).toMatchObject({ active: true });
    expect(again.links[B]).toMatchObject({ sections: ['games'], addedRev: 3, active: false });
    expect(again.invites[0]).toMatchObject({ gamesFor: O, status: 'waiting', sentAt: 0 });
    expect(repairKeep(kept, { name: 'N', relays: [], code: '44'.repeat(16), now: 99, scope: 'one' }).scope).toBe('one');
  });

  it('pairing again puts the claimer back on the list if it had been taken off', () => {
    const B = 'ee'.repeat(32);
    const k = { ...paired(), personas: [B], links: { [B]: { sections: [], active: true } } };
    const again = repairKeep(k, { name: 'N', relays: ['wss://z.example'], code: '44'.repeat(16), now: 99 });
    expect(again.personas).toEqual([O, B]);
    expect(again.links[O].active).toBe(true);
    expect(again.links[B].active).toBe(false);
  });
});

describe('applyAck: ack times are capped at now plus the skew', () => {
  const ack = (o: object) => ({ keep: K, claim: false, status: 'active' as const, grant: G, at: 1000, ...o });
  const NOW = 10_000;

  it('clampAckTime caps a future time and leaves the rest', () => {
    expect(clampAckTime(NOW + 99_999, NOW)).toBe(NOW + CLAIM_ACK_SKEW_S);
    expect(clampAckTime(NOW - 5, NOW)).toBe(NOW - 5);
  });

  it('stores a future-dated ack at now plus the skew, not at its own time', () => {
    const next = applyAck([withInvite(paired(), invite())], ack({ at: 4_000_000_000 }), NOW);
    expect(next[0].invites[0]).toMatchObject({ status: 'active', ackAt: NOW + CLAIM_ACK_SKEW_S });
  });

  it('a future-dated active ack cannot make a later genuine revoked ack look stale', () => {
    const active = applyAck([withInvite(paired(), invite())], ack({ at: 4_000_000_000 }), NOW);
    const revoked = applyAck(active, ack({ status: 'revoked', at: NOW + 5 }), NOW + 5);
    expect(revoked[0].invites[0]).toMatchObject({ status: 'revoked', revokeSent: false });
  });

  it('a revoke is applied even when it is dated before the ack it follows', () => {
    const active = applyAck([withInvite(paired(), invite())], ack({ at: 5_000 }), NOW);
    expect(applyAck(active, ack({ status: 'revoked', at: 4_000 }), NOW)[0].invites[0].status).toBe('revoked');
  });

  it('a future-dated value stored earlier is read back capped, so a genuine later ack applies', () => {
    const stuck = [withInvite(paired(), invite({ status: 'active', ackAt: 4_000_000_000 }))];
    const next = applyAck(stuck, ack({ status: 'refused', reason: 'full', at: NOW + CLAIM_ACK_SKEW_S }), NOW);
    expect(next[0].invites[0]).toMatchObject({ status: 'refused', ackAt: NOW + CLAIM_ACK_SKEW_S });
  });
});

describe('remembered lookup keys', () => {
  const A = 'aa'.repeat(32);
  const B = 'bb'.repeat(32);

  it('parses only lowercase hex keys, once each, up to the cap; anything else is none', () => {
    expect(parseKeepLookups({ keys: [A, A, 'nope', 5, B.toUpperCase(), B] })).toEqual([A, B]);
    expect(parseKeepLookups(null)).toEqual([]);
    expect(parseKeepLookups([A])).toEqual([]);
    const many = Array.from({ length: KEEP_LOOKUP_CAP + 3 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    expect(parseKeepLookups({ keys: many })).toHaveLength(KEEP_LOOKUP_CAP);
  });

  it('adds a key once, and returns the same list when it is already there or is not a key', () => {
    const list = withLookupKey([], A);
    expect(list).toEqual([A]);
    expect(withLookupKey(list, A)).toBe(list);
    expect(withLookupKey(list, 'nope')).toBe(list);
    expect(withLookupKey(list, B.toUpperCase())).toEqual([A, B]);
  });
});
