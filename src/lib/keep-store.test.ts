import { describe, expect, it } from 'vitest';
import {
  applyAck, inviteStatusLabel, markRevokeSent, newPendingKeep, parseStoredKeeps, repairKeep, withInvite, withKeep,
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
