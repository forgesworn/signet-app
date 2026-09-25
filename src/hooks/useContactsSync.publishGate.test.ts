// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/contacts-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/contacts-sync')>();
  return { ...actual, fetchContactsSync: vi.fn(), publishContactsSync: vi.fn() };
});

import { fetchContactsSync, publishContactsSync } from '../lib/contacts-sync';
import { purgeAllUserData, getContacts, saveContact } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { Contact, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useContactsSync } from './useContactsSync';

const mockFetch = vi.mocked(fetchContactsSync);
const mockPublish = vi.mocked(publishContactsSync);
const RELAYS = { read: ['wss://relay.example.com'], write: ['wss://relay.example.com'] };
const KEY = 'a'.repeat(64);

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;

/** A local contact the publish effect will pick up out of IDB. */
function makeContact(ownerPubkey: string): Contact {
  return {
    pubkey: 'b'.repeat(64),
    ownerPubkey,
    displayName: 'Dave',
    sharedSecret: 'c'.repeat(64),
    verifiedAt: 1000,
  } as Contact;
}

beforeEach(async () => {
  await purgeAllUserData();
  mockFetch.mockReset();
  mockPublish.mockReset().mockResolvedValue(true);
  identity = createNewIdentity('Guardian', 'natural-person', false);
  backend = {
    type: 'local', activePublicKeyHex: identity.naturalPerson.publicKey,
    signEvent: vi.fn(), nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn(), destroy: vi.fn(),
  } as unknown as DecryptingSigningBackend;
});

afterEach(() => { vi.useRealTimers(); });

/**
 * `saveContact`/`getContacts` encrypt/decrypt `sharedSecret` with a real
 * AES-256-GCM/PBKDF2 WebCrypto call, dispatched to Node's real threadpool —
 * it needs genuine wall-clock time to settle, which a *virtual*
 * `advanceTimersByTimeAsync` never provides (it fast-forwards the fake clock
 * without yielding to the real event loop). Matches the established pattern
 * in `useContactsV2Sync.test.ts`'s `withRealTimers`.
 */
async function withRealTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useRealTimers();
  try { return await fn(); } finally { vi.useFakeTimers(); }
}

describe('useContactsSync — fetch half is untouched', () => {
  it('still merges a remote record into the legacy store', async () => {
    const remote = {
      pubkey: 'b'.repeat(64),
      ownerPubkey: identity.naturalPerson.publicKey,
      displayName: 'Restored',
      sharedSecret: 'c'.repeat(64),
      verifiedAt: 9_000,
    };
    mockFetch.mockResolvedValue({ contacts: [remote], createdAt: 500, eventId: 'e'.repeat(64), reachableRelays: 1 } as never);
    const onRemoteMerged = vi.fn();

    vi.useFakeTimers();
    const { result } = renderHook(() => useContactsSync({
      identity, npBackend: backend, relays: RELAYS, encryptionKey: KEY, onRemoteMerged,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    // The merge writes the remote contact through `db.saveContact`, a real
    // WebCrypto call — see `withRealTimers` above.
    await act(async () => {
      await withRealTimers(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
    });

    expect(result.current.remoteState).toBe('present');
    // fake-indexeddb schedules on setImmediate, which fake timers capture —
    // drop back to real timers before reading IDB directly.
    vi.useRealTimers();
    expect(await getContacts(identity.naturalPerson.publicKey, KEY)).toHaveLength(1);
    expect(onRemoteMerged).toHaveBeenCalled();
  });
});

describe('useContactsSync — publishEnabled gate (R10)', () => {
  /**
   * Deliberately does NOT pre-seed a contact matching what fetch-and-merge
   * would already reconstruct: the fetch effect seeds `lastPublishedHashRef`
   * to the hash of its own (post-merge) local read (anti-echo-loop dedupe,
   * M7), so a republish of data that already matches that seed is a
   * documented no-op — not a bug, but it means a fixture whose "local
   * change" is identical to what fetch-and-merge already produced can never
   * observe a publish, regardless of `publishEnabled`. Saving the contact
   * AFTER hydration gives the debounced publish a genuine change (the fresh
   * `db.getContacts` read inside its callback differs from the empty-local
   * hash the fetch effect seeded) — real timers throughout, since hydration
   * and the debounced publish both decrypt through real WebCrypto (see
   * `withRealTimers` above), and the 1s debounce here (unlike the
   * personas/grants rails' multi-second jitter) makes waiting in real time
   * end-to-end simpler than juggling fake/real timer handoffs.
   */
  it('still publishes while the v2 rail has not proved itself', async () => {
    mockFetch.mockResolvedValue({ contacts: [], createdAt: 500, eventId: 'e'.repeat(64), reachableRelays: 1 } as never);

    const { result } = renderHook(() => useContactsSync({
      identity, npBackend: backend, relays: RELAYS, encryptionKey: KEY,
      contacts: [makeContact(identity.naturalPerson.publicKey)],
      publishEnabled: true,
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(result.current.remoteState).toBe('present');
    await saveContact(makeContact(identity.naturalPerson.publicKey), KEY);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('never publishes once the v2 rail is canonical, however long the timers run', async () => {
    mockFetch.mockResolvedValue({ contacts: [], createdAt: 500, eventId: 'e'.repeat(64), reachableRelays: 1 } as never);

    // The `contacts` prop IS passed: the landed publish effect returns early
    // without it, so omitting it would make this case pass against the code
    // as it stands today and prove nothing (R13). And the same post-hydration
    // local edit as the previous test IS performed — the one that provably
    // triggers a publish there — so a pass here is a genuine negative, not a
    // vacuous one from the anti-echo dedupe (see the note above).
    const { result } = renderHook(() => useContactsSync({
      identity, npBackend: backend, relays: RELAYS, encryptionKey: KEY,
      contacts: [makeContact(identity.naturalPerson.publicKey)],
      publishEnabled: false,
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(result.current.remoteState).toBe('present');
    await saveContact(makeContact(identity.naturalPerson.publicKey), KEY);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('defaults to publishing when the option is omitted', async () => {
    mockFetch.mockResolvedValue({ contacts: [], createdAt: 500, eventId: 'e'.repeat(64), reachableRelays: 1 } as never);

    // Real timers throughout — see the note on the previous test.
    const { result } = renderHook(() => useContactsSync({
      identity, npBackend: backend, relays: RELAYS, encryptionKey: KEY,
      contacts: [makeContact(identity.naturalPerson.publicKey)],
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(result.current.remoteState).toBe('present');
    await saveContact(makeContact(identity.naturalPerson.publicKey), KEY);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
