import { describe, expect, it } from 'vitest';
import {
  activeOwners, applyOwnersAck, canUnlink, composeUpdate, gamesState, isActiveOwner, linkPersona, markOwnersSent, ownersDue,
  pickSigner, playInvite, reconcileKeep, scopeLabel, setSection, unlinkPersona, type ReconcileContext,
} from './keep-owners';
import { newPendingKeep, type StoredInvite, type StoredKeep } from './keep-store';
import type { KeepAck } from './keep-messages';
import { KEEP_GAMES_INVITE_S } from './keep-wire';

const K = 'ab'.repeat(32);
const A = '0a'.repeat(32);
const B = '0b'.repeat(32);
const C = '0c'.repeat(32);
const DAY = 86400;
const NOW = 1_800_000_000;

const paired = (scope: 'all' | 'one' = 'all'): StoredKeep => {
  const { code: _c, ...rest } = newPendingKeep({ keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: A, code: '33'.repeat(16), now: 1, scope });
  return { ...rest, status: 'paired' };
};
let counter = 0;
const ctx = (o: Partial<ReconcileContext> = {}): ReconcileContext => ({
  now: NOW, eligible: [A, B], canSign: () => true, nameOf: p => ({ [A]: 'Alice', [B]: 'Bob', [C]: 'Cara' } as Record<string, string>)[p] ?? 'x',
  randomHex: n => (++counter).toString(16).padStart(n * 2, '0'), ...o,
});
const ack = (o: Partial<KeepAck>): KeepAck => ({ keep: K, status: 'updated', claim: false, owners: true, at: NOW, ...o });
const apply = (k: StoredKeep, a: Partial<KeepAck>) => applyOwnersAck([k], ack(a))[0];

describe('the owner list', () => {
  it('starts with the claimer active and linking adds a persona that is not', () => {
    const k = linkPersona(paired(), B)!;
    expect(k.personas).toEqual([A, B]);
    expect(isActiveOwner(k, A)).toBe(true);
    expect(isActiveOwner(k, B)).toBe(false);
    expect(k.links[B].sections).toEqual(['games']);
    expect(k.seen).toEqual([A, B]);
    expect(linkPersona(k, B)).toBeNull();
  });

  it('refuses a 17th persona', () => {
    let k = paired();
    for (let i = 1; i < 16; i++) k = linkPersona(k, i.toString(16).padStart(64, '0'))!;
    expect(k.personas).toHaveLength(16);
    expect(linkPersona(k, C)).toBeNull();
  });

  it('composeUpdate makes the next revision, lists every persona and asks an accept of each that is not active', () => {
    const k = composeUpdate(linkPersona(paired(), B)!, A);
    expect(k.update).toEqual({ rev: 1, signer: A, sentAt: 0, personas: [{ persona: A, sections: ['games'] }, { persona: B, sections: ['games'] }] });
    expect(k.links[A].accept).toBeUndefined();
    expect(k.links[B]).toMatchObject({ addedRev: 1, active: false, accept: { rev: 1, sentAt: 0 } });
  });

  it('a second change before an answer replaces the update at the next revision and the accept follows it', () => {
    const one = composeUpdate(linkPersona(paired(), B)!, A);
    const two = composeUpdate(linkPersona(one, C)!, A);
    expect(two.update!.rev).toBe(2);
    expect(two.links[B].accept!.rev).toBe(2);
    expect(two.links[B].addedRev).toBe(1);
    expect(two.links[C]).toMatchObject({ addedRev: 2, accept: { rev: 2 } });
  });

  it('unlinking needs another active owner to remain, and is not undone by the auto-link', () => {
    const k = linkPersona(paired(), B)!; // B not active yet
    expect(canUnlink(k, A)).toBe(false);
    expect(unlinkPersona(k, A)).toBeNull();
    expect(unlinkPersona(k, B)!.personas).toEqual([A]);
    const both = apply(composeUpdate(k, A), { rev: 1, to: B }); // B's accept acked
    expect(isActiveOwner(both, B)).toBe(true);
    const noA = unlinkPersona(both, A)!;
    expect(noA.personas).toEqual([B]);
    expect(noA.seen).toContain(A);
    expect(pickSigner(noA, () => true)).toBe(B);
  });

  it('setSection turns games on and off for one persona', () => {
    const k = setSection(paired(), A, 'games', false)!;
    expect(k.links[A].sections).toEqual([]);
    expect(setSection(k, A, 'games', false)).toBeNull();
    expect(setSection(k, A, 'games', true)!.links[A].sections).toEqual(['games']);
  });

  it('pickSigner prefers the one asked for, then the claimer, and needs the key', () => {
    const k = apply(composeUpdate(linkPersona(paired(), B)!, A), { rev: 1, to: B });
    expect(pickSigner(k, () => true, B)).toBe(B);
    expect(pickSigner(k, () => true)).toBe(A);
    expect(pickSigner(k, p => p === B)).toBe(B);
    expect(pickSigner(k, () => false)).toBeNull();
    expect(pickSigner(linkPersona(k, C)!, p => p === C)).toBeNull(); // C is not active
    expect(activeOwners(k)).toEqual([A, B]);
  });
});

describe('acks of an update and an accept', () => {
  const sent = () => composeUpdate(linkPersona(paired(), B)!, A);

  it('updated at the update revision, to its signer, ends the update and learns the revision', () => {
    const k = apply(sent(), { status: 'updated', rev: 1, to: A });
    expect(k.update).toBeUndefined();
    expect(k.rev).toBe(1);
    expect(isActiveOwner(k, B)).toBe(false);
  });

  it('updated to the added persona makes it active and drops its accept', () => {
    const k = apply(sent(), { status: 'updated', rev: 1, to: B });
    expect(isActiveOwner(k, B)).toBe(true);
    expect(k.links[B].accept).toBeUndefined();
    expect(k.update).toBeDefined(); // the signer's own ack has not come
  });

  it('an updated for an older revision does not make a newer accept active', () => {
    const two = composeUpdate(sent(), A); // rev 2, accept rev 2
    const k = apply(two, { status: 'updated', rev: 1, to: B });
    expect(isActiveOwner(k, B)).toBe(false);
    expect(k.rev).toBe(1);
  });

  it('pending holds the accept; once the update lands it is sent again', () => {
    const p = apply(sent(), { status: 'pending', rev: 0, to: B });
    expect(p.links[B].accept).toMatchObject({ pending: true });
    expect(ownersDue({ ...p, update: { ...p.update!, sentAt: NOW } }, NOW + 5000).accepts).toEqual([]); // waits while the update is out
    const landed = apply({ ...p, links: { ...p.links, [B]: { ...p.links[B], accept: { ...p.links[B].accept!, sentAt: NOW } } } }, { status: 'updated', rev: 1, to: A });
    expect(landed.update).toBeUndefined();
    expect(landed.links[B].accept).toEqual({ rev: 1, sentAt: 0 });
    expect(ownersDue(landed, NOW).accepts).toEqual([B]);
  });

  it('refused stale takes the Keep\'s revision and tries again one higher, once', () => {
    const first = apply(sent(), { status: 'refused', reason: 'stale', rev: 5, to: A });
    expect(first.rev).toBe(5);
    expect(first.update).toMatchObject({ rev: 6, retried: true, signer: A, sentAt: 0 });
    expect(first.links[B].accept!.rev).toBe(6);
    const second = apply(first, { status: 'refused', reason: 'stale', rev: 9, to: A });
    expect(second.update).toMatchObject({ rev: 6, failed: 'stale' });
    expect(ownersDue(second, NOW + 99999)).toEqual({ update: false, accepts: [] });
    expect(composeUpdate(second, A).update).toMatchObject({ rev: 10 });
    expect(composeUpdate(second, A).update!.failed).toBeUndefined();
  });

  it('a stale ack for an older send than ours is ignored', () => {
    const k = composeUpdate(sent(), A); // rev 2
    const list = [k];
    expect(applyOwnersAck(list, ack({ status: 'refused', reason: 'stale', rev: 1, to: A }))).toBe(list);
  });

  it('too_many and malformed end the update for good; others\' acks change nothing', () => {
    expect(apply(sent(), { status: 'refused', reason: 'too_many', to: A }).update!.failed).toBe('too_many');
    expect(apply(sent(), { status: 'refused', reason: 'malformed', to: A }).update!.failed).toBe('malformed');
    const list = [sent()];
    expect(applyOwnersAck(list, ack({ status: 'refused', reason: 'malformed', to: C }))).toBe(list);
    const stranger = applyOwnersAck(list, ack({ status: 'updated', rev: 1, to: C }))[0]; // only the revision is learnt
    expect({ ...stranger, rev: 0 }).toEqual(list[0]);
    expect(applyOwnersAck(list, { ...ack({ status: 'updated', rev: 1 }), keep: 'ff'.repeat(32), to: A })).toBe(list);
  });
});

describe('what is sent again', () => {
  it('an unanswered update and accept go again after ten minutes, not before', () => {
    const k = composeUpdate(linkPersona(paired(), B)!, A);
    expect(ownersDue(k, NOW)).toEqual({ update: true, accepts: [B] }); // never sent
    const sent = markOwnersSent(k, { update: true, accepts: [B] }, NOW);
    expect(ownersDue(sent, NOW + 599)).toEqual({ update: false, accepts: [] });
    expect(ownersDue(sent, NOW + 601)).toEqual({ update: true, accepts: [B] });
    expect(ownersDue({ ...sent, status: 'pending' }, NOW + 9999)).toEqual({ update: false, accepts: [] });
  });
});

describe('reconcile', () => {
  it('an all-my-personas Keep links every eligible persona at revision 1, with games, and asks Bob to accept', () => {
    const k = reconcileKeep(paired('all'), ctx());
    expect(k.update).toMatchObject({ rev: 1, signer: A });
    expect(k.update!.personas.map(p => [p.persona, p.sections])).toEqual([[A, ['games']], [B, ['games']]]);
    expect(Object.keys(k.links)).toEqual([A, B]);
    expect(k.links[B].accept).toBeDefined();
    expect(k.links[A].accept).toBeUndefined();
    expect(k.seen).toEqual([A, B]);
  });

  it('an only-this-persona Keep links nothing by itself', () => {
    const k = reconcileKeep(paired('one'), ctx());
    expect(k.update).toBeUndefined();
    expect(k.personas).toEqual([A]);
  });

  it('a persona created later is linked by the next update, once; an unlinked one stays unlinked', () => {
    const settled = apply(apply(reconcileKeep(paired('all'), ctx()), { rev: 1, to: A }), { rev: 1, to: B });
    expect(settled.update).toBeUndefined();
    const later = reconcileKeep(settled, ctx({ eligible: [A, B, C] }));
    expect(later.update).toMatchObject({ rev: 2 });
    expect(later.personas).toEqual([A, B, C]);
    expect(later.links[C].accept).toMatchObject({ rev: 2 });
    const none = reconcileKeep(apply(apply(later, { rev: 2, to: A }), { rev: 2, to: C }), ctx({ eligible: [A, B, C] }));
    expect(none.update).toBeUndefined();
    const off = unlinkPersona(none, B)!;
    expect(reconcileKeep(off, ctx({ eligible: [A, B, C] })).update).toBeUndefined();
  });

  it('does not link a persona nobody can sign for, or when no owner key is held', () => {
    expect(reconcileKeep(paired('all'), ctx({ eligible: [A], canSign: () => true })).update).toBeUndefined();
    expect(reconcileKeep(paired('all'), ctx({ canSign: () => false })).update).toBeUndefined();
    expect(reconcileKeep(paired('all'), ctx({ canSign: p => p === A, eligible: [A, B] })).personas).toEqual([A, B]); // B is the persona the claimer lists; its key is checked by the caller's eligible list
  });

  it('does nothing before the Keep is paired, and not while an update has failed', () => {
    const pend = { ...paired('all'), status: 'pending' as const };
    expect(reconcileKeep(pend, ctx())).toBe(pend);
    const failed = { ...paired('all'), update: { rev: 1, signer: A, personas: [], sentAt: 1, failed: 'malformed' as const } };
    expect(reconcileKeep(failed, ctx()).update).toBe(failed.update);
  });

  it('keeps a games invite for each persona with games on: personal, "<name> (owner)", 365 days less an hour, not yet sent', () => {
    const k = reconcileKeep(paired('one'), ctx());
    expect(k.invites).toHaveLength(1);
    expect(k.invites[0]).toMatchObject({
      kind: 'personal', persona: A, gamesFor: A, label: 'Alice (owner)', status: 'waiting', sentAt: 0,
      expiration: NOW + KEEP_GAMES_INVITE_S, createdAt: NOW,
    });
    expect(KEEP_GAMES_INVITE_S).toBeLessThanOrEqual(365 * DAY);
    expect(reconcileKeep(k, ctx())).toBe(k); // idempotent
  });

  it('cuts a long persona name so the label keeps "(owner)" inside 40', () => {
    const k = reconcileKeep(paired('one'), ctx({ nameOf: () => 'N'.repeat(60) }));
    expect(k.invites[0].label).toBe(`${'N'.repeat(31)} (owner)`);
    expect(k.invites[0].label!.length).toBeLessThanOrEqual(40);
  });

  const withActive = (k: StoredKeep, o: Partial<StoredInvite> = {}): StoredKeep => ({
    ...k, invites: k.invites.map(i => ({ ...i, status: 'active' as const, ...o })),
  });

  it('renews with a new grant when under 30 days are left and revokes the old one only after the new one is active', () => {
    const first = withActive(reconcileKeep(paired('one'), ctx()), { expiration: NOW + 29 * DAY });
    const renewed = reconcileKeep(first, ctx());
    expect(renewed.invites).toHaveLength(2);
    const [old, fresh] = renewed.invites;
    expect(fresh).toMatchObject({ gamesFor: A, status: 'waiting', expiration: NOW + KEEP_GAMES_INVITE_S });
    expect(fresh.grant).not.toBe(old.grant);
    expect(fresh.secret).not.toBe(old.secret);
    expect(old.revokeSent).toBeUndefined(); // the new one has not been acked
    expect(playInvite(renewed, A, NOW)!.grant).toBe(old.grant); // Play here still has a working one
    const acked = { ...renewed, invites: renewed.invites.map(i => (i.grant === fresh.grant ? { ...i, status: 'active' as const } : i)) };
    const done = reconcileKeep(acked, ctx());
    expect(done.invites.find(i => i.grant === old.grant)).toMatchObject({ revokeSent: true, revokeSentAt: 0 });
    expect(done.invites.find(i => i.grant === fresh.grant)!.revokeSent).toBeUndefined();
    expect(playInvite(done, A, NOW)!.grant).toBe(fresh.grant);
    expect(reconcileKeep(done, ctx())).toBe(done);
  });

  it('does not renew with 31 days left', () => {
    const k = withActive(reconcileKeep(paired('one'), ctx()), { expiration: NOW + 31 * DAY });
    expect(reconcileKeep(k, ctx())).toBe(k);
  });

  it('games off revokes the persona\'s invites; unlinking revokes them too; back on makes a new one', () => {
    const on = withActive(reconcileKeep(paired('one'), ctx()));
    const off = reconcileKeep(setSection(on, A, 'games', false)!, ctx());
    expect(off.invites[0]).toMatchObject({ revokeSent: true, revokeSentAt: 0 });
    expect(off.invites).toHaveLength(1);
    expect(gamesState(off, A, NOW)).toBe('off');
    const back = reconcileKeep(setSection(off, A, 'games', true)!, ctx());
    expect(back.invites).toHaveLength(2);
    expect(back.invites[1].status).toBe('waiting');

    const two = reconcileKeep(apply(apply(reconcileKeep(paired('all'), ctx()), { rev: 1, to: A }), { rev: 1, to: B }), ctx());
    const both = { ...two, invites: two.invites.map(i => ({ ...i, status: 'active' as const })) };
    const gone = reconcileKeep(unlinkPersona(both, B)!, ctx());
    expect(gone.invites.find(i => i.gamesFor === B)).toMatchObject({ revokeSent: true });
    expect(gone.invites.find(i => i.gamesFor === A)!.revokeSent).toBeUndefined();
  });

  it('a refused games invite is not made again by itself', () => {
    const k = withActive(reconcileKeep(paired('one'), ctx()), { status: 'refused', reason: 'full' });
    expect(reconcileKeep(k, ctx())).toBe(k);
    expect(gamesState(k, A, NOW)).toBe('refused');
  });

  it('an expired games invite is replaced; a revoked one is not counted', () => {
    const k = withActive(reconcileKeep(paired('one'), ctx()), { expiration: NOW - 1 });
    expect(reconcileKeep(k, ctx()).invites).toHaveLength(2);
  });

  it('members\' invites are left alone', () => {
    const member: StoredInvite = { grant: '9'.repeat(32), secret: '8'.repeat(64), kind: 'guest', createdAt: 1, expiration: NOW + DAY, status: 'active' };
    const k = reconcileKeep({ ...paired('one'), invites: [member] }, ctx());
    expect(k.invites[0]).toBe(member);
  });
});

describe('words', () => {
  const names = (p: string) => ({ [A]: 'Alice', [B]: 'Bob', [C]: 'Cara' } as Record<string, string>)[p];
  it('All of you when every persona is linked, else Only <names>', () => {
    const one = paired('one');
    expect(scopeLabel(one, [A, B], names)).toBe('Only Alice');
    expect(scopeLabel(linkPersona(one, B)!, [A, B], names)).toBe('All of you');
    expect(scopeLabel(paired('all'), [A], names)).toBe('All of you');
    expect(scopeLabel(paired('one'), [A], names)).toBe('Only Alice');
    expect(scopeLabel(linkPersona(one, B)!, [A, B, C], names)).toBe('Only Alice, Bob');
  });
});
