import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

let row: unknown = null;
vi.mock('./db', () => ({
  loadKeepsRow: async () => (row === null ? null : JSON.parse(JSON.stringify(row))),
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
  NotAnOwnerError, OwnerChangeRefusedError, PersonaNotAvailableError, applyAckEvents, catchUp, loadStoredKeeps, openKeep, refreshAcks,
  revokePass, setReturnPasses, settle, watchAcks, type KeepDeps,
} from './keep-service';
import { returnPassesLabel, type StoredKeep } from './keep-store';

const KEEP_SK = hexToBytes('0'.repeat(63) + '1');
const K = getPublicKey(KEEP_SK);
const SK_A = '0'.repeat(63) + '2';
const SK_B = '0'.repeat(63) + '3';
const A = getPublicKey(hexToBytes(SK_A));
const B = getPublicKey(hexToBytes(SK_B));
const PLAYER = getPublicKey(hexToBytes('0'.repeat(63) + '4'));
const SKS: Record<string, string> = { [A]: SK_A, [B]: SK_B };
const NOW = 1_800_000_000;
const DAY = 86400;
const G = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

const published: Array<{ wrap: NostrEvent; relays: readonly string[] }> = [];
let t = NOW;
let held = [A, B];
const deps = (over: Partial<KeepDeps> = {}): KeepDeps => ({
  encryptionKey: 'key',
  backendFor: p => (held.includes(p) ? new LocalSigningBackend(SKS[p]) : null),
  eligiblePersonas: () => [],
  personaName: p => p.slice(0, 4),
  publish: async (wrap, relays) => { published.push({ wrap, relays }); return relays.map(() => true); },
  now: () => t,
  ...over,
});
const rumors = () => published.map(p => unwrapEvent(p.wrap as never, KEEP_SK));
const kinds = () => rumors().map(r => r.kind);

const record = (over: Record<string, unknown> = {}) => ({
  keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: A, personas: [A, B], scope: 'all', rev: 1, seen: [A, B],
  links: {
    [A]: { sections: [], addedRev: 0, active: true },
    [B]: { sections: [], addedRev: 1, active: true },
  },
  status: 'paired', claimedAt: NOW - 10 * DAY, invites: [], ...over,
});

const keepRumor = (kind: number, tags: string[][], to: string, at: number) =>
  wrapEvent({ kind, content: '', created_at: at, tags: [['keep', K], ...tags] }, KEEP_SK, to) as unknown as NostrEvent;
const reportWrap = (o: { grant?: string; state?: string; at?: number; seen?: number; to?: string; extra?: string[][] } = {}) => keepRumor(27667, [
  ['grant', o.grant ?? G], ['p', PLAYER], ['state', o.state ?? 'active'], ['expiration', String(NOW + 30 * DAY)],
  ['seen', String(o.seen ?? NOW)], ['via', 'code'], ['name', 'Dave'], ...(o.extra ?? []),
], o.to ?? A, o.at ?? NOW + 1);
const settingsUpdated = (setrev: number, at: number, to = A) =>
  keepRumor(27663, [['status', 'updated'], ['setting', 'return_passes'], ['setrev', String(setrev)]], to, at);
const settingsStale = (setrev: number, at: number, to = A) =>
  keepRumor(27663, [['status', 'refused'], ['reason', 'stale'], ['setrev', String(setrev)]], to, at);
const revokedAck = (grant: string, at: number, to = A) => keepRumor(27663, [['status', 'revoked'], ['grant', grant]], to, at);
const stored = async (): Promise<StoredKeep> => (await loadStoredKeeps('key'))[0];

beforeEach(() => {
  row = [record()]; published.length = 0; t = NOW; held = [A, B];
  fetchMock.mockReset(); subscribeMock.mockReset();
  fetchMock.mockResolvedValue({ events: [], attempted: 1, reached: 1 });
});

describe('receiving pass reports', () => {
  it('stores a pass, with no secret, and moves the persona\'s cursor to the report wrap time', async () => {
    const wrap = reportWrap({ at: NOW - 3600 });
    const list = await applyAckEvents(deps(), [wrap]);
    expect(list[0].passes).toEqual([expect.objectContaining({ grant: G, persona: PLAYER, name: 'Dave', state: 'active', via: 'code', seenAt: NOW, reportAt: NOW - 3600 })]);
    expect(JSON.stringify(row)).not.toMatch(/secret/);
    expect(list[0].ackCursors?.[A]).toBe(wrap.created_at);
  });

  it('a report addressed to the other owner persona moves that persona\'s cursor, not the first one\'s', async () => {
    const wrap = reportWrap({ to: B, at: NOW - 100 });
    const list = await applyAckEvents(deps(), [wrap]);
    expect(list[0].ackCursors).toEqual({ [B]: wrap.created_at });
    expect(list[0].passes).toHaveLength(1);
  });

  it('the cursor never passes now, and the next read starts 2 days before it', async () => {
    // wrapEvent dates the wrap from the real clock, so put the app\'s clock well behind it: the wrap is in the future.
    t = Math.floor(Date.now() / 1000) - 10 * DAY;
    const list = await applyAckEvents(deps(), [reportWrap()]);
    expect(list[0].ackCursors?.[A]).toBe(t);
    await refreshAcks(deps());
    const filters = fetchMock.mock.calls.map(c => (c[0] as Array<{ since: number; '#p': string[] }>)[0]);
    expect(filters.find(f => f['#p'][0] === A)?.since).toBe(t - 2 * DAY);
  });

  it('a report from a seal that is not the Keep, a report with a secret, and a report for another Keep change nothing and do not move the cursor', async () => {
    const junk = [
      wrapEvent({ kind: 27667, content: '', created_at: NOW, tags: [['keep', K], ['grant', G], ['p', PLAYER], ['state', 'active'], ['expiration', String(NOW + DAY)], ['seen', String(NOW)]] }, hexToBytes('0'.repeat(63) + '9'), A) as unknown as NostrEvent,
      reportWrap({ extra: [['secret', '22'.repeat(32)]] }),
      wrapEvent({ kind: 27667, content: '', created_at: NOW, tags: [['keep', 'ab'.repeat(32)], ['grant', G], ['p', PLAYER], ['state', 'active'], ['expiration', '1'], ['seen', '1']] }, KEEP_SK, A) as unknown as NostrEvent,
    ];
    const before = await stored();
    const list = await applyAckEvents(deps(), junk);
    expect(list[0].passes).toBeUndefined();
    expect(list[0].ackCursors).toEqual(before.ackCursors);
  });

  it('reports and acks in one batch are all applied, in any order, and the newest report wins', async () => {
    const list = await applyAckEvents(deps(), [
      reportWrap({ at: NOW + 20, seen: NOW + 20 }),
      reportWrap({ at: NOW + 10, seen: NOW + 10 }),
      reportWrap({ grant: '77'.repeat(16), at: NOW + 5 }),
    ]);
    expect(list[0].passes).toHaveLength(2);
    expect(list[0].passes?.find(p => p.grant === G)?.seenAt).toBe(NOW + 20);
  });

  it('a revoked report is final even when an active one comes after', async () => {
    await applyAckEvents(deps(), [reportWrap({ state: 'revoked', at: NOW + 5 })]);
    const list = await applyAckEvents(deps(), [reportWrap({ state: 'active', at: NOW + 50 })]);
    expect(list[0].passes?.[0].state).toBe('revoked');
  });

  it('is read by refreshAcks from the pairing relays like an ack, and by the live watch', async () => {
    fetchMock.mockResolvedValue({ events: [reportWrap()], attempted: 1, reached: 1 });
    const list = await refreshAcks(deps());
    expect(list[0].passes).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1]).toEqual({ relays: ['wss://a.example'] });
    let onEvent: ((e: NostrEvent) => void) | undefined;
    subscribeMock.mockImplementation((_f: unknown, _r: unknown, cb: (e: NostrEvent) => void) => { onEvent = cb; return () => undefined; });
    row = [record()];
    const changed = vi.fn();
    watchAcks(deps(), [record() as unknown as StoredKeep], changed);
    onEvent!(reportWrap({ grant: '88'.repeat(16) }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(changed.mock.calls[0][0][0].passes.some((p: { grant: string }) => p.grant === '88'.repeat(16))).toBe(true);
  });
});

describe('the Return passes switch', () => {
  it('sends 27666 with the next setrev, saved as waiting', async () => {
    const list = await setReturnPasses(deps(), K, A, false);
    expect(kinds()).toEqual([27666]);
    expect(rumors()[0].pubkey).toBe(A);
    expect(rumors()[0].tags).toEqual([['keep', K], ['setrev', '1'], ['return_passes', 'off']]);
    expect(published[0].relays).toEqual(['wss://a.example']);
    expect(list[0].settings).toEqual({ returnPasses: false, setrev: 1, composedAt: NOW, sentAt: NOW, confirmed: false });
    expect(returnPassesLabel(list[0], NOW)).toBe('Waiting for the Keep');
  });

  it('the updated ack confirms it; the next change is setrev 2', async () => {
    await setReturnPasses(deps(), K, A, false);
    t = NOW + 30;
    let list = await applyAckEvents(deps(), [settingsUpdated(1, NOW + 20)]);
    expect(list[0].settings?.confirmed).toBe(true);
    expect(returnPassesLabel(list[0], t)).toBeUndefined();
    published.length = 0;
    list = await setReturnPasses(deps(), K, A, true);
    expect(rumors()[0].tags).toEqual([['keep', K], ['setrev', '2'], ['return_passes', 'on']]);
    expect(list[0].settings).toMatchObject({ setrev: 2, returnPasses: true, confirmed: false });
  });

  it('setting it to what it already is sends nothing', async () => {
    await setReturnPasses(deps(), K, A, true);
    expect(published).toHaveLength(0);
    expect((await stored()).settings).toBeUndefined();
  });

  it('is sent again after 10 minutes without an ack, not before, and says the Keep can\'t do this yet', async () => {
    await setReturnPasses(deps(), K, A, false);
    t = NOW + 500;
    await catchUp(deps());
    expect(kinds()).toEqual([27666]);
    t = NOW + 601;
    const list = await catchUp(deps());
    expect(kinds()).toEqual([27666, 27666]);
    expect(rumors()[1].tags).toEqual(rumors()[0].tags);
    expect(returnPassesLabel(list[0], t)).toBe('This Keep can’t do this yet');
    // a late ack still turns it into a confirmed setting
    const done = await applyAckEvents(deps(), [settingsUpdated(1, NOW + 650)]);
    expect(returnPassesLabel(done[0], t)).toBeUndefined();
  });

  it('a stale refusal makes the change again one above the Keep\'s number and sends it at once; a second refusal gives up', async () => {
    await setReturnPasses(deps(), K, A, false);
    t = NOW + 10;
    let list = await applyAckEvents(deps(), [settingsStale(4, NOW + 5)]);
    expect(list[0].settings).toMatchObject({ setrev: 5, retried: true });
    await settle(deps());
    expect(kinds()).toEqual([27666, 27666]);
    expect(rumors()[1].tags).toEqual([['keep', K], ['setrev', '5'], ['return_passes', 'off']]);
    t = NOW + 20;
    list = await applyAckEvents(deps(), [settingsStale(7, NOW + 15)]);
    expect(list[0].settings?.failed).toBe('stale');
    await settle(deps());
    expect(kinds()).toHaveLength(2);
    // switching again starts again above the Keep's number
    list = await setReturnPasses(deps(), K, A, true);
    expect(list[0].settings).toMatchObject({ setrev: 6, returnPasses: true });
  });

  it('a stale refusal from a later settle is sent by a watch too (the ack makes it due)', async () => {
    await setReturnPasses(deps(), K, A, false);
    t = NOW + 10;
    let onEvent: ((e: NostrEvent) => void) | undefined;
    subscribeMock.mockImplementation((_f: unknown, _r: unknown, cb: (e: NostrEvent) => void) => { onEvent = cb; return () => undefined; });
    const changed = vi.fn();
    watchAcks(deps(), [await stored()], changed);
    onEvent!(settingsStale(1, NOW + 5));
    await vi.waitFor(() => expect(kinds()).toEqual([27666, 27666]));
    expect(rumors()[1].tags).toContainEqual(['setrev', '2']);
  });

  it('is signed by an owner persona the Keep counts as active, and only with its key here', async () => {
    held = [B];
    await setReturnPasses(deps(), K, B, false);
    expect(rumors()[0].pubkey).toBe(B);
    await expect(setReturnPasses(deps(), K, A, true)).rejects.toBeInstanceOf(PersonaNotAvailableError);
  });

  it('is refused for a persona that is not an active owner and for a Keep not yet paired', async () => {
    row = [record({ personas: [A], links: { [A]: { sections: [], addedRev: 0, active: true }, [B]: { sections: [], addedRev: 1, active: false } } })];
    await expect(setReturnPasses(deps(), K, B, false)).rejects.toBeInstanceOf(NotAnOwnerError);
    row = [record({ status: 'pending', code: '33'.repeat(16) })];
    await expect(setReturnPasses(deps(), K, A, false)).rejects.toBeInstanceOf(OwnerChangeRefusedError);
    expect(published).toHaveLength(0);
  });
});

describe('revoking a pass', () => {
  const withPass = async () => { await applyAckEvents(deps(), [reportWrap({ at: NOW })]); published.length = 0; };

  it('sends the existing 27662 with the pass grant, marks it as revoking', async () => {
    await withPass();
    t = NOW + 5;
    expect(await revokePass(deps(), K, G, A)).toBe(true);
    expect(kinds()).toEqual([27662]);
    expect(rumors()[0].tags).toEqual([['keep', K], ['grant', G]]);
    expect(rumors()[0].pubkey).toBe(A);
    expect((await stored()).passes?.[0]).toMatchObject({ revokeSent: true, revokeSentAt: NOW + 5, state: 'active' });
  });

  it('is sent again after 10 minutes without an answer, and not again once the Keep acks revoked', async () => {
    await withPass();
    await revokePass(deps(), K, G, A);
    t = NOW + 500;
    await catchUp(deps());
    expect(kinds()).toEqual([27662]);
    t = NOW + 601;
    await catchUp(deps());
    expect(kinds()).toEqual([27662, 27662]);
    expect(rumors()[1].tags).toEqual([['keep', K], ['grant', G]]);
    const list = await applyAckEvents(deps(), [revokedAck(G, NOW + 610)]);
    expect(list[0].passes?.[0]).toMatchObject({ state: 'revoked', revokeSent: false });
    t = NOW + 5000;
    await catchUp(deps());
    expect(kinds()).toEqual([27662, 27662]);
  });

  it('a revoked report from the Keep ends the waiting too', async () => {
    await withPass();
    await revokePass(deps(), K, G, A);
    const list = await applyAckEvents(deps(), [reportWrap({ state: 'revoked', at: NOW + 20 })]);
    expect(list[0].passes?.[0].state).toBe('revoked');
    t = NOW + 5000;
    await catchUp(deps());
    expect(kinds()).toEqual([27662]);
  });

  it('does nothing for a grant that is not a stored pass, and refuses a persona that cannot sign', async () => {
    await withPass();
    expect(await revokePass(deps(), K, '99'.repeat(16), A)).toBe(false);
    held = [];
    await expect(revokePass(deps(), K, G, A)).rejects.toBeInstanceOf(PersonaNotAvailableError);
  });
});

describe('asking the Keep for its passes (27668)', () => {
  it('opening a Keep asks once; opening it again within 10 minutes does not; after 10 minutes it asks again', async () => {
    await openKeep(deps(), K);
    expect(kinds()).toEqual([27668]);
    expect(rumors()[0].tags).toEqual([['keep', K]]);
    expect(rumors()[0].pubkey).toBe(A);
    t = NOW + 300;
    await openKeep(deps(), K);
    expect(kinds()).toEqual([27668]);
    t = NOW + 601;
    await openKeep(deps(), K);
    expect(kinds()).toEqual([27668, 27668]);
  });

  it('a plain catch-up does not ask a Keep nobody has opened, or one that reported recently', async () => {
    await catchUp(deps());
    expect(published).toHaveLength(0);
    await applyAckEvents(deps(), [reportWrap({ at: NOW - 6 * DAY })]);
    await catchUp(deps());
    expect(published).toHaveLength(0);
  });

  it('a catch-up asks when the last report is over 7 days old, and then not again for 7 days', async () => {
    await applyAckEvents(deps(), [reportWrap({ at: NOW - 8 * DAY })]);
    await catchUp(deps());
    expect(kinds()).toEqual([27668]);
    t = NOW + DAY;
    await catchUp(deps());
    expect(kinds()).toEqual([27668]);
    t = NOW + 8 * DAY;
    await catchUp(deps());
    expect(kinds()).toEqual([27668, 27668]);
  });

  it('the reports it brings back are applied (the round trip)', async () => {
    await openKeep(deps(), K);
    const list = await applyAckEvents(deps(), [reportWrap({ at: NOW + 3 }), reportWrap({ grant: '55'.repeat(16), at: NOW + 3 })]);
    expect(list[0].passes).toHaveLength(2);
  });

  it('asks nothing of a Keep that has not paired, or when no owner persona\'s key is here', async () => {
    row = [record({ status: 'pending', code: '33'.repeat(16) })];
    await openKeep(deps(), K);
    expect(published).toHaveLength(0);
    row = [record()];
    held = [];
    await openKeep(deps(), K);
    expect(published).toHaveLength(0);
  });
});
