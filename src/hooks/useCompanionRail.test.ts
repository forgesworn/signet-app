// @vitest-environment jsdom
//
// kenspeckle 0.2.0 companion-rail maintainer finding: `buildGrantEnvelope`
// now throws when a contact wouldn't survive the wire, and the publish-loop
// in useCompanionRail used to wrap the ENTIRE for-loop in one try/catch — so
// one grant's envelope throwing stopped every other paired app from being
// republished on that retry too. This file pins the per-grant isolation fix.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/db', () => ({
  listCompanionGrants: vi.fn(),
  getContacts: vi.fn(async () => []),
  getKens: vi.fn(async () => []),
  getCompanionGrant: vi.fn(),
  saveCompanionGrant: vi.fn(async () => {}),
}));

vi.mock('../lib/companion-rail', () => ({
  publishSnapshot: vi.fn(),
}));

import * as db from '../lib/db';
import { publishSnapshot } from '../lib/companion-rail';
import { createNewIdentity } from '../lib/signet';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import type { SignetIdentity } from '../types';
import type { CompanionGrant } from '../types/companion';
import { useCompanionRail } from './useCompanionRail';

const mockList = vi.mocked(db.listCompanionGrants);
const mockGetGrant = vi.mocked(db.getCompanionGrant);
const mockSave = vi.mocked(db.saveCompanionGrant);
const mockPublish = vi.mocked(publishSnapshot);

const APP_A = 'a'.repeat(64);
const APP_B = 'b'.repeat(64);

function makeBackend(pubkeyHex: string): DecryptingSigningBackend {
  return {
    type: 'local',
    activePublicKeyHex: pubkeyHex,
    signEvent: vi.fn(),
    nip44Encrypt: vi.fn(),
    nip44Decrypt: vi.fn(),
    destroy: vi.fn(),
  } as unknown as DecryptingSigningBackend;
}

function makeGrant(appPubkey: string): CompanionGrant {
  return {
    appPubkey,
    appName: 'App',
    railPubkey: 'r'.repeat(64),
    snapshotRelay: 'wss://relay.example.com',
    scope: { tiers: ['ken'], personas: 'all' },
    createdAt: 1000,
  };
}

let identity: SignetIdentity;

beforeEach(() => {
  vi.clearAllMocks();
  identity = createNewIdentity('Owner', 'natural-person', false);
  mockSave.mockResolvedValue(undefined);
});

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
}

describe('useCompanionRail — per-grant isolation', () => {
  it('one grant whose publishSnapshot throws does not stop another grant from publishing', async () => {
    const grantA = makeGrant(APP_A);
    const grantB = makeGrant(APP_B);
    mockList.mockResolvedValue([grantA, grantB]);
    mockGetGrant.mockImplementation(async (pk: string) => (pk === APP_B ? grantB : grantA));
    mockPublish.mockImplementation(async (_scope, _entries, _at, _backend, appPubkey: string) => {
      if (appPubkey === APP_A) {
        throw new TypeError('grant envelope: a contact would not survive the wire intact');
      }
      return { ok: true, eventId: 'evt-b', hash: 'hash-b' };
    });

    const railBackends = new Map<string, DecryptingSigningBackend>([
      [APP_A, makeBackend('a1'.padEnd(64, '1'))],
      [APP_B, makeBackend('b1'.padEnd(64, '1'))],
    ]);

    vi.useFakeTimers();
    renderHook(() => useCompanionRail({
      identity,
      railBackends,
      relayUrl: 'wss://relay.example.com',
      encryptionKey: 'k'.repeat(64),
      contacts: [],
      kens: [],
      enabled: true,
    }));
    await flush();
    vi.useRealTimers();

    // Both grants were attempted — grant A's throw didn't stop the loop
    // before it reached grant B.
    expect(mockPublish).toHaveBeenCalledTimes(2);
    const calledApps = mockPublish.mock.calls.map(c => c[4]);
    expect(calledApps).toContain(APP_A);
    expect(calledApps).toContain(APP_B);

    // Only grant B's (successful) result was persisted; grant A's throw
    // left its record untouched, not corrupted.
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toMatchObject({ appPubkey: APP_B, lastPayloadHash: 'hash-b' });
  });

  it('every grant throwing still lets the effect complete without an unhandled rejection', async () => {
    const grantA = makeGrant(APP_A);
    const grantB = makeGrant(APP_B);
    mockList.mockResolvedValue([grantA, grantB]);
    mockPublish.mockRejectedValue(new TypeError('grant envelope: at most 5000 contacts per envelope'));

    const railBackends = new Map<string, DecryptingSigningBackend>([
      [APP_A, makeBackend('a1'.padEnd(64, '1'))],
      [APP_B, makeBackend('b1'.padEnd(64, '1'))],
    ]);

    vi.useFakeTimers();
    renderHook(() => useCompanionRail({
      identity,
      railBackends,
      relayUrl: 'wss://relay.example.com',
      encryptionKey: 'k'.repeat(64),
      contacts: [],
      kens: [],
      enabled: true,
    }));
    await flush();
    vi.useRealTimers();

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockSave).not.toHaveBeenCalled();
  });
});
