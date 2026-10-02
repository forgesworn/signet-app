// @vitest-environment jsdom
/**
 * A Nostr-follows import is the biggest single write the contacts log takes,
 * so this suite drives it through the rail's REAL publish path (real
 * `publishContactsV2Checkpoint`, real chunker, real vault envelope — only the
 * relay transport, the signer and the checkpoint fetch are stubbed) and checks
 * the checkpoint that comes out carries every operation, with `backupState`
 * still `'ok'`.
 *
 * A second file from `useContactsV2Sync.test.ts` on purpose: that one mocks
 * the publish functions, this one must not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { NostrEvent } from 'signet-protocol';

vi.mock('../lib/contacts-v2-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/contacts-v2-sync')>();
  return { ...actual, fetchContactsV2Sync: vi.fn() };
});
const published = vi.hoisted(() => ({ events: [] as { content: string; tags: string[][] }[] }));
vi.mock('../lib/sync-relays', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync-relays')>();
  return {
    ...actual,
    publishToRelays: vi.fn(async (event: { content: string; tags: string[][] }) => { published.events.push(event); return true; }),
  };
});

import {
  fetchContactsV2Sync,
  parseCheckpointPayload,
  parseChunkPayload,
  parseManifest,
  reassembleChunks,
  tagFor,
  MAX_OPS_PER_PAYLOAD,
  type ReceivedChunk,
} from '../lib/contacts-v2-sync';
import { openVaultPayloadOrThrow } from '../lib/vault-envelope';
import { purgeAllUserData, saveContactOperationsV2, listAllContactOperationsV2, listContactOperationsV2 } from '../lib/db';
import { planFollowsImport } from '../lib/contacts-v2-follows-import';
import { createNewIdentity } from '../lib/signet';
import type { ContactOperation, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useContactsV2Sync } from './useContactsV2Sync';
import { useContactsV2 } from './useContactsV2';
import { resetPendingPublishesForTests } from '../lib/pending-publish';

const mockFetch = vi.mocked(fetchContactsV2Sync);
const RELAYS = { read: ['wss://relay.example.com'], write: ['wss://relay.example.com'] };
const KEY = 'a'.repeat(64);
const DEVICE = 'd'.repeat(32);
const LIST = '1'.repeat(64);
const actor = { actorPubkey: LIST, actorRole: 'owner' as const, actorDeviceId: DEVICE };

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;

beforeEach(async () => {
  await purgeAllUserData();
  published.events = [];
  mockFetch.mockReset();
  resetPendingPublishesForTests();
  identity = createNewIdentity('Owner', 'natural-person', false);
  backend = {
    type: 'local',
    activePublicKeyHex: identity.naturalPerson.publicKey,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'f'.repeat(64), sig: 's'.repeat(128) }) as unknown as NostrEvent,
    nip44Encrypt: async (_to: string, plaintext: string) => plaintext,
    nip44Decrypt: async (_from: string, ciphertext: string) => ciphertext,
    destroy: () => undefined,
  } as unknown as DecryptingSigningBackend;
});
afterEach(() => { resetPendingPublishesForTests(); });

function followEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    pubkey: 'f' + (i + 1).toString(16).padStart(63, '0'),
    displayName: `Contact number ${i} (display name)`,
  }));
}

function renderRail(over: { maxOutboxOps?: number } = {}) {
  return renderHook(() => useContactsV2Sync({
    identity, npBackend: backend, relays: RELAYS, encryptionKey: KEY, deviceId: DEVICE,
    opsVersion: 1, random: () => 0, publishDelayMs: 5, ...over,
  }));
}

/** The manifest is published LAST, so its tag appearing means every chunk is out. */
async function waitForCheckpoint() {
  const tag = tagFor(identity.naturalPerson.publicKey, 'checkpoint');
  await waitFor(() => expect(published.events.some(e => e.tags[0][1] === tag)).toBe(true), { timeout: 30_000 });
}

/** Open every published event and rebuild the checkpoint's operations. */
async function publishedCheckpointOps(): Promise<ContactOperation[]> {
  const author = identity.naturalPerson.publicKey;
  const byTag = new Map<string, string>();
  for (const e of published.events) byTag.set(e.tags[0][1], e.content);
  const openBackend = { nip44Decrypt: backend.nip44Decrypt } as never;
  const cpContent = byTag.get(tagFor(author, 'checkpoint'));
  expect(cpContent).toBeDefined();
  const plain = await openVaultPayloadOrThrow(cpContent!, openBackend, author);
  const single = parseCheckpointPayload(plain);
  if (single) return single.ops;
  const manifest = parseManifest(plain);
  expect(manifest).not.toBeNull();
  const received: ReceivedChunk[] = [];
  for (const tag of manifest!.chunkTags) {
    const chunkPlain = await openVaultPayloadOrThrow(byTag.get(tag)!, openBackend, author);
    const payload = parseChunkPayload(chunkPlain);
    expect(payload).not.toBeNull();
    received.push({ payload: payload!, plaintext: chunkPlain });
  }
  const ops = reassembleChunks(manifest!, received);
  expect(ops).not.toBeNull();
  return ops!;
}

describe('a Nostr-follows import through the contacts rail', () => {
  it('1000 follows (3000 ops, past one outbox) publish as ONE checkpoint holding every op, backupState ok', async () => {
    // The plan with the size line lifted: the rail's own limits are what is under test.
    const plan = planFollowsImport({
      entries: followEntries(1000), ownerIdentityPubkey: LIST, originMethod: 'import', caption: 'Nostr follows',
      directoryId: 'owner', records: [], actor, baseClock: 0, now: Date.now(), wholeLog: [],
      lineBytes: 1e12, lineOps: 1e9,
    });
    expect(plan.ops).toHaveLength(3000);
    expect(plan.ops.length).toBeGreaterThan(MAX_OPS_PER_PAYLOAD);
    await saveContactOperationsV2(plan.ops, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    const { result } = renderRail();
    await waitForCheckpoint();
    expect(result.current.backupState).toBe('ok');

    const ops = await publishedCheckpointOps();
    expect(ops).toHaveLength(3000);
    expect(new Set(ops.map(o => o.operationId))).toEqual(new Set(plan.ops.map(o => o.operationId)));
    // The oversize outbox never blocked the checkpoint (and was not sent at all).
    expect(published.events.some(e => e.tags[0][1] === tagFor(identity.naturalPerson.publicKey, 'outbox', DEVICE))).toBe(false);
  }, 60_000);

  it('an import through useContactsV2.recogniseContacts, then the rail, backs up every op it wrote', async () => {
    const { result: contacts } = renderHook(() => useContactsV2({
      directoryId: 'owner', encryptionKey: KEY, ownerIdentityPubkey: LIST, actor,
      context: { activeGuardianPubkeys: [], defaultChildCeiling: 'ken', directoryIsDependant: false },
    }));
    await waitFor(() => expect(contacts.current.loading).toBe(false));
    let summary!: Awaited<ReturnType<typeof contacts.current.recogniseContacts>>;
    await act(async () => { summary = await contacts.current.recogniseContacts(followEntries(1000), LIST, 'import', 'Nostr follows'); });
    // 1000 do not fit under the 1.5 MiB line: the most recent ~900-950 are imported.
    expect(summary.requested).toBe(1000);
    expect(summary.trimmed).toBe(true);
    expect(summary.covered).toBeGreaterThan(800);
    expect(summary.covered).toBeLessThan(1000);
    expect(summary.added).toBe(summary.covered);

    const saved = await listContactOperationsV2('owner', KEY);
    expect(saved).toHaveLength(summary.added * 3);
    // One contiguous clock range.
    const clocks = saved.map(o => o.logicalClock).sort((a, b) => a - b);
    expect(clocks[clocks.length - 1] - clocks[0]).toBe(saved.length - 1);

    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });
    const { result: rail } = renderRail();
    await waitForCheckpoint();
    expect(rail.current.backupState).toBe('ok');
    const ops = await publishedCheckpointOps();
    expect(ops).toHaveLength(saved.length);
    expect(new Set(ops.map(o => o.operationId))).toEqual(new Set(saved.map(o => o.operationId)));
    expect((await listAllContactOperationsV2(KEY)).length).toBe(saved.length);
  }, 90_000);

  it('the one state that CAN block it: an unreadable remote checkpoint plus an outbox past one envelope reports stalled', async () => {
    const plan = planFollowsImport({
      entries: followEntries(700), ownerIdentityPubkey: LIST, originMethod: 'import', caption: 'Nostr follows',
      directoryId: 'owner', records: [], actor, baseClock: 0, now: Date.now(), wholeLog: [],
    });
    expect(plan.ops.length).toBeGreaterThan(MAX_OPS_PER_PAYLOAD);
    await saveContactOperationsV2(plan.ops, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'unusable', reachableRelays: 1 });

    const { result } = renderRail();
    await waitFor(() => expect(result.current.backupState).toBe('stalled'), { timeout: 30_000 });
    expect(published.events).toHaveLength(0);
  }, 60_000);
});
