// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock the fetch/publish legs, keep the real merge/wire helpers — same
// posture as useContactsV2Sync.test.ts. The rail logic has its own suite
// (contacts-v2-grants-rail.test.ts); reusing the real `mergeGrantRegistry` /
// `toWireGrant` here keeps this test honest about what the hook actually does
// with them.
vi.mock('../lib/contacts-v2-grants-rail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/contacts-v2-grants-rail')>();
  return {
    ...actual,
    fetchGrantsV2: vi.fn(),
    publishGrantsV2: vi.fn(),
  };
});

import { fetchGrantsV2, publishGrantsV2, toWireGrant } from '../lib/contacts-v2-grants-rail';
import * as db from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import type { AppGrantV2 } from '../types';
import { useContactGrantsRail } from './useContactGrantsRail';

const mockFetch = vi.mocked(fetchGrantsV2);
const mockPublish = vi.mocked(publishGrantsV2);

const OWNER_SK = 'd'.repeat(63) + '1';
const KEY = 'a'.repeat(64);
const RELAYS = { read: ['wss://r.example'], write: ['wss://r.example'] };

function makeBackend(): DecryptingSigningBackend {
  return new LocalSigningBackend(OWNER_SK);
}

function grant(over: Partial<AppGrantV2> = {}): AppGrantV2 {
  return {
    grantId: 'f'.repeat(32), directoryId: 'owner', appPubkey: 'a'.repeat(64),
    createdAt: 100, updatedAt: 100, appName: 'Flock',
    capabilities: ['signet.contacts.read:directory'],
    railPubkey: 'b'.repeat(64), railPrivateKey: 'c'.repeat(64), relay: 'wss://r.example',
    maxStalenessSeconds: 21600, appLabels: {}, seenOperationIds: [], ...over,
  };
}

async function realWait(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let onMerged: ReturnType<typeof vi.fn>;
// A STABLE reference, set once per test — created fresh inside the render
// callback it would get a new identity on every re-render (the effects key
// off `backend` by reference, same as `useContactsV2Sync`'s `npBackend`),
// which would spuriously re-run the fetch effect and reset `hydrated`.
let backend: DecryptingSigningBackend;

beforeEach(async () => {
  await db.purgeAllUserData();
  mockFetch.mockReset().mockResolvedValue({ payload: null, remoteState: 'never-seen' });
  mockPublish.mockReset().mockResolvedValue('published');
  onMerged = vi.fn();
  backend = makeBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface RenderProps {
  publishExcludedDirectories?: string[];
  enabled?: boolean;
  encryptionKey?: string | null;
  backend?: DecryptingSigningBackend | null;
  relays?: { read: string[]; write: string[] };
  grantsVersion?: number;
  publishDelayMs?: number;
  onBackupStateChange?: (state: 'ok' | 'too-large') => void;
}

/**
 * One render helper, parameterised by `rerender(props)` rather than a family
 * of single-purpose wrappers, mirroring `useContactsV2Sync.test.ts`'s
 * `renderPublishSync`. `'backend' in p`/`'encryptionKey' in p` distinguish
 * "not passed, use the default" from "explicitly passed null".
 */
function renderRail(initial: RenderProps = {}) {
  return renderHook((p: RenderProps) => useContactGrantsRail({
    enabled: p.enabled ?? true,
    publishExcludedDirectories: p.publishExcludedDirectories,
    encryptionKey: 'encryptionKey' in p ? (p.encryptionKey ?? null) : KEY,
    backend: 'backend' in p ? (p.backend ?? null) : backend,
    relays: p.relays ?? RELAYS,
    grantsVersion: p.grantsVersion ?? 0,
    onMerged: onMerged as unknown as () => void,
    onBackupStateChange: p.onBackupStateChange,
    random: () => 0,
    publishDelayMs: 'publishDelayMs' in p ? p.publishDelayMs : 5,
  }), { initialProps: initial });
}

describe('useContactGrantsRail — hydrate/merge', () => {
  it('writes a remote-only grant this device has never seen into contactGrantsV2', async () => {
    mockFetch.mockResolvedValue({
      payload: { v: 2, kind: 'grants', createdAt: 5, grants: [toWireGrant(grant())] },
      remoteState: 'present',
    });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(async () => {
      expect(await db.getContactGrantV2('f'.repeat(32), KEY)).toBeDefined();
    });
    expect(onMerged).toHaveBeenCalled();
  });

  it('a revocation from the other device wins over a locally-live grant', async () => {
    await db.saveContactGrantV2(grant({ updatedAt: 100 }), KEY);
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [toWireGrant(grant({ updatedAt: 200, revokedAt: 150 }))],
      },
      remoteState: 'present',
    });

    renderRail();
    await waitFor(async () => {
      const stored = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(stored?.revokedAt).toBe(150);
    });

    // The publisher's `!revokedAt` filter is what actually stops a
    // revoked grant projecting again — proving the merge lands `revokedAt`
    // locally is what makes that filter effective.
    const active = (await db.listContactGrantsV2(KEY)).filter((g) => !g.revokedAt);
    expect(active).toHaveLength(0);
  });

  it('preserves this device’s own replay memory and publish state across a merge', async () => {
    await db.saveContactGrantV2(grant({
      seenOperationIds: ['9'.repeat(32)], lastProjectionHash: 'z'.repeat(64), updatedAt: 100,
    }), KEY);
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [toWireGrant(grant({ updatedAt: 200, appName: 'New' }))],
      },
      remoteState: 'present',
    });

    renderRail();
    await waitFor(async () => {
      const stored = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(stored?.appName).toBe('New');
    });

    const stored = await db.getContactGrantV2('f'.repeat(32), KEY);
    expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    expect(stored?.lastProjectionHash).toBe('z'.repeat(64));
  });

  it('does not call onMerged when the merge produces nothing new', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    mockFetch.mockResolvedValue({
      payload: { v: 2, kind: 'grants', createdAt: 5, grants: [toWireGrant(grant())] },
      remoteState: 'present',
    });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await realWait(30);
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('a "present" fetch with a null payload (an unreadable existing event, Phase D R9) gates publish off for the cycle', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    mockFetch.mockResolvedValue({ payload: null, remoteState: 'present' });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await realWait(30);
    // The registry is reported as existing (not a missing backup — hence
    // 'present', not 'unreachable'), but nothing was actually read back, so
    // publishing this cycle could only clobber it.
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('useContactGrantsRail — publish', () => {
  it('publishes once, after the jittered delay, once hydrated', async () => {
    await db.saveContactGrantV2(grant(), KEY);

    renderRail();
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));

    const call = mockPublish.mock.calls[0][0];
    expect(call.grants.map((g) => g.grantId)).toEqual(['f'.repeat(32)]);
    expect(call.relayUrls).toEqual(RELAYS.write);

    await realWait(30);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('does not publish before hydrating', async () => {
    let resolveFetch: (v: { payload: null; remoteState: 'never-seen' }) => void = () => {};
    mockFetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    await db.saveContactGrantV2(grant(), KEY);

    renderRail();
    await realWait(30);
    expect(mockPublish).not.toHaveBeenCalled();

    resolveFetch({ payload: null, remoteState: 'never-seen' });
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
  });

  it('does not publish when the last fetch reported unreachable', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    mockFetch.mockResolvedValue({ payload: null, remoteState: 'unreachable' });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await realWait(30);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not publish an empty registry', async () => {
    const { result } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await realWait(30);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does nothing at all when enabled is false (paired-child, R-8)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    renderRail({ enabled: false });
    await realWait(30);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does nothing at all when encryptionKey is null', async () => {
    renderRail({ encryptionKey: null });
    await realWait(30);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does nothing at all when backend is null', async () => {
    renderRail({ backend: null });
    await realWait(30);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('survives a rejecting publishGrantsV2 without throwing out of the effect', async () => {
    mockPublish.mockRejectedValue(new Error('relay refused'));
    await db.saveContactGrantV2(grant(), KEY);

    renderRail();
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
    await realWait(30); // no further, unhandled rejection or crash
  });

  it('a "too-large" outcome reports backupState and leaves the hash unseeded, so it retries', async () => {
    mockPublish.mockResolvedValue('too-large');
    const onBackupStateChange = vi.fn();
    await db.saveContactGrantV2(grant(), KEY);

    const { result, rerender } = renderRail({ onBackupStateChange });
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.backupState).toBe('too-large'));
    expect(onBackupStateChange).toHaveBeenCalledWith('too-large');

    // Unseeded hash: bumping grantsVersion re-arms the SAME hook instance's
    // publish effect, and it tries again with the identical content — proof
    // 'too-large' never poisoned the dedupe hash the way a successful
    // publish would have.
    rerender({ onBackupStateChange, grantsVersion: 1 });
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(2));
  });

  it('a "published" outcome clears a prior too-large backupState', async () => {
    mockPublish.mockResolvedValueOnce('too-large').mockResolvedValueOnce('published');
    await db.saveContactGrantV2(grant(), KEY);

    const { result, rerender } = renderRail();
    await waitFor(() => expect(result.current.backupState).toBe('too-large'));

    // A local change (grantsVersion bump) re-arms the debounce; this time the
    // outcome is 'published'.
    rerender({ grantsVersion: 1 });
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.backupState).toBe('ok'));
  });

  it('an "empty" outcome is a no-op — no crash, no hash seeded, no backupState change', async () => {
    mockPublish.mockResolvedValue('empty');
    await db.saveContactGrantV2(grant(), KEY);

    const { result } = renderRail();
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
    await realWait(30);
    expect(result.current.backupState).toBe('ok');
  });

  it('passes SECONDS, not milliseconds, as the publish clock (item 10)', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    renderRail();
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
    const { now } = mockPublish.mock.calls[0][0];
    // A NIP-01 `created_at`: plausible Unix seconds, never a ms epoch (~1.7e12).
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeLessThan(1e11);
    expect(Math.abs(now - Math.floor(Date.now() / 1000))).toBeLessThan(120);
  });
});

describe('useContactGrantsRail — R-23/R-25/R-26', () => {
  it('R-23: a local grant a newer remote payload would have evicted still survives in IndexedDB', async () => {
    // This device is full: `CONTACT_GRANT_V2_CAP` local active grants, all
    // OLDER than what the relay is about to offer. Before R-23 the merge
    // capped its own output, so the two oldest local rows were dropped from
    // the merged set — and, never written back, effectively deleted along
    // with the only copy of their rail private keys.
    const locals = Array.from({ length: 10 }, (_, i) => grant({
      grantId: i.toString(16).padStart(32, '0'),
      appPubkey: i.toString(16).padStart(64, '0'),
      updatedAt: 100 + i,
    }));
    for (const g of locals) await db.saveContactGrantV2(g, KEY);

    // The relay offers two MORE actives, newer than anything local.
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [
          toWireGrant(grant({ grantId: 'a'.repeat(32), appPubkey: 'a'.repeat(64), updatedAt: 9_000 })),
          toWireGrant(grant({ grantId: 'b'.repeat(32), appPubkey: 'b'.repeat(64), updatedAt: 9_001 })),
        ],
      },
      remoteState: 'present',
    });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await realWait(30);

    // Every local row is still there — none was evicted to make room for a
    // newer remote one.
    const stored = await db.listContactGrantsV2(KEY);
    expect(stored).toHaveLength(10);
    for (const g of locals) {
      expect(stored.some((s) => s.grantId === g.grantId)).toBe(true);
    }
    // And the two the relay offered are reported, not silently dropped.
    await waitFor(() => expect(result.current.skippedRemote).toBe(2));
  });

  it('R-26: adopts up to the cap and reports the rest as skippedRemote', async () => {
    for (let i = 0; i < 8; i += 1) {
      await db.saveContactGrantV2(grant({
        grantId: i.toString(16).padStart(32, '0'),
        appPubkey: i.toString(16).padStart(64, '0'),
        updatedAt: 100 + i,
      }), KEY);
    }
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: Array.from({ length: 5 }, (_, i) => toWireGrant(grant({
          grantId: (i + 100).toString(16).padStart(32, '0'),
          appPubkey: (i + 100).toString(16).padStart(64, '0'),
          updatedAt: 9_000 + i,
        }))),
      },
      remoteState: 'present',
    });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.skippedRemote).toBe(3));
    const stored = await db.listContactGrantsV2(KEY);
    expect(stored).toHaveLength(10);
    // The two newest remote grants are the ones adopted.
    expect(stored.some((g) => g.grantId === (104).toString(16).padStart(32, '0'))).toBe(true);
    expect(stored.some((g) => g.grantId === (103).toString(16).padStart(32, '0'))).toBe(true);
  });

  it('clears skippedRemote when a later fetch yields no payload at all (minor 4)', async () => {
    for (let i = 0; i < 10; i += 1) {
      await db.saveContactGrantV2(grant({
        grantId: i.toString(16).padStart(32, '0'),
        appPubkey: i.toString(16).padStart(64, '0'),
        updatedAt: 100 + i,
      }), KEY);
    }
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [toWireGrant(grant({ grantId: 'a'.repeat(32), appPubkey: 'a'.repeat(64), updatedAt: 9_000 }))],
      },
      remoteState: 'present',
    });

    const { result, rerender } = renderRail();
    await waitFor(() => expect(result.current.skippedRemote).toBe(1));

    // The relay goes quiet. `skippedRemote` describes what THIS fetch's
    // payload could not be adopted from; with no payload there is nothing to
    // report, and a stale count would go on claiming an app was turned away
    // long after the evidence stopped arriving.
    mockFetch.mockResolvedValue({ payload: null, remoteState: 'unreachable' });
    rerender({ relays: { read: ['wss://other.example'], write: RELAYS.write } });
    await waitFor(() => expect(result.current.skippedRemote).toBe(0));
  });

  it('preserves lastProjectionAt, lastPublishState and appLabels through a merge', async () => {
    const label: AppGrantV2['appLabels'] = { ['a'.repeat(32)]: { label: 'Coach', updatedAt: 50 } };
    await db.saveContactGrantV2(grant({
      updatedAt: 100,
      seenOperationIds: ['9'.repeat(32)],
      lastProjectionHash: 'z'.repeat(64),
      lastProjectionAt: 77,
      lastPublishState: 'truncated',
      appLabels: label,
    }), KEY);
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [toWireGrant(grant({ updatedAt: 200, appName: 'New' }))],
      },
      remoteState: 'present',
    });

    renderRail();
    await waitFor(async () => {
      expect((await db.getContactGrantV2('f'.repeat(32), KEY))?.appName).toBe('New');
    });

    const stored = await db.getContactGrantV2('f'.repeat(32), KEY);
    expect(stored?.seenOperationIds).toEqual(['9'.repeat(32)]);
    expect(stored?.lastProjectionHash).toBe('z'.repeat(64));
    expect(stored?.lastProjectionAt).toBe(77);
    expect(stored?.lastPublishState).toBe('truncated');
    // The label the remote never carried is unioned in, not dropped.
    expect(stored?.appLabels['a'.repeat(32)]).toEqual({ label: 'Coach', updatedAt: 50 });
  });

  it('R-25: does not republish when the remote carries a revoked row this device never adopted', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    mockFetch.mockResolvedValue({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [
          toWireGrant(grant()),
          // R-21: never adopted, so the merged registry is DIFFERENT from the
          // remote one — but poorer, not richer. Republishing would overwrite
          // the relay's record of the revocation, and flap every app start.
          toWireGrant(grant({ grantId: 'e'.repeat(32), appPubkey: 'e'.repeat(64), revokedAt: 500 })),
        ],
      },
      remoteState: 'present',
    });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await realWait(60);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('R-25: does republish when this device holds a revocation the remote lacks', async () => {
    await db.saveContactGrantV2(grant({ revokedAt: 400, updatedAt: 100 }), KEY);
    mockFetch.mockResolvedValue({
      payload: { v: 2, kind: 'grants', createdAt: 5, grants: [toWireGrant(grant({ updatedAt: 100 }))] },
      remoteState: 'present',
    });

    renderRail();
    await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
  });

  it('a merged registry identical to the remote one is not republished', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    mockFetch.mockResolvedValue({
      payload: { v: 2, kind: 'grants', createdAt: 5, grants: [toWireGrant(grant())] },
      remoteState: 'present',
    });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await realWait(60);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('a device-local projection write does not change the grants wire hash', async () => {
    await db.saveContactGrantV2(grant(), KEY);
    mockFetch.mockResolvedValue({
      payload: { v: 2, kind: 'grants', createdAt: 5, grants: [toWireGrant(grant())] },
      remoteState: 'present',
    });

    const { result, rerender } = renderRail();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await realWait(30);
    expect(mockPublish).not.toHaveBeenCalled();

    // A projection publish writes only device-local fields. Those are excluded
    // from `WireGrantV2` by type, so the dedupe hash is unmoved and the rail
    // stays quiet — a projection must not cost a grants-registry republish.
    await db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
      ...current, lastProjectionHash: 'z'.repeat(64), lastProjectionAt: 99, lastPublishState: 'ok',
    }));
    rerender({ grantsVersion: 1 });
    await realWait(60);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // Item 10 moved the `cancelled` checks ABOVE each save, so a run whose
  // effect has been cleaned up writes nothing at all. This proves the whole
  // route: a fetch that only resolves after cleanup lands nothing in storage.
  it('a stale write cannot land after the fetch effect is cancelled (item 10)', async () => {
    await db.saveContactGrantV2(grant({ updatedAt: 100 }), KEY);
    let resolveFetch!: (v: Awaited<ReturnType<typeof fetchGrantsV2>>) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const { unmount } = renderRail();
    await realWait(20);
    unmount();

    // The fetch resolves only AFTER the effect has been cleaned up: the
    // `cancelled` checks now sit ABOVE each save, so nothing from this run
    // reaches storage.
    resolveFetch({
      payload: {
        v: 2, kind: 'grants', createdAt: 5,
        grants: [toWireGrant(grant({ updatedAt: 999, appName: 'Should not land' }))],
      },
      remoteState: 'present',
    });
    await realWait(60);

    expect((await db.getContactGrantV2('f'.repeat(32), KEY))?.appName).toBe('Flock');
  });

  it('a readable registry on fetch resets backupState back to ok', async () => {
    mockPublish.mockResolvedValue('too-large');
    await db.saveContactGrantV2(grant(), KEY);
    const { result, rerender } = renderRail();
    await waitFor(() => expect(result.current.backupState).toBe('too-large'));

    // Also flip the publish mock to 'published' — otherwise the publish
    // effect re-firing off the SAME re-run (hydrated/remoteState are also in
    // its deps) would race the fetch's own reset back to 'too-large' a few
    // ms later, which is not what this test is isolating.
    mockPublish.mockResolvedValue('published');
    mockFetch.mockResolvedValue({
      payload: { v: 2, kind: 'grants', createdAt: 9, grants: [toWireGrant(grant())] },
      remoteState: 'present',
    });
    rerender({ relays: { read: ['wss://other.example'], write: RELAYS.write } });
    await waitFor(() => expect(result.current.backupState).toBe('ok'));
  });
});


it('publishes imported directories while retaining migrated grants locally', async () => {
  const imported = grant({ grantId: 'e'.repeat(32), directoryId: `dependant:${'9'.repeat(64)}` });
  await db.saveContactGrantV2(grant(), KEY);
  await db.saveContactGrantV2(imported, KEY);
  const { unmount } = renderRail({ publishExcludedDirectories: ['owner'] });
  await waitFor(() => expect(mockPublish).toHaveBeenCalled());
  expect(mockPublish.mock.calls[0][0].grants.map(g => g.grantId)).toEqual([imported.grantId]);
  expect(await db.getContactGrantV2('f'.repeat(32), KEY)).toBeDefined();
  expect(mockFetch).toHaveBeenCalled();
  unmount();
});
