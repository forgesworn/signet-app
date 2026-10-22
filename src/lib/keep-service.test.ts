import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

// The stored row, held in memory (the real row is covered in db.test.ts).
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
  applyAckEvents, claimKeep, createInvite, forgetKeep, keepShareLink, loadStoredKeeps, refreshAcks,
  resendClaim, revokeInvite, updateStoredKeeps, watchAcks, PersonaNotAvailableError, type KeepDeps,
} from './keep-service';
import { parseKeepPairLink } from './keep-link';
import { KeepsUnreadableError } from './keep-store';

const KEEP_SK = hexToBytes('0'.repeat(63) + '1');
const K = getPublicKey(KEEP_SK);
const OWNER_HEX = '0'.repeat(63) + '2';
const OWNER_SK = hexToBytes(OWNER_HEX);
const O = getPublicKey(OWNER_SK);
const NOW = 1_800_000_000;
const CODE = '33'.repeat(16);
const link = parseKeepPairLink(`signet-keep:pair?k=${K}&c=${CODE}&n=Home&r=wss://a.example&r=wss://b.example`)!;

const published: Array<{ wrap: NostrEvent; relays: readonly string[] }> = [];
let publishOk = true;
const deps = (over: Partial<KeepDeps> = {}): KeepDeps => ({
  encryptionKey: 'key',
  backendFor: p => (p === O ? new LocalSigningBackend(OWNER_HEX) : null),
  publish: async (wrap, relays) => { published.push({ wrap, relays }); return relays.map(() => publishOk); },
  now: () => NOW,
  ...over,
});
const lastRumor = () => unwrapEvent(published[published.length - 1].wrap as never, KEEP_SK);
const ackFromKeep = (tags: string[][]) =>
  wrapEvent({ kind: 27663, content: '', created_at: NOW + 1, tags: [['keep', K], ...tags] }, KEEP_SK, O) as unknown as NostrEvent;

beforeEach(() => { row = null; dbThrows = false; published.length = 0; publishOk = true; fetchMock.mockReset(); subscribeMock.mockReset(); });

describe('claiming', () => {
  it('saves a pending Keep (owner = the persona, personas = [owner]) and sends the claim to its relays', async () => {
    const result = await claimKeep(deps(), link, O);
    expect(result).toMatchObject({ kind: 'claimed', sent: true });
    const [stored] = await loadStoredKeeps('key');
    expect(stored).toMatchObject({ keep: K, name: 'Home', relays: ['wss://a.example', 'wss://b.example'], claimedBy: O, personas: [O], status: 'pending', code: CODE });
    expect(published).toHaveLength(1);
    expect(published[0].relays).toEqual(['wss://a.example', 'wss://b.example']);
    const rumor = lastRumor();
    expect(rumor).toMatchObject({ kind: 27660, pubkey: O });
    expect(rumor.tags).toEqual([['keep', K], ['code', CODE]]);
  });

  it('keeps the Keep when no relay took the claim, so it can be sent again', async () => {
    publishOk = false;
    expect(await claimKeep(deps(), link, O)).toMatchObject({ kind: 'claimed', sent: false });
    expect(await loadStoredKeeps('key')).toHaveLength(1);
    publishOk = true;
    const [keep] = await loadStoredKeeps('key');
    expect(await resendClaim(deps(), keep)).toBe(true);
    expect(lastRumor().kind).toBe(27660);
  });

  it('refuses a persona whose key this device does not hold, and sends nothing', async () => {
    await expect(claimKeep(deps(), link, 'ee'.repeat(32))).rejects.toBeInstanceOf(PersonaNotAvailableError);
    expect(published).toHaveLength(0);
    expect(await loadStoredKeeps('key')).toEqual([]);
  });

  it('does not claim the same Keep twice', async () => {
    await claimKeep(deps(), link, O);
    expect(await claimKeep(deps(), link, O)).toMatchObject({ kind: 'exists' });
    expect(published).toHaveLength(1);
  });

  describe('adding a Keep that is already stored, with a new pairing link', () => {
    const CODE2 = '44'.repeat(16);
    const link2 = parseKeepPairLink(`signet-keep:pair?k=${K}&c=${CODE2}&n=Home%20Two&r=wss://c.example`)!;
    const invite = { grant: '11'.repeat(16), secret: '22'.repeat(32), kind: 'guest', createdAt: 1, expiration: NOW + 99, status: 'active', ackAt: 5 };
    const stored = (over: object = {}) => ({
      keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: O, personas: [O], status: 'pending', code: CODE, claimedAt: 1, invites: [invite], ...over,
    });

    it('re-pairs a pending Keep: new code, relays and name, same invites, a new claim sent', async () => {
      row = [stored()];
      const result = await claimKeep(deps(), link2, O);
      expect(result).toMatchObject({ kind: 'claimed', sent: true, repaired: true });
      const [keep] = await loadStoredKeeps('key');
      expect(keep).toMatchObject({ status: 'pending', code: CODE2, name: 'Home Two', relays: ['wss://c.example'], claimedAt: NOW });
      expect(keep.invites).toEqual([invite]);
      expect(published).toHaveLength(1);
      expect(published[0].relays).toEqual(['wss://c.example']);
      expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE2]]);
    });

    it('re-pairs a paired Keep that was reset: back to waiting, invites kept', async () => {
      row = [stored({ status: 'paired', code: undefined })];
      expect(await claimKeep(deps(), link2, O)).toMatchObject({ kind: 'claimed', repaired: true });
      const [keep] = await loadStoredKeeps('key');
      expect(keep).toMatchObject({ status: 'pending', code: CODE2 });
      expect(keep.invites).toHaveLength(1);
      expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE2]]);
      // ... and the new paired ack finishes it.
      await applyAckEvents(deps(), [ackFromKeep([['status', 'paired'], ['claim']])]);
      expect((await loadStoredKeeps('key'))[0]).toMatchObject({ status: 'paired' });
    });

    it('keeps the new record when the new claim could not be sent, so Send again works', async () => {
      row = [stored()];
      publishOk = false;
      expect(await claimKeep(deps(), link2, O)).toMatchObject({ kind: 'claimed', sent: false, repaired: true });
      publishOk = true;
      const [keep] = await loadStoredKeeps('key');
      expect(await resendClaim(deps(), keep)).toBe(true);
      expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE2]]);
    });

    it('the same code again is still "already added" and sends nothing', async () => {
      row = [stored()];
      expect(await claimKeep(deps(), link, O)).toMatchObject({ kind: 'exists' });
      expect(published).toHaveLength(0);
    });

    it('does not move a Keep to another owner persona', async () => {
      const other = '0'.repeat(63) + '3';
      row = [stored()];
      const result = await claimKeep(deps({ backendFor: p => (p === getPublicKey(hexToBytes(other)) ? new LocalSigningBackend(other) : null) }), link2, getPublicKey(hexToBytes(other)));
      expect(result).toMatchObject({ kind: 'other-owner' });
      expect((await loadStoredKeeps('key'))[0]).toMatchObject({ code: CODE, claimedBy: O });
      expect(published).toHaveLength(0);
    });

    it('an old paired ack from before the reset does not pair the new claim', async () => {
      row = [stored({ status: 'paired', code: undefined })];
      await claimKeep(deps(), link2, O);
      const stale = wrapEvent({ kind: 27663, content: '', created_at: NOW - 86400, tags: [['keep', K], ['status', 'paired'], ['claim']] }, KEEP_SK, O) as unknown as NostrEvent;
      await applyAckEvents(deps(), [stale]);
      expect((await loadStoredKeeps('key'))[0].status).toBe('pending');
    });
  });

  it('the paired ack from the Keep makes it paired and forgets the code', async () => {
    await claimKeep(deps(), link, O);
    await applyAckEvents(deps(), [ackFromKeep([['status', 'paired'], ['claim']])]);
    const [keep] = await loadStoredKeeps('key');
    expect(keep.status).toBe('paired');
    expect(keep.code).toBeUndefined();
  });
});

describe('inviting and revoking', () => {
  beforeEach(async () => {
    await claimKeep(deps(), link, O);
    await applyAckEvents(deps(), [ackFromKeep([['status', 'paired'], ['claim']])]);
    published.length = 0;
  });

  it('a personal invite: CSPRNG grant and secret, 30 days, saved as waiting, sent', async () => {
    const friend = 'ee'.repeat(32);
    const { invite, sent } = await createInvite(deps(), K, { kind: 'personal', persona: friend, label: 'Dave' });
    expect(sent).toBe(true);
    expect(invite.grant).toMatch(/^[0-9a-f]{32}$/);
    expect(invite.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.expiration).toBe(NOW + 30 * 86400);
    expect(invite.status).toBe('waiting');
    const rumor = lastRumor();
    expect(rumor.kind).toBe(27661);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.tags).toEqual([
      ['keep', K], ['grant', invite.grant], ['secret', invite.secret], ['expiration', String(NOW + 30 * 86400)], ['p', friend], ['name', 'Dave'],
    ]);
    expect((await loadStoredKeeps('key'))[0].invites).toHaveLength(1);
  });

  it('a guest pass lasts 24 hours and carries ["guest"]', async () => {
    const { invite } = await createInvite(deps(), K, { kind: 'guest' });
    expect(invite.expiration).toBe(NOW + 86400);
    expect(lastRumor().tags).toContainEqual(['guest']);
    expect(lastRumor().tags.some(t => t[0] === 'p')).toBe(false);
    expect(lastRumor().tags.some(t => t[0] === 'name')).toBe(false);
  });

  it('tells the caller the invite is saved before it is sent', async () => {
    const order: string[] = [];
    await createInvite(deps({ publish: async (_w, relays) => { order.push('sent'); return relays.map(() => true); } }), K, { kind: 'guest' },
      () => { order.push('saved'); });
    expect(order).toEqual(['saved', 'sent']);
  });

  it('every invite gets its own grant and secret', async () => {
    const a = await createInvite(deps(), K, { kind: 'guest' });
    const b = await createInvite(deps(), K, { kind: 'guest' });
    expect(a.invite.grant).not.toBe(b.invite.grant);
    expect(a.invite.secret).not.toBe(b.invite.secret);
  });

  it('keeps the invite as waiting when no relay took it', async () => {
    publishOk = false;
    const { sent } = await createInvite(deps(), K, { kind: 'guest' });
    expect(sent).toBe(false);
    expect((await loadStoredKeeps('key'))[0].invites[0].status).toBe('waiting');
  });

  it('the share link is the Keep\'s own format', async () => {
    const { invite } = await createInvite(deps(), K, { kind: 'guest' });
    expect(keepShareLink(K, invite.secret)).toBe(`stampede://keep/${K}/${invite.secret}`);
  });

  it('acks move an invite to Active, then Revoked', async () => {
    const { invite } = await createInvite(deps(), K, { kind: 'guest' });
    await applyAckEvents(deps(), [ackFromKeep([['status', 'active'], ['grant', invite.grant]])]);
    expect((await loadStoredKeeps('key'))[0].invites[0].status).toBe('active');
    expect(await revokeInvite(deps(), K, invite.grant)).toBe(true);
    const rumor = lastRumor();
    expect(rumor.kind).toBe(27662);
    expect(rumor.tags).toEqual([['keep', K], ['grant', invite.grant]]);
    expect((await loadStoredKeeps('key'))[0].invites[0].revokeSent).toBe(true);
    await applyAckEvents(deps(), [ackFromKeep([['status', 'revoked'], ['grant', invite.grant]])]);
    expect((await loadStoredKeeps('key'))[0].invites[0]).toMatchObject({ status: 'revoked', revokeSent: false });
  });

  it('a refused ack records the plain reason', async () => {
    const { invite } = await createInvite(deps(), K, { kind: 'guest' });
    await applyAckEvents(deps(), [ackFromKeep([['status', 'refused'], ['grant', invite.grant], ['reason', 'full']])]);
    expect((await loadStoredKeeps('key'))[0].invites[0]).toMatchObject({ status: 'refused', reason: 'full' });
  });

  it('ignores an ack signed by anyone but the Keep', async () => {
    const { invite } = await createInvite(deps(), K, { kind: 'guest' });
    const forged = wrapEvent(
      { kind: 27663, content: '', created_at: NOW, tags: [['keep', K], ['status', 'active'], ['grant', invite.grant]] },
      hexToBytes('0'.repeat(63) + '9'), O,
    ) as unknown as NostrEvent;
    await applyAckEvents(deps(), [forged]);
    expect((await loadStoredKeeps('key'))[0].invites[0].status).toBe('waiting');
  });

  it('refuses to invite from a persona that cannot sign any more', async () => {
    const onSaved = vi.fn();
    await expect(createInvite(deps({ backendFor: () => null }), K, { kind: 'guest' }, onSaved)).rejects.toBeInstanceOf(PersonaNotAvailableError);
    // Nothing was saved, shared or sent.
    expect(onSaved).not.toHaveBeenCalled();
    expect((await loadStoredKeeps('key'))[0].invites).toEqual([]);
    expect(published).toHaveLength(0);
  });

  it('two writes at once both land', async () => {
    const [a, b] = await Promise.all([createInvite(deps(), K, { kind: 'guest' }), createInvite(deps(), K, { kind: 'guest' })]);
    const grants = (await loadStoredKeeps('key'))[0].invites.map(i => i.grant).sort();
    expect(grants).toEqual([a.invite.grant, b.invite.grant].sort());
  });

  it('forgetting a Keep removes it from this device only', async () => {
    await forgetKeep(deps(), K);
    expect(await loadStoredKeeps('key')).toEqual([]);
  });
});

describe('listening for acks', () => {
  it('asks for kind 1059 addressed to the owner persona on the Keep\'s relays, three days back', async () => {
    await claimKeep(deps(), link, O);
    fetchMock.mockResolvedValue({ events: [ackFromKeep([['status', 'paired'], ['claim']])], attempted: 2, reached: 2 });
    const list = await refreshAcks(deps());
    expect(fetchMock).toHaveBeenCalledWith(
      [{ kinds: [1059], '#p': [O], since: NOW - 3 * 86400 }],
      { relays: ['wss://a.example', 'wss://b.example'] },
    );
    expect(list[0].status).toBe('paired');
  });

  it('subscribes live once per owner persona', async () => {
    await claimKeep(deps(), link, O);
    const stop = vi.fn();
    subscribeMock.mockReturnValue(stop);
    const keeps = await loadStoredKeeps('key');
    const onChange = vi.fn();
    const off = watchAcks(deps(), keeps, onChange);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0][0]).toEqual([{ kinds: [1059], '#p': [O], since: NOW - 3 * 86400 }]);
    const handler = subscribeMock.mock.calls[0][2] as (e: NostrEvent) => void;
    const ack = ackFromKeep([['status', 'paired'], ['claim']]);
    handler(ack); handler(ack);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    off();
    expect(stop).toHaveBeenCalled();
  });

  it('does nothing for wraps to a persona it holds no Keep for', async () => {
    await claimKeep(deps(), link, O);
    const stranger = wrapEvent({ kind: 27663, content: '', created_at: NOW, tags: [['keep', K], ['status', 'paired'], ['claim']] }, KEEP_SK, 'ee'.repeat(32)) as unknown as NostrEvent;
    await applyAckEvents(deps(), [stranger]);
    expect((await loadStoredKeeps('key'))[0].status).toBe('pending');
  });
});

describe('an unreadable stored list (never overwritten)', () => {
  const good = () => ({
    keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: O, personas: [O], status: 'paired', claimedAt: 1,
    invites: [{ grant: '11'.repeat(16), secret: '22'.repeat(32), kind: 'guest', createdAt: 1, expiration: 2, status: 'waiting' }],
  });

  it('a row with one record this build cannot read is left untouched by a claim, with a clear error', async () => {
    row = [good(), { ...good(), keep: 'ab'.repeat(32), status: 'a-newer-status' }];
    const before = JSON.stringify(row);
    await expect(claimKeep(deps(), link, O)).rejects.toBeInstanceOf(KeepsUnreadableError);
    expect(JSON.stringify(row)).toBe(before);
    expect(published).toHaveLength(0);
  });

  it('a row that is not a list at all is also left alone by every write', async () => {
    row = { surprise: true };
    const before = JSON.stringify(row);
    await expect(updateStoredKeeps('key', l => [...l])).rejects.toBeInstanceOf(KeepsUnreadableError);
    await expect(createInvite(deps(), K, { kind: 'guest' })).rejects.toBeInstanceOf(KeepsUnreadableError);
    await expect(forgetKeep(deps(), K)).rejects.toBeInstanceOf(KeepsUnreadableError);
    expect(JSON.stringify(row)).toBe(before);
  });

  it('a row that cannot be decrypted (the db layer throws) is treated the same way', async () => {
    dbThrows = true;
    await expect(loadStoredKeeps('key')).rejects.toBeInstanceOf(KeepsUnreadableError);
    await expect(claimKeep(deps(), link, O)).rejects.toBeInstanceOf(KeepsUnreadableError);
    expect(row).toBeNull();
  });

  it('nothing stored is an empty list, not an error', async () => {
    expect(await loadStoredKeeps('key')).toEqual([]);
  });
});

describe('updateStoredKeeps', () => {
  it('does not write when the change returns the same list', async () => {
    await updateStoredKeeps('key', l => l);
    expect(row).toBeNull();
  });
});
