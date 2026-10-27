import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

let row: unknown = null;
let dbThrows = false;
vi.mock('./db', () => ({
  loadKeepsRow: async () => {
    if (dbThrows) throw new Error('decrypt failed');
    return row === null ? null : JSON.parse(JSON.stringify(row));
  },
  saveKeepsRow: async (value: unknown) => { row = JSON.parse(JSON.stringify(value)); },
}));
const fetchMock = vi.fn();
const subscribeMock = vi.fn();
vi.mock('./relay-service', () => ({
  fetchEventsWithReach: (...a: unknown[]) => fetchMock(...a),
  subscribeEvents: (...a: unknown[]) => subscribeMock(...a),
}));

import { LocalSigningBackend } from './signing-backend';
import {
  NotAnOwnerError, OwnerChangeRefusedError, PersonaNotAvailableError, applyAckEvents, catchUp, changeOwners, claimKeep, loadStoredKeeps, refreshAcks, updateStoredKeeps,
  settle, watchAcks, type KeepDeps,
} from './keep-service';
import { KeepsUnreadableError, type StoredKeep } from './keep-store';
import { parseKeepPairLink } from './keep-link';

const KEEP_SK = hexToBytes('0'.repeat(63) + '1');
const K = getPublicKey(KEEP_SK);
const SK_A = '0'.repeat(63) + '2';
const SK_B = '0'.repeat(63) + '3';
const SK_C = '0'.repeat(63) + '4';
const A = getPublicKey(hexToBytes(SK_A));
const B = getPublicKey(hexToBytes(SK_B));
const C = getPublicKey(hexToBytes(SK_C));
const SKS: Record<string, string> = { [A]: SK_A, [B]: SK_B, [C]: SK_C };
const NAMES: Record<string, string> = { [A]: 'Alice', [B]: 'Bob', [C]: 'Cara' };
const NOW = 1_800_000_000;
const DAY = 86400;
const CODE = '33'.repeat(16);
const link = parseKeepPairLink(`signet-keep:pair?k=${K}&c=${CODE}&n=Home&r=wss://a.example`)!;

const published: Array<{ wrap: NostrEvent; relays: readonly string[] }> = [];
let t = NOW;
let held = [A, B];
let account = [A, B];
const deps = (over: Partial<KeepDeps> = {}): KeepDeps => ({
  encryptionKey: 'key',
  backendFor: p => (held.includes(p) ? new LocalSigningBackend(SKS[p]) : null),
  eligiblePersonas: () => account.filter(p => held.includes(p)),
  personaName: p => NAMES[p],
  publish: async (wrap, relays) => { published.push({ wrap, relays }); return relays.map(() => true); },
  now: () => t,
  ...over,
});
const rumors = () => published.map(p => unwrapEvent(p.wrap as never, KEEP_SK));
const kinds = () => rumors().map(r => r.kind);
const tag = (r: { tags: string[][] }, name: string) => r.tags.find(x => x[0] === name);
const ack = (to: string, tags: string[][], at = NOW + 1) =>
  wrapEvent({ kind: 27663, content: '', created_at: at, tags: [['keep', K], ...tags] }, KEEP_SK, to) as unknown as NostrEvent;
const stored = async () => (await loadStoredKeeps('key'))[0];

beforeEach(() => {
  row = null; dbThrows = false; published.length = 0; t = NOW; held = [A, B]; account = [A, B];
  fetchMock.mockReset(); subscribeMock.mockReset();
  fetchMock.mockResolvedValue({ events: [], attempted: 1, reached: 1 });
});

/** Claim as A with the given scope and let the Keep's paired ack in. */
async function pairedKeep(scope: 'all' | 'one') {
  await claimKeep(deps(), link, A, scope);
  published.length = 0;
  await applyAckEvents(deps(), [ack(A, [['status', 'paired'], ['claim']])]);
}

describe('claiming with a scope', () => {
  it('the claim carries the scope and the record keeps it', async () => {
    await claimKeep(deps(), link, A, 'all');
    expect(rumors()[0].tags).toEqual([['keep', K], ['code', CODE], ['scope', 'all']]);
    expect(await stored()).toMatchObject({ scope: 'all', rev: 0, personas: [A] });
  });
});

describe('an All my personas Keep, once paired', () => {
  it('sends update rev 1 listing both personas with games and the games invites; Bob\'s accept only after the update\'s ack', async () => {
    await pairedKeep('all');
    await settle(deps());
    expect(kinds()).toEqual([27664, 27661, 27661]);
    expect(kinds()).not.toContain(27665);
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '1']])]);
    await settle(deps());
    expect(kinds()).toEqual([27665]);
  });

  it('the update, the accept and the invites carry the contract fields', async () => {
    await pairedKeep('all');
    await settle(deps());
    const [update, ...invites] = rumors();
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '1']])]);
    await settle(deps());
    const [accept] = rumors();
    expect(update.pubkey).toBe(A);
    expect(update.tags).toEqual([['keep', K], ['rev', '1'], ['persona', A, 'games'], ['persona', B, 'games']]);
    expect(accept.pubkey).toBe(B);
    expect(accept.tags).toEqual([['keep', K], ['rev', '1']]);
    expect(invites.map(r => tag(r, 'p')![1]).sort()).toEqual([A, B].sort());
    expect(invites.map(r => tag(r, 'name')![1]).sort()).toEqual(['Alice (owner)', 'Bob (owner)']);
    for (const r of invites) {
      expect(r.pubkey).toBe(A);
      expect(Number(tag(r, 'expiration')![1])).toBe(NOW + 365 * DAY - 3600);
    }
  });

  it('sends each thing once, however often it is settled', async () => {
    await pairedKeep('all');
    await settle(deps());
    await Promise.all([settle(deps()), settle(deps())]);
    await catchUp(deps());
    expect(published).toHaveLength(3);
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '1']])]);
    await Promise.all([settle(deps()), settle(deps())]);
    await catchUp(deps());
    expect(published).toHaveLength(4);
  });

  it('Bob becomes active on the Keep\'s updated ack to Bob; the update is done on the ack to Alice', async () => {
    await pairedKeep('all');
    await settle(deps());
    await applyAckEvents(deps(), [ack(B, [['status', 'updated'], ['rev', '1']]), ack(A, [['status', 'updated'], ['rev', '1']])]);
    const k = await stored();
    expect(k.rev).toBe(1);
    expect(k.update).toBeUndefined();
    expect(k.links[B]).toMatchObject({ active: true });
    expect(k.links[B].accept).toBeUndefined();
  });

  it('an accept the Keep held as pending is sent again once the update lands', async () => {
    await pairedKeep('all');
    await settle(deps());
    await applyAckEvents(deps(), [ack(B, [['status', 'pending'], ['rev', '0']])]);
    published.length = 0;
    t += 700;
    await settle(deps());
    expect(kinds()).toContain(27664); // the update goes again; the accept waits for it
    expect(kinds()).not.toContain(27665);
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '1']])]);
    published.length = 0;
    await settle(deps());
    expect(kinds()).toEqual([27665]);
    expect(rumors()[0].pubkey).toBe(B);
  });

  it('refused stale: takes the Keep\'s revision and sends again one higher, with a fresh accept', async () => {
    await pairedKeep('all');
    await settle(deps());
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'refused'], ['reason', 'stale'], ['rev', '5']])]);
    await settle(deps());
    expect(kinds()).toEqual([27664]);
    expect(tag(rumors()[0], 'rev')![1]).toBe('6');
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '6']])]);
    await settle(deps());
    expect(kinds()).toEqual([27665]);
    expect(tag(rumors()[0], 'rev')![1]).toBe('6');
  });

  it('an unanswered update and accept go again after ten minutes', async () => {
    await pairedKeep('all');
    await settle(deps());
    published.length = 0;
    t += 601;
    await settle(deps());
    expect(kinds()).toEqual([27664, 27661, 27661]); // the accept waits for the update's ack
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '1']])]);
    await settle(deps());
    expect(kinds()).toEqual([27665]);
    published.length = 0;
    t += 601;
    await settle(deps());
    expect(kinds()).toEqual([27665, 27661, 27661]); // a lost accept goes again
  });

  it('a persona created later is linked by the next update and accept', async () => {
    await pairedKeep('all');
    await settle(deps());
    await applyAckEvents(deps(), [
      ack(A, [['status', 'updated'], ['rev', '1']]), ack(B, [['status', 'updated'], ['rev', '1']]),
      ack(A, [['status', 'active'], ['grant', (await stored()).invites[0].grant]]),
    ]);
    published.length = 0;
    held = [A, B, C]; account = [A, B, C];
    await catchUp(deps());
    const update = rumors().find(r => r.kind === 27664)!;
    expect(update.tags.filter(x => x[0] === 'persona').map(x => x[1])).toEqual([A, B, C]);
    expect(tag(update, 'rev')![1]).toBe('2');
    expect(kinds()).not.toContain(27665); // Cara's accept follows the update's ack
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '2']])]);
    await settle(deps());
    expect(kinds()).toEqual([27665]);
    expect(rumors()[0].pubkey).toBe(C);
    expect(tag(rumors()[0], 'rev')![1]).toBe('2');
  });
});

describe('an Only this persona Keep', () => {
  it('sends no update by itself, only the owner\'s own games invite', async () => {
    await pairedKeep('one');
    await settle(deps());
    expect(kinds()).toEqual([27661]);
  });

  it('linking Bob by hand sends the update, then Bob\'s accept after the update\'s ack', async () => {
    await pairedKeep('one');
    await settle(deps());
    published.length = 0;
    await changeOwners(deps(), K, A, { kind: 'link', persona: B });
    expect(kinds()).toEqual([27664, 27661]); // the update, and Bob's games invite
    expect(rumors()[0].tags).toEqual([['keep', K], ['rev', '1'], ['persona', A, 'games'], ['persona', B, 'games']]);
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '1']])]);
    await settle(deps());
    expect(kinds()).toEqual([27665]);
    expect(rumors()[0].pubkey).toBe(B);
  });

  it('a persona whose key is not held cannot be linked ("Not available for this persona yet")', async () => {
    await pairedKeep('one');
    await expect(changeOwners(deps(), K, A, { kind: 'link', persona: C })).rejects.toBeInstanceOf(PersonaNotAvailableError);
    expect(published).toHaveLength(0);
    expect((await stored()).personas).toEqual([A]);
  });

  it('a persona that is not an active owner cannot change anything', async () => {
    await pairedKeep('one');
    await expect(changeOwners(deps(), K, B, { kind: 'games', persona: A, on: false })).rejects.toBeInstanceOf(NotAnOwnerError);
  });

  it('the only active owner cannot be unlinked', async () => {
    await pairedKeep('one');
    await expect(changeOwners(deps(), K, A, { kind: 'unlink', persona: A })).rejects.toBeInstanceOf(OwnerChangeRefusedError);
  });
});

describe('switches on a linked Keep', () => {
  async function bothLinked() {
    await pairedKeep('all');
    await settle(deps());
    const k = await stored();
    await applyAckEvents(deps(), [
      ack(A, [['status', 'updated'], ['rev', '1']]), ack(B, [['status', 'updated'], ['rev', '1']]),
      ...k.invites.map(i => ack(A, [['status', 'active'], ['grant', i.grant]])),
    ]);
    published.length = 0;
  }

  it('Games off for Bob: the update lists Bob without games, and his games invite is revoked', async () => {
    await bothLinked();
    await changeOwners(deps(), K, A, { kind: 'games', persona: B, on: false });
    expect(kinds()).toEqual([27664, 27662]);
    expect(rumors()[0].tags).toEqual([['keep', K], ['rev', '2'], ['persona', A, 'games'], ['persona', B]]);
    const bobInvite = (await stored()).invites.find(i => i.gamesFor === B)!;
    expect(rumors()[1].tags).toEqual([['keep', K], ['grant', bobInvite.grant]]);
    expect(bobInvite.revokeSent).toBe(true);
  });

  it('Games back on makes a new invite for Bob', async () => {
    await bothLinked();
    await changeOwners(deps(), K, A, { kind: 'games', persona: B, on: false });
    published.length = 0;
    await changeOwners(deps(), K, A, { kind: 'games', persona: B, on: true });
    expect(kinds()).toEqual([27664, 27661]);
    expect(tag(rumors()[1], 'p')![1]).toBe(B);
  });

  it('unlinking Bob: an update without him, and his games invite revoked, signed by Alice', async () => {
    await bothLinked();
    await changeOwners(deps(), K, A, { kind: 'unlink', persona: B });
    expect(kinds()).toEqual([27664, 27662]);
    expect(rumors()[0].tags).toEqual([['keep', K], ['rev', '2'], ['persona', A, 'games']]);
    expect(rumors()[1].pubkey).toBe(A);
    expect((await stored()).personas).toEqual([A]);
  });

  it('an unlinked persona is not linked again when the app next runs', async () => {
    await bothLinked();
    await changeOwners(deps(), K, A, { kind: 'unlink', persona: B });
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'updated'], ['rev', '2']])]);
    await catchUp(deps());
    expect(kinds()).not.toContain(27664);
  });

  it('Bob (active) can unlink Alice and keeps the Keep, signing as himself', async () => {
    await bothLinked();
    await changeOwners(deps(), K, B, { kind: 'unlink', persona: A });
    expect(rumors()[0].pubkey).toBe(B);
    expect(rumors()[0].tags).toEqual([['keep', K], ['rev', '2'], ['persona', B, 'games']]);
    const revoke = rumors().find(r => r.kind === 27662)!;
    expect(revoke.pubkey).toBe(B); // the remaining active owner signs the revoke of Alice's games invite
  });

  it('a retry after the Keep gave the update up makes it again at a newer revision', async () => {
    await bothLinked();
    await changeOwners(deps(), K, A, { kind: 'games', persona: B, on: false });
    await applyAckEvents(deps(), [ack(A, [['status', 'refused'], ['reason', 'malformed']])]);
    expect((await stored()).update?.failed).toBe('malformed');
    published.length = 0;
    await changeOwners(deps(), K, A, { kind: 'retry' });
    expect(kinds()).toEqual([27664]);
    expect(tag(rumors()[0], 'rev')![1]).toBe('3');
  });
});

describe('renewing a games invite', () => {
  it('a new grant goes first; the old one is revoked after the new one is acked active', async () => {
    await pairedKeep('one');
    await settle(deps());
    const first = (await stored()).invites[0];
    await applyAckEvents(deps(), [ack(A, [['status', 'active'], ['grant', first.grant]])]);
    published.length = 0;
    t = NOW + (365 - 29) * DAY;
    await catchUp(deps());
    expect(kinds()).toEqual([27661]);
    const fresh = (await stored()).invites.find(i => i.grant !== first.grant)!;
    expect(tag(rumors()[0], 'grant')![1]).toBe(fresh.grant);
    published.length = 0;
    await applyAckEvents(deps(), [ack(A, [['status', 'active'], ['grant', fresh.grant]], t + 1)]);
    await settle(deps());
    expect(kinds()).toEqual([27662]);
    expect(tag(rumors()[0], 'grant')![1]).toBe(first.grant);
  });
});

describe('reading acks addressed to every owner persona', () => {
  it('asks for wraps to each linked persona, not only the claimer', async () => {
    await pairedKeep('all');
    await settle(deps());
    fetchMock.mockClear();
    await catchUp(deps());
    const asked = fetchMock.mock.calls.map(c => (c[0] as Array<{ '#p': string[] }>)[0]['#p'][0]).sort();
    expect(asked).toEqual([A, B].sort());
  });

  it('listens live for each, and sends what an ack makes due', async () => {
    await pairedKeep('all');
    const handlers: Array<(e: NostrEvent) => void> = [];
    subscribeMock.mockImplementation((_f: unknown, _r: unknown, on: (e: NostrEvent) => void) => { handlers.push(on); return () => undefined; });
    const k = await stored();
    const onChange = vi.fn();
    const stop = watchAcks(deps(), [k], onChange);
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    // After `paired`, the update is already due; the live path sends it without waiting for the next opening.
    const e = ack(A, [['status', 'refused'], ['reason', 'stale'], ['rev', '3']]);
    await settle(deps());
    published.length = 0;
    for (const h of handlers) h(e);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    stop();
    expect(kinds()).toContain(27664);
  });
});

describe('an unreadable list is never written over', () => {
  it('a change of the owner list fails and writes nothing', async () => {
    await pairedKeep('one');
    const before = JSON.stringify(row);
    dbThrows = true;
    await expect(changeOwners(deps(), K, A, { kind: 'link', persona: B })).rejects.toBeInstanceOf(KeepsUnreadableError);
    expect(JSON.stringify(row)).toBe(before);
    expect(published).toHaveLength(0);
  });

  it('a K1d record that reads fine is migrated and saved in the K1e shape the first time it is written', async () => {
    const k1d = {
      keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: A, personas: [A], status: 'paired', claimedAt: 1, invites: [],
    };
    row = [k1d];
    await settle(deps());
    const [k] = row as StoredKeep[];
    expect(k).toMatchObject({ scope: 'one', rev: 0, personas: [A], seen: [A] });
    expect(k.links[A]).toEqual({ sections: ['games'], addedRev: 0, active: true });
    expect(k.invites).toHaveLength(1);
  });
});

describe('one ack cursor for each owner persona of a Keep', () => {
  const both = (extra: object = {}) => [{
    keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: A, personas: [A, B], scope: 'all', rev: 1, seen: [A, B], status: 'paired',
    claimedAt: 1, invites: [],
    links: { [A]: { sections: [], addedRev: 0, active: true }, [B]: { sections: [], addedRev: 1, active: true } }, ...extra,
  }];
  const sinceFor = (persona: string) => {
    const call = fetchMock.mock.calls.find(c => (c[0] as Array<{ '#p': string[] }>)[0]['#p'][0] === persona)!;
    return (call[0] as Array<{ since: number }>)[0].since;
  };

  it('an ack to one persona moves only that persona\'s cursor, and each is read from its own cursor', async () => {
    row = both();
    const toA = ack(A, [['status', 'updated'], ['rev', '1']], NOW - 100);
    const toB = ack(B, [['status', 'updated'], ['rev', '1']], NOW - 100);
    await applyAckEvents(deps(), [toA]);
    const [afterA] = await loadStoredKeeps('key');
    expect(afterA.ackCursors).toEqual({ [A]: Math.min(toA.created_at, NOW) });
    await applyAckEvents(deps(), [toB]);
    const [both2] = await loadStoredKeeps('key');
    expect(both2.ackCursors).toEqual({ [A]: Math.min(toA.created_at, NOW), [B]: Math.min(toB.created_at, NOW) });
    // A's cursor moves on later; B's stays where it was.
    const later = ack(A, [['status', 'updated'], ['rev', '2']], NOW - 10);
    await applyAckEvents(deps(), [later]);
    const [moved] = await loadStoredKeeps('key');
    expect(moved.ackCursors![B]).toBe(Math.min(toB.created_at, NOW));
    expect(moved.ackCursors![A]).toBe(Math.min(Math.max(toA.created_at, later.created_at), NOW)); // only forward
    fetchMock.mockClear();
    await refreshAcks(deps());
    expect(sinceFor(A)).toBe(moved.ackCursors![A] - 2 * DAY);
    expect(sinceFor(B)).toBe(moved.ackCursors![B] - 2 * DAY);
  });

  it('a persona with no cursor yet reads three days back, whatever the other persona has', async () => {
    row = both({ ackCursors: { [A]: NOW - 100 } });
    await refreshAcks(deps());
    expect(sinceFor(A)).toBe(NOW - 100 - 2 * DAY);
    expect(sinceFor(B)).toBe(NOW - 3 * DAY);
  });

  it('the one cursor of a record made before this is copied to each persona that is read', async () => {
    row = both({ ackCursor: NOW - 5000 });
    await refreshAcks(deps());
    expect(sinceFor(A)).toBe(NOW - 5000 - 2 * DAY);
    expect(sinceFor(B)).toBe(NOW - 5000 - 2 * DAY);
    const k = (await loadStoredKeeps('key'))[0] as StoredKeep & { ackCursor?: number };
    expect(k.ackCursor).toBeUndefined();
    expect(k.ackCursors).toEqual({ [A]: NOW - 5000, [B]: NOW - 5000 });
  });
});

describe('adding a Keep again with a new pairing link', () => {
  const link2 = parseKeepPairLink(`signet-keep:pair?k=${K}&c=${'44'.repeat(16)}&n=Home&r=wss://a.example`)!;
  const owned = () => [{
    keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: A, personas: [A, B], scope: 'one', rev: 3, seen: [A, B], status: 'paired',
    claimedAt: 1, invites: [],
    links: { [A]: { sections: [], addedRev: 0, active: true }, [B]: { sections: [], addedRev: 3, active: true } },
  }];

  it('keeps the owner list and the choice of who can use it, and sends the list again at the next revision once paired', async () => {
    row = owned();
    await claimKeep(deps(), link2, A, 'one');
    published.length = 0;
    const [pending] = await loadStoredKeeps('key');
    expect(pending).toMatchObject({ status: 'pending', scope: 'one', rev: 3, personas: [A, B], seen: [A, B] });
    expect(pending.links[B]).toMatchObject({ active: false, accept: { rev: 4 } });
    expect(pending.update).toMatchObject({ rev: 4, signer: A });
    await applyAckEvents(deps(), [ack(A, [['status', 'paired'], ['claim']], NOW + 5)]);
    await settle(deps());
    const update = rumors().find(r => r.kind === 27664)!;
    expect(update.tags).toEqual([['keep', K], ['rev', '4'], ['persona', A], ['persona', B]]);
    expect(kinds()).not.toContain(27665); // Bob's accept waits for the update's ack
  });

  it('a Keep whose list was not reset takes it over; a repeated update is no harm, and an old ack of the first pairing is not believed', async () => {
    row = owned();
    await claimKeep(deps(), link2, A, 'one');
    await applyAckEvents(deps(), [ack(A, [['status', 'paired'], ['claim']], NOW + 5)]);
    await applyAckEvents(deps(), [ack(B, [['status', 'updated'], ['rev', '3']], NOW - 3600)]); // from before the claim
    expect((await loadStoredKeeps('key'))[0].links[B].active).toBe(false);
    await applyAckEvents(deps(), [ack(B, [['status', 'updated'], ['rev', '4']], NOW + 10)]);
    expect((await loadStoredKeeps('key'))[0].links[B].active).toBe(true);
  });
});

describe('the last revision', () => {
  it('a change at the last storable revision is refused with a plain message and nothing is written', async () => {
    await pairedKeep('one');
    await updateStoredKeeps('key', l => l.map(k => ({ ...k, rev: Number.MAX_SAFE_INTEGER })));
    const before = JSON.stringify(row);
    published.length = 0;
    await expect(changeOwners(deps(), K, A, { kind: 'link', persona: B })).rejects.toThrow(/revisions/);
    expect(JSON.stringify(row)).toBe(before);
    expect(published).toHaveLength(0);
    expect(await loadStoredKeeps('key')).toHaveLength(1); // still readable
  });
});
