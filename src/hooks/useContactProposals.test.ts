// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useContactProposals } from './useContactProposals';
import { buildProposalBatch, proposalEventTemplate, proposalTag, scopedContactId } from '@forgesworn/signet-contacts/wire';
import type { ContactProposalV1 } from '@forgesworn/signet-contacts/wire';
// (`proposalTag` is used by the typed-filter assertion below as well as the fixtures.)
import * as db from '../lib/db';
import * as relayService from '../lib/relay-service';
import { LocalSigningBackend } from '../lib/signing-backend';
import { MAX_APP_LABELS_PER_GRANT } from '../types';
import { MAX_ENVELOPE_CHARS } from '../lib/vault-envelope';
import type { AppGrantV2 } from '../types';

const KEY = 'a'.repeat(64);
const RAIL_SK = 'b'.repeat(63) + '1';
const APP_SK = 'c'.repeat(63) + '1';
const GRANT = 'f'.repeat(32);
const SCOPED = scopedContactId(GRANT, 'contact-ada');
const RELAYS = { read: ['wss://r.example'], write: ['wss://r.example'] };

const rail = () => new LocalSigningBackend(RAIL_SK);
const app = () => new LocalSigningBackend(APP_SK);

function grant(over: Partial<AppGrantV2> = {}): AppGrantV2 {
  return {
    grantId: GRANT, directoryId: 'owner', ownerIdentityPubkey: '1'.repeat(64), appPubkey: app().activePublicKeyHex, createdAt: 1, updatedAt: 1,
    appName: 'Flock',
    capabilities: ['signet.contacts.propose:add-ken', 'signet.contacts.propose:rename-app-label'],
    railPubkey: rail().activePublicKeyHex, railPrivateKey: RAIL_SK,
    relay: 'wss://r.example', maxStalenessSeconds: 21600, appLabels: {}, seenOperationIds: [], ...over,
  };
}

function proposal(over: Partial<ContactProposalV1> = {}): ContactProposalV1 {
  return {
    v: 1, grantId: GRANT, operationId: '9'.repeat(32), action: 'add-ken',
    value: { pubkey: 'd'.repeat(64), displayName: 'Ada' }, createdAt: Math.floor(Date.now() / 1000) - 10, ...over,
  };
}

async function eventForGrant(grantId: string, proposals: ContactProposalV1[]) {
  const a = app();
  const content = await a.nip44Encrypt(rail().activePublicKeyHex, buildProposalBatch(proposals));
  return a.signEvent(proposalEventTemplate(a.activePublicKeyHex, grantId, Math.floor(Date.now() / 1000), content));
}

async function eventFor(proposals: ContactProposalV1[]) {
  return eventForGrant(GRANT, proposals);
}

function options(over: Record<string, unknown> = {}) {
  return {
    enabled: true, encryptionKey: KEY, relays: RELAYS, grantsToken: 'g1',
    directoryScopedIds: async () => new Map([[SCOPED, 'contact-ada']]),
    onAddKen: vi.fn(async () => {}),
    onRenameAppLabel: vi.fn(async () => {}),
    ...over,
  } as never;
}

beforeEach(async () => {
  await db.purgeAllUserData();
  vi.spyOn(relayService, 'subscribeEvents').mockReturnValue(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('useContactProposals', () => {
  it('decrypts a backlog batch and applies an add-ken', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => {});
    renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(onAddKen).toHaveBeenCalledWith(
      'owner', { pubkey: 'd'.repeat(64), displayName: 'Ada' }, 'Flock', GRANT,
    ));
  });

  it('applies a rename by writing appLabels on the grant', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    const renameUpdatedAt = Date.now();
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '8'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'Coach', updatedAt: renameUpdatedAt },
    })])]);
    renderHook(() => useContactProposals(options()));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.appLabels[SCOPED]).toEqual({ label: 'Coach', updatedAt: renameUpdatedAt });
    });
  });

  it('rejects a stale rename that would regress an already-applied label clock', async () => {
    // R-17: an app-local rename carries its own last-writer-wins clock. A
    // replayed or reordered rename whose clock is OLDER than the stored
    // entry's must never win — it is reported as a local rejection, and the
    // stored label is left exactly as it was.
    const existingUpdatedAt = Date.now();
    await db.saveContactGrantV2(
      grant({ appLabels: { [SCOPED]: { label: 'Coach', updatedAt: existingUpdatedAt } } }), KEY,
    );
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '6'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'Stale Name', updatedAt: existingUpdatedAt - 1000 },
    })])]);
    const onRenameAppLabel = vi.fn(async () => {});
    const { result } = renderHook(() => useContactProposals(options({ onRenameAppLabel })));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    expect(onRenameAppLabel).not.toHaveBeenCalled();
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(stored?.appLabels[SCOPED]).toEqual({ label: 'Coach', updatedAt: existingUpdatedAt });
  });

  it('rejects a rename whose updatedAt exactly matches the stored entry (equal is not newer)', async () => {
    const existingUpdatedAt = Date.now();
    await db.saveContactGrantV2(
      grant({ appLabels: { [SCOPED]: { label: 'Coach', updatedAt: existingUpdatedAt } } }), KEY,
    );
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '5'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'Same Clock', updatedAt: existingUpdatedAt },
    })])]);
    const { result } = renderHook(() => useContactProposals(options()));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(stored?.appLabels[SCOPED]).toEqual({ label: 'Coach', updatedAt: existingUpdatedAt });
  });

  it('refuses a 17th distinct app label rather than evicting an existing one', async () => {
    const existingLabels: AppGrantV2['appLabels'] = {};
    for (let i = 0; i < MAX_APP_LABELS_PER_GRANT; i += 1) {
      existingLabels[scopedContactId(GRANT, `contact-${i}`)] = { label: `Label ${i}`, updatedAt: 1 };
    }
    await db.saveContactGrantV2(grant({ appLabels: existingLabels }), KEY);
    const overflowScoped = scopedContactId(GRANT, 'contact-overflow');
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '4'.repeat(32), action: 'rename-app-label',
      value: { contactId: overflowScoped, label: 'Overflow', updatedAt: Date.now() },
    })])]);
    const onRenameAppLabel = vi.fn(async () => {});
    const { result } = renderHook(() => useContactProposals(options({
      onRenameAppLabel,
      directoryScopedIds: async () => new Map([[overflowScoped, 'contact-overflow']]),
    })));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    expect(onRenameAppLabel).not.toHaveBeenCalled();
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(Object.keys(stored?.appLabels ?? {})).toHaveLength(MAX_APP_LABELS_PER_GRANT);
    expect(stored?.appLabels[overflowScoped]).toBeUndefined();
  });

  it('still allows updating an existing app label while the grant is already at the cap', async () => {
    const existingLabels: AppGrantV2['appLabels'] = {};
    for (let i = 0; i < MAX_APP_LABELS_PER_GRANT; i += 1) {
      existingLabels[scopedContactId(GRANT, `contact-${i}`)] = { label: `Label ${i}`, updatedAt: 1 };
    }
    await db.saveContactGrantV2(grant({ appLabels: existingLabels }), KEY);
    const target = scopedContactId(GRANT, 'contact-0');
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '3'.repeat(32), action: 'rename-app-label',
      value: { contactId: target, label: 'Renamed', updatedAt: Date.now() },
    })])]);
    renderHook(() => useContactProposals(options({
      directoryScopedIds: async () => new Map([[target, 'contact-0']]),
    })));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.appLabels[target]?.label).toBe('Renamed');
    });
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(Object.keys(stored?.appLabels ?? {})).toHaveLength(MAX_APP_LABELS_PER_GRANT);
  });

  it('ignores a live proposal once the grant has been revoked after subscribing', async () => {
    // R-17: the binding checks (author pin + revocation) are re-applied on
    // EVERY event, not just at subscribe time — a grant revoked mid-session
    // must stop accepting immediately.
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    let emit: ((e: unknown) => void) | null = null;
    vi.spyOn(relayService, 'subscribeEvents').mockImplementation((_f, _r, onEvent) => {
      emit = onEvent as (e: unknown) => void;
      return () => {};
    });
    const onAddKen = vi.fn(async () => {});
    renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(emit).not.toBeNull());
    const current = await db.getContactGrantV2(GRANT, KEY);
    await db.saveContactGrantV2({ ...current!, revokedAt: 999 }, KEY);
    emit!(await eventFor([proposal()]));
    await new Promise((r) => setTimeout(r, 20));
    expect(onAddKen).not.toHaveBeenCalled();
  });

  it('remembers operation ids so a re-fetch applies nothing twice', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => {});
    const { rerender } = renderHook((p: { grantsToken: string }) =>
      useContactProposals(options({ onAddKen, grantsToken: p.grantsToken })), { initialProps: { grantsToken: 'g1' } });
    await waitFor(() => expect(onAddKen).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect((await db.getContactGrantV2(GRANT, KEY))?.seenOperationIds).toContain('9'.repeat(32)));
    rerender({ grantsToken: 'g2' });
    await new Promise((r) => setTimeout(r, 20));
    expect(onAddKen).toHaveBeenCalledTimes(1);
  });

  it('pins the author: a batch signed by a key that is not the grant’s app is ignored', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    const imposter = { ...(await eventFor([proposal()])), pubkey: '7'.repeat(64) };
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([imposter]);
    const onAddKen = vi.fn(async () => {});
    renderHook(() => useContactProposals(options({ onAddKen })));
    await new Promise((r) => setTimeout(r, 20));
    expect(onAddKen).not.toHaveBeenCalled();
  });

  it('rejects a proposal the grant does not cover', async () => {
    await db.saveContactGrantV2(grant({ capabilities: ['signet.contacts.read:directory'] }), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => {});
    const { result } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    expect(onAddKen).not.toHaveBeenCalled();
  });

  it('ignores a revoked grant entirely', async () => {
    await db.saveContactGrantV2(grant({ revokedAt: 5 }), KEY);
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    renderHook(() => useContactProposals(options()));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it('applies a live proposal arriving on the subscription', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    let emit: ((e: unknown) => void) | null = null;
    vi.spyOn(relayService, 'subscribeEvents').mockImplementation((_f, _r, onEvent) => {
      emit = onEvent as (e: unknown) => void;
      return () => {};
    });
    const onAddKen = vi.fn(async () => {});
    renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(emit).not.toBeNull());
    emit!(await eventFor([proposal()]));
    await waitFor(() => expect(onAddKen).toHaveBeenCalledTimes(1));
  });

  it('counts a directory-full add-ken as rejected and does NOT remember it (R-28b)', async () => {
    // The ceiling can move — the owner removes some app-added contacts — so
    // this is the one refusal worth reconsidering when the app asks again.
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => 'directory-full');
    const { result } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    expect(result.current.accepted).toBe(0);
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(stored?.seenOperationIds).toEqual([]);
  });

  it('counts a final refusal as rejected but DOES remember it (R-28)', async () => {
    // A directory this device does not own, or an unusable key — retrying it
    // would never succeed, so it is remembered the way an acceptance is.
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => 'refused');
    const { result } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    });
  });

  it('treats an already-present key as accepted, and remembers it (R-28a)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => 'existing');
    const { result } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(result.current.accepted).toBe(1));
    expect(result.current.rejected).toBe(0);
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    });
  });

  it('reads on the grant’s own relay even when it is not in the read pool (A/I2)', async () => {
    // `grant.relay` is fixed at pairing from `relays.write[0]`, and it is the
    // only relay the SDK ever publishes a proposal to — but read and write
    // flags are per relay, so a write-only first relay used to leave the
    // proposal wire dead in one direction with no error anywhere.
    await db.saveContactGrantV2(grant({ relay: 'wss://write-only.example' }), KEY);
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    renderHook(() => useContactProposals(options()));
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    const [, opts] = fetchEvents.mock.calls[0]!;
    expect(opts?.relays).toEqual(['wss://r.example', 'wss://write-only.example']);
  });

  it('still runs with an empty read pool when the grant carries a usable relay (A/I2)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    renderHook(() => useContactProposals(options({ relays: { read: [], write: [] } })));
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    const [, opts] = fetchEvents.mock.calls[0]!;
    expect(opts?.relays).toEqual(['wss://r.example']);
  });

  it('never decrypts an oversized envelope (A/M3)', async () => {
    // Post-migration each decrypt is a NIP-46 round-trip through an ESP32, so
    // an unbounded `content` lets an app (or a relay) make every one of them
    // as expensive as it likes, for free.
    await db.saveContactGrantV2(grant(), KEY);
    const real = await eventFor([proposal()]);
    const oversized = { ...real, content: 'A'.repeat(MAX_ENVELOPE_CHARS + 1) };
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([oversized]);
    const onAddKen = vi.fn(async () => {});
    const { result } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(result.current.lastInboxAt).not.toBeNull());
    expect(onAddKen).not.toHaveBeenCalled();
    expect(result.current.rejected).toBe(0);
  });

  it('persists ids AND labels for a batch that has already applied, even when the grant set changes mid-apply', async () => {
    // `cancelled` used to skip the persist outright, so a grant-set bump —
    // an approval, a revoke, a forget, a rail merge — landing while a batch
    // was mid-apply left real contact operations applied and unremembered.
    // The bump here comes from the LAST outcome's callback, so both outcomes
    // have genuinely applied by the time the run is superseded.
    await db.saveContactGrantV2(grant(), KEY);
    const ev = await eventFor([
      proposal(),
      proposal({
        operationId: '7'.repeat(32), action: 'rename-app-label',
        value: { contactId: SCOPED, label: 'Coach', updatedAt: Date.now() },
      }),
    ]);
    // Only the FIRST fetch yields the event: if the persist below is missing,
    // no later run can quietly make the assertion pass instead.
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents');
    fetchEvents.mockResolvedValueOnce([ev]).mockResolvedValue([]);

    let bump: (() => void) | null = null;
    const onAddKen = vi.fn(async () => 'created');
    const onRenameAppLabel = vi.fn(async () => { bump?.(); });
    const { rerender } = renderHook(
      (p: { grantsToken: string }) => useContactProposals(options({
        onAddKen, onRenameAppLabel, grantsToken: p.grantsToken,
      })),
      { initialProps: { grantsToken: 'g1' } },
    );
    bump = () => rerender({ grantsToken: 'g2' });

    await waitFor(() => expect(onRenameAppLabel).toHaveBeenCalledTimes(1));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toEqual(['9'.repeat(32), '7'.repeat(32)]);
      expect(stored?.appLabels[SCOPED]?.label).toBe('Coach');
    });
  });

  it('a superseded run’s late persist cannot regress a label a newer run already wrote', async () => {
    // The clobber: `appLabels` used to be written wholesale from a snapshot
    // taken BEFORE the callbacks ran. Run A (X→"a" at t=100) superseded
    // mid-batch, run B (X→"b" at t=200) persisting, then A's late persist
    // landing, put "a" back — and bumped `updatedAt`, so the regression won
    // the grants rail's last-writer comparison on every other device too. The
    // in-loop stale-clock guard cannot catch it: it compares against the
    // snapshot, which by then is exactly the stale thing.
    await db.saveContactGrantV2(grant(), KEY);
    const renameA = proposal({
      operationId: '3'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'a', updatedAt: 100 },
    });
    const renameB = proposal({
      operationId: '2'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'b', updatedAt: 200 },
    });
    // Run A sees the older rename, run B the newer one.
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents');
    fetchEvents
      .mockResolvedValueOnce([await eventFor([renameA])])
      .mockResolvedValueOnce([await eventForGrant(GRANT, [renameB])])
      .mockResolvedValue([]);

    // A's callback parks until B has finished persisting, so A's own write
    // genuinely lands last — the exact ordering the clobber needed.
    // Definite assignment: the resolver IS set synchronously by the Promise
    // executor, but TypeScript's control-flow analysis does not model that and
    // narrows a `| null` binding to `never` at the call below.
    let releaseA!: () => void;
    const aParked = new Promise<void>((resolve) => { releaseA = resolve; });
    let bDone!: () => void;
    const bApplied = new Promise<void>((resolve) => { bDone = resolve; });
    let call = 0;
    let bump: (() => void) | null = null;
    const onRenameAppLabel = vi.fn(async () => {
      call += 1;
      if (call === 1) { bump?.(); await aParked; return; }
      bDone();
    });

    const { rerender } = renderHook(
      (p: { grantsToken: string }) => useContactProposals(options({
        onRenameAppLabel, grantsToken: p.grantsToken,
      })),
      { initialProps: { grantsToken: 'g1' } },
    );
    bump = () => rerender({ grantsToken: 'g2' });

    await bApplied;
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.appLabels[SCOPED]).toEqual({ label: 'b', updatedAt: 200 });
    });
    const afterB = await db.getContactGrantV2(GRANT, KEY);

    // Now let the superseded run finish and write. Waiting for ITS id to
    // appear is what proves A's persist actually ran — without that, the
    // assertions below would pass just as well against a persist that never
    // happened at all.
    releaseA();
    await waitFor(async () => {
      const row = await db.getContactGrantV2(GRANT, KEY);
      expect(row?.seenOperationIds).toContain('3'.repeat(32));
    }, { timeout: 10_000 });

    const afterA = await db.getContactGrantV2(GRANT, KEY);
    // B's label stands, and A did not move the rail's last-writer clock.
    expect(afterA?.appLabels[SCOPED]).toEqual({ label: 'b', updatedAt: 200 });
    expect(afterA?.updatedAt).toBe(afterB?.updatedAt);
  });

  it('stops applying NEW outcomes once cancelled, while still remembering the ones that landed', async () => {
    // The other half of the same rule: cancellation is a stop signal for work
    // not yet started, not an instruction to forget work already done.
    await db.saveContactGrantV2(grant(), KEY);
    const ev = await eventFor([
      proposal(),
      proposal({ operationId: '6'.repeat(32), value: { pubkey: 'e'.repeat(64), displayName: 'Bo' } }),
      proposal({ operationId: '5'.repeat(32), value: { pubkey: 'f'.repeat(64), displayName: 'Cy' } }),
    ]);
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents');
    fetchEvents.mockResolvedValueOnce([ev]).mockResolvedValue([]);

    let bump: (() => void) | null = null;
    const onAddKen = vi.fn(async () => { bump?.(); bump = null; return 'created'; });
    const { rerender } = renderHook(
      (p: { grantsToken: string }) => useContactProposals(options({ onAddKen, grantsToken: p.grantsToken })),
      { initialProps: { grantsToken: 'g1' } },
    );
    bump = () => rerender({ grantsToken: 'g2' });

    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    });
    // The second and third outcomes were never attempted.
    expect(onAddKen).toHaveBeenCalledTimes(1);
  });

  it('closes the subscription on unmount', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    const close = vi.fn();
    vi.spyOn(relayService, 'subscribeEvents').mockReturnValue(close);
    const { unmount } = renderHook(() => useContactProposals(options()));
    await waitFor(() => expect(relayService.subscribeEvents).toHaveBeenCalled());
    unmount();
    expect(close).toHaveBeenCalled();
  });

  it('does nothing when disabled or without an encryption key', async () => {
    // R-8: `enabled` is false on a paired-child install, so a kid's device
    // never accepts an app proposal into its own dependant directory.
    await db.saveContactGrantV2(grant(), KEY);
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    renderHook(() => useContactProposals(options({ enabled: false })));
    renderHook(() => useContactProposals(options({ encryptionKey: null })));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it('passes the SDK filter through as a typed NostrFilter, tags and all', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    const fetchEvents = vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    renderHook(() => useContactProposals(options()));
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled());
    const [filters] = fetchEvents.mock.calls[0]!;
    expect(filters[0]).toEqual({
      kinds: [30078], authors: [app().activePublicKeyHex],
      '#d': [proposalTag(GRANT, app().activePublicKeyHex)], limit: 1,
    });
  });

  it('survives an undecryptable event without throwing', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    const junk = { ...(await eventFor([proposal()])), content: 'not-nip44' };
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([junk]);
    const { result } = renderHook(() => useContactProposals(options()));
    await waitFor(() => expect(result.current.lastInboxAt).not.toBeNull());
    expect(result.current.accepted).toBe(0);
  });

  // --- Fix round 1 ---

  it('serialises two live proposal events for the same grant so neither clobbers the other (R-18, C1)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    let emit: ((e: unknown) => void) | null = null;
    vi.spyOn(relayService, 'subscribeEvents').mockImplementation((_f, _r, onEvent) => {
      emit = onEvent as (e: unknown) => void;
      return () => {};
    });
    const onAddKen = vi.fn(async () => {});
    const { unmount } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(emit).not.toBeNull());

    const eventA = await eventFor([proposal({
      operationId: '1'.repeat(32), value: { pubkey: 'd'.repeat(64), displayName: 'Ada' },
    })]);
    const eventB = await eventFor([proposal({
      operationId: '2'.repeat(32), value: { pubkey: 'e'.repeat(64), displayName: 'Bea' },
    })]);
    // Dispatched back-to-back in the same tick, BEFORE either's internal
    // read→validate→apply→write chain has a chance to complete. Without R-18
    // serialisation, both would read the grant's `seenOperationIds` before
    // either wrote it back, and the second write would clobber the first's.
    emit!(eventA);
    emit!(eventB);

    // Poll the PERSISTED state rather than the callback call count — each
    // event's own write lands some time after its `onAddKen` call resolves
    // (a further queued read + write), so asserting on the call count alone
    // would race ahead of the second event's write actually landing.
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect([...(stored?.seenOperationIds ?? [])].sort()).toEqual(['1'.repeat(32), '2'.repeat(32)]);
    });
    unmount();
  });

  it('applies a live rename and a live add-ken for the same grant without either clobbering the other (R-18, C1)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    let emit: ((e: unknown) => void) | null = null;
    vi.spyOn(relayService, 'subscribeEvents').mockImplementation((_f, _r, onEvent) => {
      emit = onEvent as (e: unknown) => void;
      return () => {};
    });
    const onAddKen = vi.fn(async () => {});
    const onRenameAppLabel = vi.fn(async () => {});
    const { unmount } = renderHook(() => useContactProposals(options({ onAddKen, onRenameAppLabel })));
    await waitFor(() => expect(emit).not.toBeNull());

    const renameEvent = await eventFor([proposal({
      operationId: '3'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'Coach', updatedAt: Date.now() },
    })]);
    const addKenEvent = await eventFor([proposal({
      operationId: '4'.repeat(32), value: { pubkey: 'd'.repeat(64), displayName: 'Ada' },
    })]);
    emit!(renameEvent);
    emit!(addKenEvent);

    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect([...(stored?.seenOperationIds ?? [])].sort()).toEqual(['3'.repeat(32), '4'.repeat(32)]);
      expect(stored?.appLabels[SCOPED]?.label).toBe('Coach');
    });
    unmount();
  });

  it('keeps two grants sharing an appPubkey isolated from each other (R-18)', async () => {
    const GRANT2 = 'e'.repeat(32);
    await db.saveContactGrantV2(grant(), KEY);
    await db.saveContactGrantV2(grant({ grantId: GRANT2, directoryId: 'dependant:1' }), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([]);
    const emitters = new Map<string, (e: unknown) => void>();
    vi.spyOn(relayService, 'subscribeEvents').mockImplementation((filters, _r, onEvent) => {
      const dTag = (filters[0] as { '#d'?: string[] })['#d']?.[0];
      if (dTag) emitters.set(dTag, onEvent as (e: unknown) => void);
      return () => {};
    });
    const onAddKen = vi.fn(async () => {});
    const { unmount } = renderHook(() => useContactProposals(options({
      onAddKen,
      directoryScopedIds: async (directoryId: string) => (directoryId === 'owner'
        ? new Map([[SCOPED, 'contact-ada']])
        : new Map()),
    })));
    await waitFor(() => expect(emitters.size).toBe(2));

    const appPubkeyHex = app().activePublicKeyHex;
    const emit1 = emitters.get(proposalTag(GRANT, appPubkeyHex));
    const emit2 = emitters.get(proposalTag(GRANT2, appPubkeyHex));
    expect(emit1).toBeDefined();
    expect(emit2).toBeDefined();

    emit1!(await eventForGrant(GRANT, [proposal({ operationId: '1'.repeat(32) })]));
    emit2!(await eventForGrant(GRANT2, [proposal({
      grantId: GRANT2, operationId: '2'.repeat(32), value: { pubkey: 'e'.repeat(64), displayName: 'Bea' },
    })]));

    await waitFor(async () => {
      const g1 = await db.getContactGrantV2(GRANT, KEY);
      const g2 = await db.getContactGrantV2(GRANT2, KEY);
      expect(g1?.seenOperationIds).toEqual(['1'.repeat(32)]);
      expect(g2?.seenOperationIds).toEqual(['2'.repeat(32)]);
    });
    unmount();
  });

  it('accepts a proposal older than grant.maxStalenessSeconds but within the SDK default window (R-19, I1)', async () => {
    // grant()'s maxStalenessSeconds is 21600 (6h) — a projection-freshness
    // setting that must NOT bound proposal acceptance (R-19).
    await db.saveContactGrantV2(grant(), KEY);
    const oldCreatedAt = Math.floor(Date.now() / 1000) - 86_400; // 1 day old
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({ createdAt: oldCreatedAt })])]);
    const onAddKen = vi.fn(async () => {});
    const { unmount } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(onAddKen).toHaveBeenCalledTimes(1));
    // Poll the PERSISTED state, not just the callback count, before
    // unmounting — otherwise this event's own write (which legitimately
    // lands a moment after `onAddKen` resolves) can still be in flight when
    // the test ends, and `unmount()` cannot cancel a write already underway.
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toContain('9'.repeat(32));
    });
    unmount();
  });

  it('counts a throwing apply callback as applyFailed (not rejected) and does not remember its id (M2)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => { throw new Error('boom'); });
    const { result, unmount } = renderHook(() => useContactProposals(options({ onAddKen })));
    await waitFor(() => expect(result.current.applyFailed).toBe(1));
    expect(result.current.rejected).toBe(0);
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(stored?.seenOperationIds).toEqual([]);
    unmount();
  });

  it('does not rewrite the grant row when a batch produces no new state (M4)', async () => {
    // The batch's one proposal is already a replay (its operationId is
    // already in `seenOperationIds`), so nothing is applied — the row must
    // not be rewritten with an identical snapshot. A replay is no longer
    // counted as `rejected` (spec: the SDK resends a still-waiting
    // suggestion in every batch, so this is normal, not a refusal) — see the
    // dedicated replay test below.
    await db.saveContactGrantV2(grant({ seenOperationIds: ['9'.repeat(32)] }), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const saveSpy = vi.spyOn(db, 'saveContactGrantV2');
    const updateSpy = vi.spyOn(db, 'updateContactGrantV2');
    const { unmount } = renderHook(() => useContactProposals(options()));
    await new Promise((r) => setTimeout(r, 20));
    // Neither the retired whole-row overwrite nor the R-22 serialised updater
    // is reached: `appliedIds` is empty, so there is nothing to write at all.
    expect(saveSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('does not count a replayed operationId as rejected, but still counts a genuine refusal (spec: resend-aware counter)', async () => {
    // The SDK now resends a proposal the app is still waiting on in every
    // batch it sends, so a repeated `operationId` this device has already
    // seen is that resend, not a second refusal of the same proposal.
    // Mixed in the same batch: a genuine `capability-missing` refusal must
    // still be counted, so the fix is "exclude `replay` specifically", not
    // "stop counting rejections".
    await db.saveContactGrantV2(grant({
      seenOperationIds: ['9'.repeat(32)],
      capabilities: ['signet.contacts.propose:add-ken'],
    }), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([
      proposal(), // replay — already in seenOperationIds
      proposal({
        operationId: '8'.repeat(32), action: 'rename-app-label',
        value: { contactId: SCOPED, label: 'Coach', updatedAt: Date.now() },
      }), // capability-missing — grant has no rename capability
    ])]);
    const { result } = renderHook(() => useContactProposals(options()));
    await waitFor(() => expect(result.current.rejected).toBe(1));
    expect(result.current.accepted).toBe(0);
  });

  it('writes through the serialised updater when the batch does change state (M4 write branch)', async () => {
    // The other half of M4: a batch that genuinely moves `seenOperationIds`
    // AND `appLabels` must take the write branch, not be skipped as a no-op.
    await db.saveContactGrantV2(grant(), KEY);
    const renameUpdatedAt = Date.now();
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '7'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'Coach', updatedAt: renameUpdatedAt },
    })])]);
    const saveSpy = vi.spyOn(db, 'saveContactGrantV2');
    const updateSpy = vi.spyOn(db, 'updateContactGrantV2');
    const { unmount } = renderHook(() => useContactProposals(options()));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.appLabels[SCOPED]).toEqual({ label: 'Coach', updatedAt: renameUpdatedAt });
    });
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(stored?.seenOperationIds).toEqual(['7'.repeat(32)]);
    expect(updateSpy).toHaveBeenCalled();
    // R-22: the whole-row overwrite is gone from this path entirely.
    expect(saveSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('a concurrent foreign write to the same grant row survives this hook’s own write (R-22)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const { unmount } = renderHook(() => useContactProposals(options()));

    // A different writer (the projections hook's publish-state write, in
    // production) touching a field this hook never names, while this hook's
    // own read→apply→write pipeline is in flight. Both writes go through
    // `db.ts`'s one grant-write queue and each spreads the row as the other
    // left it, so whichever lands first, neither change is lost.
    await db.updateContactGrantV2(GRANT, KEY, (current) => ({
      ...current, lastProjectionHash: 'z'.repeat(64), lastPublishState: 'ok',
    }));

    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    });
    const stored = await db.getContactGrantV2(GRANT, KEY);
    expect(stored?.lastProjectionHash).toBe('z'.repeat(64));
    expect(stored?.lastPublishState).toBe('ok');
    unmount();
  });

  it('does not bump updatedAt for a seen-ids-only write, but does for a rename (minor 5)', async () => {
    // `updatedAt` is the grants rail's LWW clock and only moves for something
    // the rail actually carries. `seenOperationIds` is device-local and
    // excluded from the wire, so remembering a replay guard must not let this
    // device win every LWW comparison and revert another device's rename.
    await db.saveContactGrantV2(grant({ updatedAt: 42 }), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const { unmount } = renderHook(() => useContactProposals(options()));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    });
    expect((await db.getContactGrantV2(GRANT, KEY))?.updatedAt).toBe(42);
    unmount();
  });

  it('bumps updatedAt when a rename changes appLabels (minor 5, the other half)', async () => {
    await db.saveContactGrantV2(grant({ updatedAt: 42 }), KEY);
    const renameUpdatedAt = Date.now();
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal({
      operationId: '4'.repeat(32), action: 'rename-app-label',
      value: { contactId: SCOPED, label: 'Coach', updatedAt: renameUpdatedAt },
    })])]);
    const { unmount } = renderHook(() => useContactProposals(options()));
    await waitFor(async () => {
      const stored = await db.getContactGrantV2(GRANT, KEY);
      expect(stored?.appLabels[SCOPED]?.label).toBe('Coach');
    });
    // A rename IS on the wire, so it earns a clock the other device can lose to.
    expect((await db.getContactGrantV2(GRANT, KEY))?.updatedAt).toBeGreaterThan(42);
    unmount();
  });

  it('counts a throwing directoryScopedIds as an apply failure instead of rejecting the queued task (item 7)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    vi.spyOn(relayService, 'fetchEvents').mockResolvedValue([await eventFor([proposal()])]);
    const onAddKen = vi.fn(async () => {});
    const { result, unmount } = renderHook(() => useContactProposals(options({
      directoryScopedIds: async () => { throw new Error('directory not loaded'); },
      onAddKen,
    })));
    await waitFor(() => expect(result.current.applyFailed).toBe(1));
    expect(result.current.rejected).toBe(0);
    expect(onAddKen).not.toHaveBeenCalled();
    // Nothing was applied, so nothing is remembered — a later re-delivery
    // retries the whole event.
    expect((await db.getContactGrantV2(GRANT, KEY))?.seenOperationIds).toEqual([]);
    unmount();
  });
});
