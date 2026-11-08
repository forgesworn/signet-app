// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

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

/**
 * Real timers throughout, for the reason `withRealTimers` documents above:
 * `saveContact` / `getContacts` run real WebCrypto.
 *
 * State the hook sets while a test is inside an `act` scope is only rendered
 * when that scope exits, so a negative assertion first lets one short `act`
 * flush hydration (arming the publish timer) and only then waits out the
 * debounce. Without that the "no publish" cases could pass without the
 * publish effect ever having been armed.
 */
describe('useContactsSync: republish after a merge the local side won (#192)', () => {
  const REMOTE = (contacts: Contact[]) => ({
    contacts, createdAt: 500, eventId: 'e'.repeat(64), reachableRelays: 1,
  }) as never;

  interface Props { relays: { read: string[]; write: string[] } }
  function renderContacts(initialProps: Props) {
    return renderHook(
      (props: Props) => useContactsSync({
        identity, npBackend: backend, relays: props.relays, encryptionKey: KEY,
        contacts: [makeContact(identity.naturalPerson.publicKey)],
      }),
      { initialProps },
    );
  }

  const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const publishes = (n: number) => waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(n), { timeout: 8000 });

  it('publishes a contact only this device holds', async () => {
    await saveContact(makeContact(identity.naturalPerson.publicKey), KEY);
    mockFetch.mockResolvedValue(REMOTE([]));

    renderContacts({ relays: RELAYS });
    await publishes(1);
  });

  it('publishes when the local side holds a strictly newer verifiedAt than the relay', async () => {
    const owner = identity.naturalPerson.publicKey;
    await saveContact({ ...makeContact(owner), displayName: 'Local', verifiedAt: 2000 }, KEY);
    mockFetch.mockResolvedValue(REMOTE([{ ...makeContact(owner), displayName: 'Remote', verifiedAt: 1000 }]));

    renderContacts({ relays: RELAYS });
    await publishes(1);
    expect((mockPublish.mock.calls[0][0] as Contact[]).map((c) => c.displayName)).toEqual(['Local']);
  });

  it('does not publish when the relay is the richer side', async () => {
    const owner = identity.naturalPerson.publicKey;
    await saveContact({ ...makeContact(owner), displayName: 'Old', verifiedAt: 1000 }, KEY);
    mockFetch.mockResolvedValue(REMOTE([
      { ...makeContact(owner), displayName: 'Newer', verifiedAt: 2000 },
      { ...makeContact(owner), pubkey: 'd'.repeat(64), displayName: 'Remote only', verifiedAt: 1500 },
    ]));

    const { result } = renderContacts({ relays: RELAYS });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await settle(300);
    await settle(2000);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(await getContacts(owner, KEY)).toHaveLength(2);
  });

  it('does not publish when the relay already holds exactly this state', async () => {
    const contact = makeContact(identity.naturalPerson.publicKey);
    await saveContact(contact, KEY);
    mockFetch.mockResolvedValue(REMOTE([contact]));

    const { result } = renderContacts({ relays: RELAYS });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await settle(300);
    await settle(2000);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('republishes a won merge even though this device already published that exact state', async () => {
    await saveContact(makeContact(identity.naturalPerson.publicKey), KEY);
    mockFetch.mockResolvedValueOnce(null);

    const { rerender } = renderContacts({ relays: RELAYS });
    await publishes(1);

    // Another device overwrote the relay with an empty record; the relay set
    // changing re-fetches it. Our contact is something it lacks, so the
    // unchanged local state must go back out.
    mockFetch.mockResolvedValue(REMOTE([]));
    rerender({ relays: { read: ['wss://relay-two.example.com'], write: RELAYS.write } });
    await publishes(2);
  });

  it('does not publish after an unreachable fetch, even after a local change', async () => {
    mockFetch.mockResolvedValue('unreachable');

    const { result } = renderContacts({ relays: RELAYS });
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await settle(300);
    await saveContact(makeContact(identity.naturalPerson.publicKey), KEY);
    await settle(2000);

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
