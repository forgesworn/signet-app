import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { AuditEntry } from './audit-fetch';
import {
  buildConnectedAppsEvent, openConnectedAppsEvent, openOwnConnectedAppsEvent,
  wrapChildActivity, unwrapChildActivity, mergeActivity,
  buildUnpairedNotice, isUnpairedNotice,
  CHILD_CONNECTED_APPS_D_TAG, CHILD_UNPAIRED_D_TAG, CONNECTED_APPS_MAX,
  type ChildActivityEntry, type ConnectedChildApp,
} from './child-activity';

const kp = () => { const sk = generateSecretKey(); return { priv: bytesToHex(sk), pub: getPublicKey(sk) }; };
const rail = kp(), client = kp(), stranger = kp();
const PERSONA = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);

function app(i: number, over: Partial<ConnectedChildApp> = {}): ConnectedChildApp {
  return { appId: `nip55:com.example.app${i}`, kind: 'nip55', label: `App ${i}`, persona: PERSONA, firstSeen: 1000 + i, lastUsed: 2000 + i, ...over };
}

function entry(over: Partial<ChildActivityEntry> = {}): ChildActivityEntry {
  return { persona: PERSONA, kind: 1, method: 'sign_event', outcome: 'signed', appId: 'nip55:com.example.app', appLabel: 'Example', requestCreatedAt: 1_000_000, at: 1_000_000, ...over };
}

function dev(over: Partial<AuditEntry> = {}): AuditEntry {
  return { id: `${PERSONA}:1`, dependantPubkey: PERSONA, createdAt: 1_000_000, outcome: 'auto-approved', eventKind: 1, ...over };
}

describe('connected apps record', () => {
  it('round trips: child builds, guardian opens with the rail key (author pinned)', async () => {
    const ev = await buildConnectedAppsEvent([app(1), app(2, { kind: 'site', appId: 'https://school.org', url: 'https://school.org' })], client.priv, rail.pub, 1_800_000_000);
    expect(ev.pubkey).toBe(client.pub);
    expect(ev.kind).toBe(30078);
    expect(ev.tags).toEqual([['d', CHILD_CONNECTED_APPS_D_TAG], ['p', rail.pub]]);
    expect(ev.content).not.toContain('App 1');
    const apps = await openConnectedAppsEvent(ev, rail.priv, client.pub);
    expect(apps?.map(a => a.appId)).toEqual(['https://school.org', 'nip55:com.example.app1']);
    expect(apps?.[0].url).toBe('https://school.org');
  });

  it('the child can read back its own record', async () => {
    const ev = await buildConnectedAppsEvent([app(1)], client.priv, rail.pub);
    expect((await openOwnConnectedAppsEvent(ev, client.priv, rail.pub))?.[0].appId).toBe('nip55:com.example.app1');
  });

  it('refuses a record from any author but the paired client', async () => {
    const ev = await buildConnectedAppsEvent([app(1)], stranger.priv, rail.pub);
    expect(await openConnectedAppsEvent(ev, rail.priv, client.pub)).toBeNull();
  });

  it('caps at 64, most recently used first', async () => {
    const many = Array.from({ length: 80 }, (_, i) => app(i));
    const apps = await openConnectedAppsEvent(await buildConnectedAppsEvent(many, client.priv, rail.pub), rail.priv, client.pub);
    expect(apps).toHaveLength(CONNECTED_APPS_MAX);
    expect(apps?.[0].appId).toBe('nip55:com.example.app79');
  });

  it('refuses a tampered event', async () => {
    const ev = await buildConnectedAppsEvent([app(1)], client.priv, rail.pub);
    expect(await openConnectedAppsEvent({ ...ev, created_at: ev.created_at + 1 }, rail.priv, client.pub)).toBeNull();
  });
});

describe('child activity rail', () => {
  it('round trips every field; the guardian unwraps with the rail key', async () => {
    const e = entry({ target: 'site:https://school.org', requestCreatedAt: 1_700_000_005 });
    const wrap = await wrapChildActivity(e, client.priv, rail.pub);
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', rail.pub]]);
    expect(await unwrapChildActivity(wrap, rail.priv, client.pub)).toEqual(e);
  });

  it('a crypto entry (kind null) round trips', async () => {
    const e = entry({ kind: null, method: 'nip44_decrypt', outcome: 'denied', requestCreatedAt: undefined });
    const { requestCreatedAt: _r, ...rest } = e; void _r;
    expect(await unwrapChildActivity(await wrapChildActivity(e, client.priv, rail.pub), rail.priv, client.pub)).toEqual(rest);
  });

  it('activity from a non-paired author is dropped', async () => {
    const wrap = await wrapChildActivity(entry(), stranger.priv, rail.pub);
    expect(await unwrapChildActivity(wrap, rail.priv, client.pub)).toBeNull();
  });

  it('a wrap to someone else does not open', async () => {
    const wrap = await wrapChildActivity(entry(), client.priv, stranger.pub);
    expect(await unwrapChildActivity(wrap, rail.priv, client.pub)).toBeNull();
  });
});

describe('unpaired notice', () => {
  it('accepts the rail key naming this client', () => {
    const ev = buildUnpairedNotice(rail.priv, client.pub, 1_800_000_000);
    expect(ev.tags).toEqual([['d', CHILD_UNPAIRED_D_TAG], ['p', client.pub]]);
    expect(isUnpairedNotice(ev, rail.pub, client.pub)).toBe(true);
  });

  it('ignores a notice from the wrong author', () => {
    const ev = buildUnpairedNotice(stranger.priv, client.pub);
    expect(isUnpairedNotice(ev, rail.pub, client.pub)).toBe(false);
  });

  it('ignores a notice for a different client (an earlier pairing)', () => {
    expect(isUnpairedNotice(buildUnpairedNotice(rail.priv, stranger.pub), rail.pub, client.pub)).toBe(false);
  });

  it('ignores a forged body under the right tags', () => {
    const sk = generateSecretKey();
    const forged = finalizeEvent({ kind: 30078, created_at: 1, tags: [['d', CHILD_UNPAIRED_D_TAG], ['p', client.pub]], content: '{"v":1,"clientPubkey":"' + client.pub + '"}' }, sk) as unknown as NostrEvent;
    expect(isUnpairedNotice({ ...forged, pubkey: rail.pub }, rail.pub, client.pub)).toBe(false);
  });
});

describe('mergeActivity', () => {
  const NOW = 1_000_000 + 10_000;

  it('joins exactly on (persona, kind, request created_at)', () => {
    const rows = mergeActivity([entry()], [dev()], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mismatch: false });
    expect(rows[0].entry).not.toBeNull();
    expect(rows[0].device).not.toBeNull();
  });

  it('tolerates the device bumping created_at by +1 s, and never joins across personas or kinds', () => {
    const rows = mergeActivity(
      [entry({ requestCreatedAt: 1_000_000 }), entry({ requestCreatedAt: 1_000_001 })],
      [dev({ createdAt: 1_000_001 }), dev({ createdAt: 1_000_002 }), dev({ createdAt: 1_000_001, dependantPubkey: OTHER }), dev({ createdAt: 1_000_001, eventKind: 7 })],
      NOW,
    );
    const joined = rows.filter(r => r.entry && r.device);
    expect(joined).toHaveLength(2);
    expect(rows.filter(r => r.mismatch)).toHaveLength(2); // the other persona + the other kind
  });

  it('does not join a device record more than 2 s after, or before, the request', () => {
    const rows = mergeActivity([entry()], [dev({ createdAt: 1_000_003 }), dev({ createdAt: 999_999 })], NOW);
    expect(rows.filter(r => r.entry && r.device)).toHaveLength(0);
  });

  it('leaves child-only denied rows unmatched, without a mismatch', () => {
    const rows = mergeActivity([entry({ outcome: 'denied', requestCreatedAt: undefined })], [], NOW);
    expect(rows).toEqual([{ entry: expect.objectContaining({ outcome: 'denied' }), device: null, mismatch: false }]);
  });

  it('flags a device-only signing after 600 s, not before', () => {
    expect(mergeActivity([], [dev({ createdAt: NOW - 601 })], NOW)[0].mismatch).toBe(true);
    expect(mergeActivity([], [dev({ createdAt: NOW - 600 })], NOW)[0].mismatch).toBe(false);
  });

  it('does not flag a device-only refusal', () => {
    expect(mergeActivity([], [dev({ createdAt: NOW - 5000, outcome: 'auto-denied' })], NOW)[0].mismatch).toBe(false);
  });

  it('joins crypto requests on method', () => {
    const rows = mergeActivity(
      [entry({ kind: null, method: 'nip44_encrypt' })],
      [dev({ eventKind: undefined, method: 'nip44_encrypt' })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry && rows[0].device).toBeTruthy();
  });

  it('is newest first', () => {
    const rows = mergeActivity([entry({ at: 5, requestCreatedAt: undefined, outcome: 'denied' })], [dev({ createdAt: 9 })], 20);
    expect(rows[0].device?.createdAt).toBe(9);
  });

  it('A48: a device record matched by the guardian\'s own signing is "by you", never a mismatch', () => {
    const d = dev({ createdAt: NOW - 5000 });
    const g = { source: 'guardian' as const, persona: d.dependantPubkey, kind: d.eventKind ?? null, method: 'sign_event' as const, requestCreatedAt: NOW - 5000, at: NOW - 5000 };
    const rows = mergeActivity([], [d], NOW, [g]);
    expect(rows).toEqual([{ entry: null, device: d, mismatch: false, byGuardian: true }]);
    // a guardian row for another persona does not excuse it
    expect(mergeActivity([], [d], NOW, [{ ...g, persona: OTHER }])[0].mismatch).toBe(true);
    // a child record wins the device record first
    const both = mergeActivity([entry({ requestCreatedAt: NOW - 5000 })], [d], NOW, [g]);
    expect(both).toHaveLength(1);
    expect(both[0].entry).not.toBeNull();
    expect(both[0].byGuardian).toBeUndefined();
  });
});
