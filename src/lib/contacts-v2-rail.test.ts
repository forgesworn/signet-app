import { describe, it, expect, vi, beforeEach } from 'vitest';

const relayMock = vi.hoisted(() => ({
  // F1: `pubkey` is optional and, when a seeded event sets it, overrides the
  // mock's default "answer with whatever author the filter asked for" — the
  // only way to prove `fetchNewestFromRelays`'s author pin actually drops a
  // foreign-authored event at THIS layer, rather than the mock incidentally
  // always answering honestly.
  fetchReturns: {} as Record<string, Array<{ id: string; created_at: number; content: string; tags?: string[][]; pubkey?: string }>>,
  fetchThrows: new Set<string>(),
  published: [] as Array<{ url: string; dTag: string; content: string; createdAt: number }>,
  publishOk: {} as Record<string, boolean>,
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      url: string;
      constructor(url: string) { this.url = url; }
      async connect(): Promise<void> {
        if (relayMock.fetchThrows.has(this.url)) throw new Error('connect failed');
      }
      async fetch(filters: Array<{ authors?: string[]; '#d'?: string[] }>) {
        const author = filters?.[0]?.authors?.[0];
        const want = filters?.[0]?.['#d']?.[0];
        return (relayMock.fetchReturns[this.url] ?? [])
          .filter((e) => !want || (e.tags ?? []).some(([k, v]) => k === 'd' && v === want))
          .map((e) => ({ pubkey: author, ...e }));
      }
      async publish(ev: { id: string; content: string; tags: string[][]; created_at: number }): Promise<{ ok: boolean }> {
        const dTag = (ev.tags.find(([k]) => k === 'd') ?? ['d', ''])[1];
        relayMock.published.push({ url: this.url, dTag, content: ev.content, createdAt: ev.created_at });
        return { ok: relayMock.publishOk[this.url] ?? true };
      }
      disconnect(): void {}
    },
  };
});

beforeEach(() => {
  relayMock.fetchReturns = {};
  relayMock.fetchThrows = new Set();
  relayMock.published = [];
  relayMock.publishOk = {};
  seq = 0;
});

import {
  CONTACTS_V2_KIND,
  MAX_OPS_PER_PAYLOAD,
  MAX_DEVICE_IDS,
  tagFor,
  chunkExtra,
  chunkDigest,
  nextEventCreatedAt,
  publishContactsV2Outbox,
  publishContactsV2Checkpoint,
  parseOutboxPayload,
  parseCheckpointPayload,
  parseManifest,
  fetchContactsV2Sync,
  parseChunkPayload,
} from './contacts-v2-sync';
import { openVaultPayload, sealVaultPayload } from './vault-envelope';
import { applyOperations, recordKey } from './contacts-v2-reducer';
import type { ContactOperation } from '../types';

const AUTHOR = 'a'.repeat(64);
const DEVICE_A = '1'.repeat(32);
const DEVICE_B = '2'.repeat(32);
const RELAY = 'wss://a.example';
const CID = '0'.repeat(32);

let seq = 0;
function opId(): string {
  seq += 1;
  return seq.toString(16).padStart(32, '0');
}

function op(overrides: Partial<ContactOperation> = {}): ContactOperation {
  return {
    operationId: opId(),
    directoryId: 'owner',
    contactId: CID,
    actorPubkey: AUTHOR,
    actorRole: 'owner',
    actorDeviceId: DEVICE_A,
    logicalClock: 1,
    action: 'add',
    value: { type: 'person', displayName: 'Dave', tier: 'kith' },
    createdAt: 1_000,
    ...overrides,
  };
}

/**
 * Seed a relay's mock event list with a `d`-tagged event: the fetch leg of
 * `fetchContactsV2Sync` and friends. `id` defaults to a deterministic, unique
 * string derived from the tag/`createdAt`/insertion order — any string is a
 * valid event id in this mock, and tests that care about a specific id (the
 * decrypt-cache test) pass one explicitly.
 */
function seed(url: string, dTag: string, content: string, createdAt: number, id?: string, pubkey?: string): void {
  const list = relayMock.fetchReturns[url] ?? (relayMock.fetchReturns[url] = []);
  list.push({
    id: id ?? `${dTag}:${createdAt}:${list.length}`,
    created_at: createdAt,
    content,
    tags: [['d', dTag]],
    ...(pubkey ? { pubkey } : {}),
  });
}

/**
 * The visible `ENC(...)` wrapper is fine on THIS rail, unlike the legacy rail
 * suites: the contacts v2 tags are opened with `{ legacyFallback: false }`, so
 * nothing here ever goes down the NIP-44-shape-gated fallback path — the only
 * ciphertext this backend is ever handed is a v2 envelope's `k` field.
 */
function makeBackend(pubkey = AUTHOR) {
  return {
    activePublicKeyHex: pubkey,
    type: 'local',
    nip44Encrypt: vi.fn(async (_p: string, plaintext: string) => `ENC(${plaintext})`),
    nip44Decrypt: vi.fn(async (_p: string, ciphertext: string) => {
      if (!ciphertext.startsWith('ENC(') || !ciphertext.endsWith(')')) throw new Error('not our ciphertext');
      return ciphertext.slice(4, -1);
    }),
    signEvent: vi.fn(async (ev: Record<string, unknown>) => ({ ...ev, id: `${Math.random()}`.padEnd(64, '0').slice(0, 64), sig: 's'.repeat(128) })),
  } as never;
}

describe('nextEventCreatedAt', () => {
  it('is strictly monotonic, so a same-second retry is never resolved by lowest id', () => {
    // Relays resolve two replaceable events with the SAME `created_at` by
    // lowest event id, not by latest write — so a retry inside one second
    // could lose to the event it was meant to replace (S12).
    // Far beyond any real wall clock, so this case is unaffected by publishes
    // elsewhere in the file having already advanced the module's ref.
    const now = 4_000_000_000;
    const first = nextEventCreatedAt(now);
    const second = nextEventCreatedAt(now);
    const third = nextEventCreatedAt(now);
    expect(second).toBe(first + 1);
    expect(third).toBe(second + 1);
    // A genuinely later wall clock still wins.
    expect(nextEventCreatedAt(now + 1000)).toBe(now + 1000);
  });
});

describe('publishContactsV2Outbox', () => {
  it('publishes a sealed outbox under the deterministic outbox tag', async () => {
    const backend = makeBackend();
    const ops = [op()];
    expect(await publishContactsV2Outbox({ deviceId: DEVICE_A, ops, baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] })).toBe(true);
    expect(relayMock.published).toHaveLength(1);
    expect(relayMock.published[0].dTag).toBe(tagFor(AUTHOR, 'outbox', DEVICE_A));

    const plaintext = (await openVaultPayload(relayMock.published[0].content, backend, AUTHOR))!;
    const parsed = parseOutboxPayload(plaintext)!;
    expect(parsed.deviceId).toBe(DEVICE_A);
    expect(parsed.ops).toEqual(ops);
    expect(CONTACTS_V2_KIND).toBe(30078);
  });

  it('refuses an information-free publish without touching a relay', async () => {
    const backend = makeBackend();
    expect(await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] })).toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });

  it('refuses an invalid device id, an empty relay pool and an over-cap payload', async () => {
    const backend = makeBackend();
    expect(await publishContactsV2Outbox({ deviceId: 'nope', ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] })).toBe(false);
    expect(await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: ['http://plain.example'] })).toBe(false);
    const many = Array.from({ length: MAX_OPS_PER_PAYLOAD + 1 }, () => op());
    expect(await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: many, baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] })).toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });

  it('reports false when every relay rejects it', async () => {
    const backend = makeBackend();
    relayMock.publishOk[RELAY] = false;
    expect(await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] })).toBe(false);
  });

  it('stamps a strictly increasing created_at across back-to-back publishes', async () => {
    const backend = makeBackend();
    await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    expect(relayMock.published[1].createdAt).toBeGreaterThan(relayMock.published[0].createdAt);
  });

  it('refuses a non-lowercase author', async () => {
    const backend = makeBackend(AUTHOR.toUpperCase());
    // §3.10: one spelling. `HEX64` is strict lowercase, so an upper-case
    // pubkey is refused rather than silently producing a second tag namespace.
    expect(await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] })).toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });

  it('resolves false, never rejects, when a connected signer declines to sign', async () => {
    const backend = makeBackend();
    (backend as { signEvent: ReturnType<typeof vi.fn> }).signEvent.mockRejectedValueOnce(new Error('bunker declined'));
    const p = publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    await expect(p).resolves.toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });

  it('resolves false, never rejects, when a connected signer declines to encrypt', async () => {
    const backend = makeBackend();
    (backend as { nip44Encrypt: ReturnType<typeof vi.fn> }).nip44Encrypt.mockRejectedValueOnce(new Error('bunker declined'));
    const p = publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    await expect(p).resolves.toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });
});

describe('publishContactsV2Checkpoint', () => {
  it('publishes one sealed checkpoint under the checkpoint tag, with a derived frontier', async () => {
    const backend = makeBackend();
    const ops = [op({ logicalClock: 1 }), op({ logicalClock: 4 })];
    const ok = await publishContactsV2Checkpoint({
      seq: 1, deviceIds: [DEVICE_A], ops, now: 1_700_000_000_000, backend, relayUrls: [RELAY],
    });
    expect(ok).toBe(true);
    expect(relayMock.published).toHaveLength(1);
    expect(relayMock.published[0].dTag).toBe(tagFor(AUTHOR, 'checkpoint'));

    const parsed = parseCheckpointPayload((await openVaultPayload(relayMock.published[0].content, backend, AUTHOR))!)!;
    expect(parsed.seq).toBe(1);
    expect(parsed.createdAt).toBe(1_700_000_000_000);
    expect(parsed.deviceIds).toEqual([DEVICE_A]);
    expect(parsed.frontier.maxClock).toBe(4);
    expect(parsed.frontier.opIds.sort()).toEqual(ops.map((o) => o.operationId).sort());
    expect(parsed.ops).toEqual(ops);
  });

  it('refuses a zero-operation checkpoint and an unreachable pool without touching a relay', async () => {
    const backend = makeBackend();
    expect(await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A], ops: [], now: 1, backend, relayUrls: [RELAY] })).toBe(false);
    expect(await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A], ops: [op()], now: 1, backend, relayUrls: [] })).toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });

  it('takes the merged device list verbatim and refuses anything the merge would not produce (R7)', async () => {
    const backend = makeBackend();
    const overCap = Array.from({ length: MAX_DEVICE_IDS + 1 }, (_, i) => i.toString(16).padStart(32, '0'));
    // No silent re-cap here: `mergeDeviceIds` is the ONE policy, and a
    // `slice(0, MAX_DEVICE_IDS)` would drop the local device it deliberately
    // put last.
    expect(await publishContactsV2Checkpoint({ seq: 1, deviceIds: overCap, ops: [op()], now: 1, backend, relayUrls: [RELAY] })).toBe(false);
    expect(await publishContactsV2Checkpoint({ seq: 1, deviceIds: ['not-hex'], ops: [op()], now: 1, backend, relayUrls: [RELAY] })).toBe(false);
    expect(await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A, DEVICE_A], ops: [op()], now: 1, backend, relayUrls: [RELAY] })).toBe(false);
    expect(relayMock.published).toHaveLength(0);
    // The list `mergeDeviceIds` actually produces is accepted unchanged.
    expect(await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A, DEVICE_B], ops: [op()], now: 1, backend, relayUrls: [RELAY] })).toBe(true);
    const parsed = parseCheckpointPayload((await openVaultPayload(relayMock.published[0].content, backend, AUTHOR))!)!;
    expect(parsed.deviceIds).toEqual([DEVICE_A, DEVICE_B]);
  });

  it('builds the unchunked checkpoint through the same event builder as everything else (P14)', async () => {
    const backend = makeBackend();
    await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A], ops: [op()], now: 1, backend, relayUrls: [RELAY] });
    await publishContactsV2Checkpoint({ seq: 2, deviceIds: [DEVICE_A], ops: [op()], now: 1, backend, relayUrls: [RELAY] });
    // Monotonic `created_at` is `publishSealed`'s behaviour; seeing it here is
    // what proves the non-chunked path did not re-implement the builder.
    expect(relayMock.published[1].createdAt).toBeGreaterThan(relayMock.published[0].createdAt);
  });

  it('chunks an oversized checkpoint, publishing every chunk BEFORE the manifest', async () => {
    const backend = makeBackend();
    // Each operation carries ~2 KB of note text, so 60 of them cannot fit one
    // 64 KiB envelope and must chunk.
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    const ok = await publishContactsV2Checkpoint({
      seq: 2, deviceIds: [DEVICE_A], ops: fat, now: 1_700_000_000_000, backend, relayUrls: [RELAY],
    });
    expect(ok).toBe(true);

    const last = relayMock.published[relayMock.published.length - 1];
    expect(last.dTag).toBe(tagFor(AUTHOR, 'checkpoint'));
    const manifest = parseManifest((await openVaultPayload(last.content, backend, AUTHOR))!)!;
    expect(manifest.seq).toBe(2);
    expect(manifest.chunkTags.length).toBeGreaterThan(1);
    // Every chunk went out first, under its own tag, in index order.
    const chunkPublishes = relayMock.published.slice(0, -1);
    expect(chunkPublishes.map((p) => p.dTag)).toEqual(
      manifest.chunkTags.map((_, i) => tagFor(AUTHOR, 'chunk', chunkExtra(2, i))),
    );
    expect(manifest.chunkTags).toEqual(chunkPublishes.map((p) => p.dTag));
  });

  // Fix round 2 (Opus review): the single-envelope-vs-chunk decision must be
  // made by MEASURING the JSON body up front, never by attempting to seal it
  // and reading a null back — `sealVaultPayload` fails closed to null for
  // several unrelated reasons now (R-4), so a null seal can no longer double
  // as an implicit "too big" signal. This is the same 60-op oversized
  // checkpoint as the test above, with only op count small enough to pass
  // `ops.length <= MAX_OPS_PER_PAYLOAD` (unlike the count-driven test below,
  // which is the other half of this same decision).
  it('skips the single-envelope attempt by measured size alone, never wasting a seal call on it', async () => {
    const backend = makeBackend();
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    expect(fat.length).toBeLessThan(MAX_OPS_PER_PAYLOAD); // this run is size-driven, not count-driven
    const ok = await publishContactsV2Checkpoint({
      seq: 4, deviceIds: [DEVICE_A], ops: fat, now: 1_700_000_000_000, backend, relayUrls: [RELAY],
    });
    expect(ok).toBe(true);
    // Every publish (each chunk plus the manifest) costs exactly one seal —
    // if the single-envelope form had ALSO been attempted first and
    // discarded on a null seal, there would be one MORE nip44Encrypt call
    // than there are published events.
    const sealCalls = (backend as unknown as { nip44Encrypt: { mock: { calls: unknown[] } } }).nip44Encrypt.mock.calls.length;
    expect(sealCalls).toBe(relayMock.published.length);
    expect(relayMock.published.length).toBeGreaterThan(1);
  });

  // F4: R6 — above MAX_OPS_PER_PAYLOAD the single-envelope attempt must be
  // skipped OUTRIGHT by count, even for a checkpoint whose ops are small
  // enough that a single big envelope would have SEALED fine (the read side
  // still refuses it: `parseCheckpointPayload` caps at MAX_OPS_PER_PAYLOAD).
  it('skips the single-envelope attempt by count alone for 2000 < ops <= 64000', async () => {
    const backend = makeBackend();
    const count = MAX_OPS_PER_PAYLOAD + 1;
    const small = Array.from({ length: count }, (_, i) => op({ logicalClock: i + 1 }));
    const ok = await publishContactsV2Checkpoint({
      seq: 11, deviceIds: [DEVICE_A], ops: small, now: 1_700_000_000_000, backend, relayUrls: [RELAY],
    });
    expect(ok).toBe(true);
    // Every publish (each chunk plus the manifest) costs exactly one seal —
    // if the single-envelope form had ALSO been attempted first (and
    // discarded on size or on the reader-side count cap), there would be one
    // MORE nip44Encrypt call than there are published events.
    const sealCalls = (backend as unknown as { nip44Encrypt: { mock: { calls: unknown[] } } }).nip44Encrypt.mock.calls.length;
    expect(sealCalls).toBe(relayMock.published.length);
    expect(relayMock.published.length).toBeGreaterThan(1);
  });

  it('carries a digest per chunk in the manifest it publishes (R11)', async () => {
    const backend = makeBackend();
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    await publishContactsV2Checkpoint({ seq: 3, deviceIds: [DEVICE_A], ops: fat, now: 1_700_000_000_000, backend, relayUrls: [RELAY] });
    const last = relayMock.published[relayMock.published.length - 1];
    const manifest = parseManifest((await openVaultPayload(last.content, backend, AUTHOR))!)!;
    expect(manifest.chunkDigests).toHaveLength(manifest.chunkTags.length);
    expect(manifest.opCount).toBe(60);
    // Each digest describes the chunk actually published under the matching tag.
    for (const [i, tag] of manifest.chunkTags.entries()) {
      const publishedChunk = relayMock.published.find((p) => p.dTag === tag)!;
      const plaintext = (await openVaultPayload(publishedChunk.content, backend, AUTHOR))!;
      expect(manifest.chunkDigests[i]).toBe(chunkDigest(plaintext));
    }
  });

  it('does not publish the manifest when a chunk fails', async () => {
    const backend = makeBackend();
    relayMock.publishOk[RELAY] = false;
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    expect(await publishContactsV2Checkpoint({ seq: 2, deviceIds: [DEVICE_A], ops: fat, now: 1, backend, relayUrls: [RELAY] })).toBe(false);
    // One failed chunk attempt, and nothing under the checkpoint tag.
    expect(relayMock.published.every((p) => p.dTag !== tagFor(AUTHOR, 'checkpoint'))).toBe(true);
  });

  it('resolves false, never rejects, when a connected signer declines to sign', async () => {
    const backend = makeBackend();
    (backend as { signEvent: ReturnType<typeof vi.fn> }).signEvent.mockRejectedValueOnce(new Error('bunker declined'));
    const p = publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A], ops: [op()], now: 1, backend, relayUrls: [RELAY] });
    await expect(p).resolves.toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });

  it('resolves false, never rejects, when a connected signer declines to encrypt', async () => {
    const backend = makeBackend();
    (backend as { nip44Encrypt: ReturnType<typeof vi.fn> }).nip44Encrypt.mockRejectedValueOnce(new Error('bunker declined'));
    const p = publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A], ops: [op()], now: 1, backend, relayUrls: [RELAY] });
    await expect(p).resolves.toBe(false);
    expect(relayMock.published).toHaveLength(0);
  });
});

describe('fetchContactsV2Sync', () => {
  it('returns unreachable for an empty pool and for a pool that will not answer', async () => {
    const backend = makeBackend();
    expect(await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [], localDeviceId: DEVICE_A })).toBe('unreachable');
    relayMock.fetchThrows.add(RELAY);
    expect(await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A })).toBe('unreachable');
  });

  it('returns null for a malformed author', async () => {
    const backend = makeBackend();
    expect(await fetchContactsV2Sync({ authorPubkey: 'nope', backend, relayUrls: [RELAY], localDeviceId: DEVICE_A })).toBeNull();
  });

  it('reports a reachable but empty relay as ABSENT, no checkpoint and no operations', async () => {
    const backend = makeBackend();
    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A });
    expect(result).not.toBe('unreachable');
    expect(result).not.toBeNull();
    const remote = result as { checkpoint: unknown; ops: unknown[]; checkpointState: string };
    expect(remote.checkpointState).toBe('absent');
    expect(remote.checkpoint).toBeNull();
    expect(remote.ops).toEqual([]);
  });

  it('reads a checkpoint plus every outbox it names, and reports present', async () => {
    const backend = makeBackend();
    const checkpointOps = [op({ logicalClock: 1 })];
    await publishContactsV2Checkpoint({ seq: 3, deviceIds: [DEVICE_A, DEVICE_B], ops: checkpointOps, now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100);
    relayMock.published = [];

    const outboxOps = [op({ logicalClock: 5 })];
    await publishContactsV2Outbox({ deviceId: DEVICE_B, ops: outboxOps, baseFrontierMaxClock: 1, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 110);

    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as {
      ops: ContactOperation[];
      checkpointState: string;
      checkpoint: { seq: number; deviceIds: string[]; frontierOpIds: string[]; eventId: string; eventCreatedAt: number };
    };
    expect(result.checkpointState).toBe('present');
    expect(result.checkpoint.seq).toBe(3);
    expect(result.checkpoint.deviceIds).toEqual([DEVICE_A, DEVICE_B]);
    expect(result.checkpoint.frontierOpIds).toEqual(checkpointOps.map((o) => o.operationId));
    expect(result.checkpoint.eventId).toBeTruthy();
    expect(result.checkpoint.eventCreatedAt).toBe(100);
    expect(result.ops.map((o) => o.operationId).sort()).toEqual(
      [...checkpointOps, ...outboxOps].map((o) => o.operationId).sort(),
    );
  });

  it('reassembles a chunked checkpoint', async () => {
    const backend = makeBackend();
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    await publishContactsV2Checkpoint({ seq: 4, deviceIds: [DEVICE_A], ops: fat, now: 1_000, backend, relayUrls: [RELAY] });
    for (const [i, p] of relayMock.published.entries()) seed(RELAY, p.dTag, p.content, 100 + i);

    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[]; checkpointState: string };
    expect(result.checkpointState).toBe('present');
    expect(result.ops.map((o) => o.operationId)).toEqual(fat.map((o) => o.operationId));
  });

  it('reports UNUSABLE, not absent, when a chunk is missing (R2/S1)', async () => {
    const backend = makeBackend();
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    await publishContactsV2Checkpoint({ seq: 5, deviceIds: [DEVICE_A], ops: fat, now: 1_000, backend, relayUrls: [RELAY] });
    // Seed the manifest but withhold the first chunk.
    for (const [i, p] of relayMock.published.slice(1).entries()) seed(RELAY, p.dTag, p.content, 100 + i);

    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[]; checkpoint: unknown; checkpointState: string };
    // A record exists; we simply cannot read it. Reporting 'absent' here is
    // what would let the caller publish a seq-1 checkpoint over a live one.
    expect(result.checkpointState).toBe('unusable');
    expect(result.checkpoint).toBeNull();
    expect(result.ops).toEqual([]);
  });

  it('reports UNUSABLE when the checkpoint event cannot be opened at all', async () => {
    const backend = makeBackend();
    seed(RELAY, tagFor(AUTHOR, 'checkpoint'), 'not-an-envelope-and-not-a-ciphertext', 100);
    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { checkpoint: unknown; checkpointState: string };
    expect(result.checkpointState).toBe('unusable');
    expect(result.checkpoint).toBeNull();
  });

  it('reports UNUSABLE, not absent, when a different payload kind is sealed under the checkpoint tag (F1)', async () => {
    const backend = makeBackend();
    // A well-formed OUTBOX payload published under the CHECKPOINT tag —
    // neither parseCheckpointPayload nor parseManifest accept it, so the
    // event exists but nothing usable was found there.
    const sealed = (await sealVaultPayload(JSON.stringify({
      v: 2, kind: 'outbox', deviceId: DEVICE_A, baseFrontierMaxClock: 0, ops: [op()],
    }), backend))!;
    seed(RELAY, tagFor(AUTHOR, 'checkpoint'), sealed, 100);
    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { checkpoint: unknown; checkpointState: string };
    expect(result.checkpointState).toBe('unusable');
    expect(result.checkpoint).toBeNull();
  });

  it('reports UNUSABLE when the manifest names a chunk tag that does not match its own (seq, index) (F1)', async () => {
    const backend = makeBackend();
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    await publishContactsV2Checkpoint({ seq: 9, deviceIds: [DEVICE_A], ops: fat, now: 1_000, backend, relayUrls: [RELAY] });
    const published = [...relayMock.published];
    const manifestPublish = published[published.length - 1];
    const manifest = parseManifest((await openVaultPayload(manifestPublish.content, backend, AUTHOR))!)!;
    // Swap chunk 0's listed tag for a well-formed but WRONG 32-hex tag — one
    // that does not equal `tagFor(author, 'chunk', chunkExtra(seq, 0))`.
    const tampered = { ...manifest, chunkTags: ['0'.repeat(32), ...manifest.chunkTags.slice(1)] };
    const resealed = (await sealVaultPayload(JSON.stringify(tampered), backend))!;
    seed(RELAY, manifestPublish.dTag, resealed, 100);
    for (const p of published.slice(0, -1)) seed(RELAY, p.dTag, p.content, 100);

    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { checkpoint: unknown; checkpointState: string };
    expect(result.checkpointState).toBe('unusable');
    expect(result.checkpoint).toBeNull();
  });

  it('drops a checkpoint event answering under a foreign pubkey — author pin proven at this layer (F1)', async () => {
    const backend = makeBackend();
    const foreignSealed = (await sealVaultPayload(JSON.stringify({
      v: 2, kind: 'checkpoint', seq: 1, createdAt: 1_000, deviceIds: [DEVICE_A],
      frontier: { maxClock: 1, opIds: [] }, ops: [op()],
    }), backend))!;
    // A relay answering the AUTHOR's checkpoint-tag query with an event it
    // itself marks as authored by someone else.
    seed(RELAY, tagFor(AUTHOR, 'checkpoint'), foreignSealed, 100, undefined, 'f'.repeat(64));
    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { checkpoint: unknown; checkpointState: string };
    // Dropped before it is ever "seen" — this reads as no event at all, not
    // an unreadable one.
    expect(result.checkpointState).toBe('absent');
    expect(result.checkpoint).toBeNull();
  });

  it('reports UNUSABLE when a chunk digest does not match the manifest (R11)', async () => {
    const backend = makeBackend();
    const fat = Array.from({ length: 60 }, (_, i) =>
      op({ action: 'note', logicalClock: i + 1, value: { note: 'z'.repeat(2000) } }));
    await publishContactsV2Checkpoint({ seq: 6, deviceIds: [DEVICE_A], ops: fat, now: 1_000, backend, relayUrls: [RELAY] });
    const published = [...relayMock.published];
    const manifest = parseManifest((await openVaultPayload(published[published.length - 1].content, backend, AUTHOR))!)!;
    // Re-seal chunk 0 with one operation removed: right tag, right seq, right
    // index, wrong contents. Only the digest catches this.
    const chunk0 = parseChunkPayload((await openVaultPayload(published[0].content, backend, AUTHOR))!)!;
    const swapped = (await sealVaultPayload(JSON.stringify({ ...chunk0, ops: chunk0.ops.slice(1) }), backend))!;
    seed(RELAY, manifest.chunkTags[0], swapped, 100);
    for (const [i, p] of published.slice(1).entries()) seed(RELAY, p.dTag, p.content, 101 + i);

    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { checkpoint: unknown; checkpointState: string };
    expect(result.checkpointState).toBe('unusable');
    expect(result.checkpoint).toBeNull();
  });

  it('refuses to ADOPT a checkpoint older than the one this device recorded, but still merges its operations (R2/S2)', async () => {
    const backend = makeBackend();
    const old = [op({ logicalClock: 1 })];
    await publishContactsV2Checkpoint({ seq: 2, deviceIds: [DEVICE_A], ops: old, now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100);

    const result = await fetchContactsV2Sync({
      authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A,
      persisted: { seq: 7, eventCreatedAt: 900 },
    }) as { ops: ContactOperation[]; checkpoint: unknown; checkpointState: string };

    expect(result.checkpointState).toBe('unusable');
    expect(result.checkpoint).toBeNull();
    // Re-reading an older record can only ADD operations — `mergeOps` is a
    // union by operation id — so they are kept. What is refused is treating
    // this as the checkpoint to compact over.
    expect(result.ops.map((o) => o.operationId)).toEqual(old.map((o) => o.operationId));
  });

  it('refuses to adopt a checkpoint EVENT older than the one recorded, at the same seq', async () => {
    const backend = makeBackend();
    await publishContactsV2Checkpoint({ seq: 4, deviceIds: [DEVICE_A], ops: [op()], now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100);
    const result = await fetchContactsV2Sync({
      authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A,
      persisted: { seq: 4, eventCreatedAt: 500 },
    }) as { checkpointState: string };
    expect(result.checkpointState).toBe('unusable');
  });

  it('accepts a checkpoint at or past what this device recorded', async () => {
    const backend = makeBackend();
    await publishContactsV2Checkpoint({ seq: 7, deviceIds: [DEVICE_A], ops: [op()], now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 900);
    const result = await fetchContactsV2Sync({
      authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A,
      persisted: { seq: 7, eventCreatedAt: 900 },
    }) as { checkpointState: string };
    expect(result.checkpointState).toBe('present');
  });

  it('always reads this device own outbox even when no checkpoint names it', async () => {
    const backend = makeBackend();
    const mine = [op({ logicalClock: 2 })];
    await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: mine, baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100);
    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[] };
    expect(result.ops.map((o) => o.operationId)).toEqual(mine.map((o) => o.operationId));
  });

  it('never spends a signer round-trip on a tag that is not a v2 envelope (S5)', async () => {
    const backend = makeBackend();
    seed(RELAY, tagFor(AUTHOR, 'outbox', DEVICE_A), 'junk-under-a-real-tag', 100);
    const result = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[] };
    expect(result.ops).toEqual([]);
    // This rail passes `{ legacyFallback: false }`: it never had a v1 format,
    // so junk must cost nothing at all.
    expect((backend as unknown as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls).toHaveLength(0);
  });

  it('uses the per-tag decrypt cache instead of a second device round-trip', async () => {
    const backend = makeBackend();
    await publishContactsV2Checkpoint({ seq: 6, deviceIds: [DEVICE_A], ops: [op()], now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100, 'c'.repeat(64));

    const store = new Map<string, string>();
    const cacheFor = () => ({
      async get(eventId: string) { return store.get(eventId) ?? null; },
      async put(eventId: string, _createdAt: number, plaintext: string) { store.set(eventId, plaintext); },
    });
    await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A, cacheFor });
    const callsAfterFirst = (backend as unknown as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls.length;
    await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A, cacheFor });
    expect((backend as unknown as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('convergence', () => {
  it('two devices with disjoint outboxes reduce to the same state on both', async () => {
    const backend = makeBackend();

    // Shared history: device A checkpointed the contact.
    const add = op({ logicalClock: 1, actorDeviceId: DEVICE_A });
    await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A, DEVICE_B], ops: [add], now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100);
    relayMock.published = [];

    // Then each device made one edit without seeing the other's.
    const renameOnA = op({ logicalClock: 2, actorDeviceId: DEVICE_A, action: 'rename', value: { displayName: 'From A' } });
    const tierOnB = op({ logicalClock: 2, actorDeviceId: DEVICE_B, action: 'set-tier', value: { tier: 'kin' } });
    await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [renameOnA], baseFrontierMaxClock: 1, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 110);
    relayMock.published = [];
    await publishContactsV2Outbox({ deviceId: DEVICE_B, ops: [tierOnB], baseFrontierMaxClock: 1, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 120);

    const onA = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[] };
    const onB = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_B }) as { ops: ContactOperation[] };

    const stateA = applyOperations(onA.ops).get(recordKey('owner', CID))!;
    const stateB = applyOperations(onB.ops).get(recordKey('owner', CID))!;
    expect(stateA).toEqual(stateB);
    // Neither edit was lost: both survive a record-level merge.
    expect(stateA.displayName).toBe('From A');
    expect(stateA.tier).toBe('kin');
  });

  it('a device only ever replaces its OWN outbox tag', async () => {
    const backend = makeBackend();
    await publishContactsV2Outbox({ deviceId: DEVICE_A, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    await publishContactsV2Outbox({ deviceId: DEVICE_B, ops: [op()], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    expect(relayMock.published[0].dTag).toBe(tagFor(AUTHOR, 'outbox', DEVICE_A));
    expect(relayMock.published[1].dTag).toBe(tagFor(AUTHOR, 'outbox', DEVICE_B));
    expect(relayMock.published[0].dTag).not.toBe(relayMock.published[1].dTag);
  });
});

describe('a stale outbox cannot resurrect a tombstoned record', () => {
  it('keeps the record removed when an old edit arrives after the tombstone', async () => {
    const backend = makeBackend();

    // The checkpoint already carries the add AND the removal.
    const add = op({ logicalClock: 1, actorDeviceId: DEVICE_A });
    const remove = op({ logicalClock: 9, actorDeviceId: DEVICE_A, action: 'remove', value: {} });
    await publishContactsV2Checkpoint({ seq: 1, deviceIds: [DEVICE_A, DEVICE_B], ops: [add, remove], now: 1_000, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 100);
    relayMock.published = [];

    // Device B has been offline; its outbox holds two straggling edits: one
    // written at a clock BELOW the removal (sorts before it, so it merges —
    // this is what proves the outbox op actually crossed the relay rather
    // than the assertion being vacuously true off the checkpoint alone), and
    // one at a clock ABOVE the removal (sorts after it, so it must hit the
    // removed-record guard and be skipped).
    const staleEdit = op({ logicalClock: 2, actorDeviceId: DEVICE_B, action: 'rename', value: { displayName: 'Back from the dead' } });
    const laterStaleEdit = op({ logicalClock: 10, actorDeviceId: DEVICE_B, action: 'rename', value: { displayName: 'Really back this time' } });
    await publishContactsV2Outbox({ deviceId: DEVICE_B, ops: [staleEdit, laterStaleEdit], baseFrontierMaxClock: 1, backend, relayUrls: [RELAY] });
    seed(RELAY, relayMock.published[0].dTag, relayMock.published[0].content, 110);

    const remote = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[] };
    const record = applyOperations(remote.ops).get(recordKey('owner', CID))!;
    expect(record.lifecycle).toBe('removed');
    expect(record.removedAt).toBe(remove.createdAt);
    // The clock-2 rename sorts before the clock-9 removal, so it DID merge —
    // this is the proof the stale outbox op was actually applied.
    expect(record.displayName).toBe('Back from the dead');
    // The clock-10 rename sorts after the removal: the removed-record guard
    // must have skipped it, so the name stays at its pre-removal value.
    expect(record.displayName).not.toBe('Really back this time');
  });

  it('drops an outbox published under another device tag', async () => {
    const backend = makeBackend();
    const rogue = op({ actorDeviceId: DEVICE_B });
    await publishContactsV2Outbox({ deviceId: DEVICE_B, ops: [rogue], baseFrontierMaxClock: 0, backend, relayUrls: [RELAY] });
    // Same payload, relabelled under device A's tag.
    seed(RELAY, tagFor(AUTHOR, 'outbox', DEVICE_A), relayMock.published[0].content, 100);
    const remote = await fetchContactsV2Sync({ authorPubkey: AUTHOR, backend, relayUrls: [RELAY], localDeviceId: DEVICE_A }) as { ops: ContactOperation[] };
    expect(remote.ops).toEqual([]);
  });
});
