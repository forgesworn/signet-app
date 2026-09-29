// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { AuditEntry } from '../lib/audit-fetch';
import type { DependantIdentity } from '../types';
import { buildConnectedAppsEvent, wrapChildActivity, type ChildActivityEntry } from '../lib/child-activity';
import { useChildActivity, type ChildActivityRailTransport } from './useChildActivity';

const kp = () => { const sk = generateSecretKey(); return { priv: bytesToHex(sk), pub: getPublicKey(sk) }; };
const rail = kp(), client = kp(), stranger = kp();
const PERSONA = 'ab'.repeat(32), DEP = 'ef'.repeat(32);
const PAIRED_MS = 1_700_000_000_000, NOW_MS = PAIRED_MS + 3_600_000;
const KEY = 'k'.repeat(64);

function dep(): DependantIdentity {
  return {
    id: DEP, displayName: 'Sky',
    naturalPerson: { publicKey: DEP }, persona: { publicKey: PERSONA },
    bunkerEndpoint: { publicKey: rail.pub, privateKey: rail.priv, createdAt: 1, authorizedClientPubkey: client.pub },
    childDevice: { mode: 'heartwood-direct', slotLabel: 'l', secretFingerprint: 'aa'.repeat(32), slotIndex: 1, clientPubkey: client.pub,
      boundPersona: PERSONA, pairedAt: PAIRED_MS, railRelay: 'wss://rail.example' },
  } as unknown as DependantIdentity;
}

function fake() {
  const subs: { filters: unknown[]; relays: string[]; onEvent: (e: NostrEvent) => void }[] = [];
  const t: ChildActivityRailTransport = { subscribe: (filters, relays, onEvent) => { subs.push({ filters, relays, onEvent }); return () => {}; } };
  return { t, subs };
}

const entry = (over: Partial<ChildActivityEntry> = {}): ChildActivityEntry => ({
  persona: PERSONA, kind: 1, method: 'sign_event', outcome: 'signed', appId: 'nip55:com.x', appLabel: 'X',
  requestCreatedAt: NOW_MS / 1000 - 100, at: NOW_MS / 1000 - 100, ...over,
});

describe('useChildActivity (guardian)', () => {
  it('reads the child activity and connected apps on the rail relay and merges with the device records', async () => {
    const { t, subs } = fake();
    const device: AuditEntry[] = [
      { id: 'a', dependantPubkey: PERSONA, createdAt: NOW_MS / 1000 - 99, outcome: 'auto-approved', eventKind: 1 },
      { id: 'b', dependantPubkey: PERSONA, createdAt: NOW_MS / 1000 - 1200, outcome: 'auto-approved', eventKind: 7 },
      { id: 'c', dependantPubkey: PERSONA, createdAt: PAIRED_MS / 1000 - 10, outcome: 'approved', eventKind: 1 }, // before pairing
    ];
    const { result } = renderHook(() => useChildActivity({ dependant: dep(), relays: ['wss://other.example'], encryptionKey: KEY, deviceEntries: device, transport: t, now: () => NOW_MS }));
    await waitFor(() => expect(subs.length).toBe(1));
    expect(subs[0].relays).toEqual(['wss://rail.example']);
    expect(subs[0].filters[0]).toMatchObject({ kinds: [1059], '#p': [rail.pub] });
    await act(async () => {
      subs[0].onEvent(await wrapChildActivity(entry(), client.priv, rail.pub));
      subs[0].onEvent(await wrapChildActivity(entry({ outcome: 'denied', kind: 4, requestCreatedAt: undefined }), stranger.priv, rail.pub));
      subs[0].onEvent(await buildConnectedAppsEvent([{ appId: 'nip55:com.x', kind: 'nip55', label: 'X', persona: PERSONA, firstSeen: 1, lastUsed: 2 }], client.priv, rail.pub));
    });
    await waitFor(() => expect(result.current.apps).toHaveLength(1));
    await waitFor(() => expect(result.current.rows.length).toBe(2));
    const joined = result.current.rows.find(r => r.entry && r.device);
    expect(joined?.device?.id).toBe('a');
    const flagged = result.current.rows.find(r => r.mismatch);
    expect(flagged?.device?.id).toBe('b');
  });

  it('is idle while locked, and for a phone-paired dependant', async () => {
    const a = fake();
    renderHook(() => useChildActivity({ dependant: dep(), relays: [], encryptionKey: null, deviceEntries: [], transport: a.t }));
    const b = fake();
    const d = dep(); delete (d as { childDevice?: unknown }).childDevice;
    const { result } = renderHook(() => useChildActivity({ dependant: d, relays: ['wss://r.example'], encryptionKey: KEY, deviceEntries: [], transport: b.t }));
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(a.subs.length + b.subs.length).toBe(0);
    expect(result.current.rows).toEqual([]);
  });
});
