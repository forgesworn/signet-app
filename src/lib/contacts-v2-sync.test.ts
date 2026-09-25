import { describe, it, expect } from 'vitest';
import {
  CONTACTS_V2_KIND,
  MAX_OPS_PER_PAYLOAD,
  MAX_CHUNKS,
  MAX_CHECKPOINT_OPS,
  MAX_CHUNK_BODY_BYTES,
  exceedsCheckpointCeiling,
  MAX_DEVICE_IDS,
  OUTBOX_CHECKPOINT_THRESHOLD,
  CHECKPOINT_MAX_AGE_MS,
  tagFor,
  chunkExtra,
  chunkDigest,
  parseOutboxPayload,
  parseCheckpointPayload,
  parseManifest,
  parseChunkPayload,
  splitCheckpoint,
  reassembleChunks,
  shouldPublishCheckpoint,
  selectOutboxOps,
  nextCheckpointSeq,
  mergeDeviceIds,
  type CheckpointPayload,
  type CheckpointManifest,
  type ChunkPayload,
  type OutboxPayload,
  type ReceivedChunk,
} from './contacts-v2-sync';
import type { ContactOperation } from '../types';

const AUTHOR = 'A'.repeat(64);          // deliberately upper-case
const AUTHOR_LOWER = 'a'.repeat(64);
const DEVICE = 'd'.repeat(32);
const HEX32 = /^[0-9a-f]{32}$/;

function op(overrides: Partial<ContactOperation> & { operationId: string }): ContactOperation {
  return {
    directoryId: 'owner',
    contactId: '0'.repeat(32),
    actorPubkey: '1'.repeat(64),
    actorRole: 'owner',
    actorDeviceId: DEVICE,
    logicalClock: 1,
    action: 'rename',
    value: { displayName: 'Dave' },
    createdAt: 1_000,
    ...overrides,
  };
}

const OP_A = op({ operationId: 'a'.repeat(32) });

function outbox(over: Partial<OutboxPayload> = {}): OutboxPayload {
  return { v: 2, kind: 'outbox', deviceId: DEVICE, baseFrontierMaxClock: 0, ops: [OP_A], ...over };
}
function checkpoint(over: Partial<CheckpointPayload> = {}): CheckpointPayload {
  return {
    v: 2, kind: 'checkpoint', seq: 1, createdAt: 1_000,
    deviceIds: [DEVICE], frontier: { maxClock: 1, opIds: [OP_A.operationId] }, ops: [OP_A],
    ...over,
  };
}
function manifest(over: Partial<CheckpointManifest> = {}): CheckpointManifest {
  return {
    v: 2, kind: 'checkpoint-manifest', seq: 1, createdAt: 1_000,
    chunkTags: ['e'.repeat(32)], chunkDigests: [ONE_DIGEST()], opCount: 1,
    frontier: { maxClock: 1, opIds: [OP_A.operationId] }, deviceIds: [DEVICE],
    ...over,
  };
}
function chunk(over: Partial<ChunkPayload> = {}): ChunkPayload {
  return { v: 2, kind: 'chunk', seq: 1, index: 0, ops: [OP_A], ...over };
}

/** The manifest fixture's single chunk, and the digest that must describe it. */
const ONE_CHUNK = chunk();
const ONE_DIGEST = () => chunkDigest(JSON.stringify(ONE_CHUNK));

describe('tagFor', () => {
  it('is a 32-hex tag, case-insensitive in the author', () => {
    expect(tagFor(AUTHOR, 'checkpoint')).toMatch(HEX32);
    expect(tagFor(AUTHOR, 'checkpoint')).toBe(tagFor(AUTHOR_LOWER, 'checkpoint'));
  });

  it('separates kinds, authors and extras', () => {
    expect(tagFor(AUTHOR, 'checkpoint')).not.toBe(tagFor(AUTHOR, 'outbox'));
    expect(tagFor(AUTHOR, 'outbox', DEVICE)).not.toBe(tagFor(AUTHOR, 'outbox', 'e'.repeat(32)));
    expect(tagFor(AUTHOR, 'checkpoint')).not.toBe(tagFor('b'.repeat(64), 'checkpoint'));
    expect(tagFor(AUTHOR, 'chunk', chunkExtra(1, 0))).not.toBe(tagFor(AUTHOR, 'chunk', chunkExtra(1, 1)));
    expect(tagFor(AUTHOR, 'chunk', chunkExtra(1, 0))).not.toBe(tagFor(AUTHOR, 'chunk', chunkExtra(2, 0)));
  });

  it('is deterministic across calls', () => {
    expect(tagFor(AUTHOR, 'outbox', DEVICE)).toBe(tagFor(AUTHOR, 'outbox', DEVICE));
  });

  it('pins the event kind', () => {
    expect(CONTACTS_V2_KIND).toBe(30078);
  });
});

describe('chunkDigest', () => {
  it('is a 64-char lowercase sha256 hex of the exact plaintext', () => {
    const digest = chunkDigest('{"v":2}');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkDigest('{"v":2}')).toBe(digest);
    // One byte different is a different digest — that is the whole point.
    expect(chunkDigest('{"v":3}')).not.toBe(digest);
    expect(chunkDigest('')).not.toBe(digest);
  });
});

describe('operation ceilings', () => {
  it('bounds one payload and a whole checkpoint separately (R6)', () => {
    expect(MAX_OPS_PER_PAYLOAD).toBe(2000);
    expect(MAX_CHUNKS).toBe(32);
    // A checkpoint may be chunked, so its ceiling is the product — not the
    // per-payload cap, which would stop the rail backing up at 2001 operations
    // with no user-visible signal.
    expect(MAX_CHECKPOINT_OPS).toBe(MAX_CHUNKS * MAX_OPS_PER_PAYLOAD);
    expect(MAX_CHECKPOINT_OPS).toBe(64_000);
  });

  it('exposes the ceiling as a predicate so the publish path can refuse cheaply', () => {
    expect(exceedsCheckpointCeiling(0)).toBe(false);
    expect(exceedsCheckpointCeiling(MAX_CHECKPOINT_OPS)).toBe(false);
    expect(exceedsCheckpointCeiling(MAX_CHECKPOINT_OPS + 1)).toBe(true);
  });
});

describe('parseOutboxPayload', () => {
  it('accepts a well-formed outbox', () => {
    expect(parseOutboxPayload(JSON.stringify(outbox()))).toEqual(outbox());
  });

  it('rejects the wrong version, the wrong kind and a malformed device id', () => {
    expect(parseOutboxPayload(JSON.stringify({ ...outbox(), v: 1 }))).toBeNull();
    expect(parseOutboxPayload(JSON.stringify({ ...outbox(), kind: 'checkpoint' }))).toBeNull();
    expect(parseOutboxPayload(JSON.stringify({ ...outbox(), deviceId: 'nope' }))).toBeNull();
    expect(parseOutboxPayload('not json')).toBeNull();
    expect(parseOutboxPayload('[]')).toBeNull();
  });

  it('drops individual invalid operations but keeps the valid ones', () => {
    const mixed = outbox({ ops: [OP_A, { ...OP_A, operationId: 'nope' } as ContactOperation] });
    expect(parseOutboxPayload(JSON.stringify(mixed))!.ops).toEqual([OP_A]);
  });

  it('rejects a payload over MAX_OPS_PER_PAYLOAD', () => {
    const many = Array.from({ length: MAX_OPS_PER_PAYLOAD + 1 }, (_, i) =>
      op({ operationId: i.toString(16).padStart(32, '0') }));
    expect(parseOutboxPayload(JSON.stringify(outbox({ ops: many })))).toBeNull();
  });
});

describe('parseCheckpointPayload', () => {
  it('accepts a well-formed checkpoint', () => {
    expect(parseCheckpointPayload(JSON.stringify(checkpoint()))).toEqual(checkpoint());
  });

  it('rejects a bad seq, a bad frontier and a non-array deviceIds', () => {
    expect(parseCheckpointPayload(JSON.stringify(checkpoint({ seq: -1 })))).toBeNull();
    expect(parseCheckpointPayload(JSON.stringify({ ...checkpoint(), frontier: { maxClock: 'x', opIds: [] } }))).toBeNull();
    expect(parseCheckpointPayload(JSON.stringify({ ...checkpoint(), deviceIds: DEVICE }))).toBeNull();
  });

  it('rejects more than MAX_DEVICE_IDS devices', () => {
    const tooMany = Array.from({ length: MAX_DEVICE_IDS + 1 }, (_, i) => i.toString(16).padStart(32, '0'));
    expect(parseCheckpointPayload(JSON.stringify(checkpoint({ deviceIds: tooMany })))).toBeNull();
  });

  it('drops malformed device ids and duplicate frontier ids without failing the payload', () => {
    const parsed = parseCheckpointPayload(JSON.stringify(checkpoint({
      deviceIds: [DEVICE, 'not-hex', DEVICE],
      frontier: { maxClock: 1, opIds: [OP_A.operationId, OP_A.operationId, 'nope'] },
    })))!;
    expect(parsed.deviceIds).toEqual([DEVICE]);
    expect(parsed.frontier.opIds).toEqual([OP_A.operationId]);
  });
});

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(JSON.stringify(manifest()))).toEqual(manifest());
  });

  it('rejects an empty, over-long or malformed chunk-tag list', () => {
    expect(parseManifest(JSON.stringify(manifest({ chunkTags: [] })))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ chunkTags: ['not-a-tag'] })))).toBeNull();
    const tooMany = Array.from({ length: MAX_CHUNKS + 1 }, (_, i) => i.toString(16).padStart(32, '0'));
    const digests = tooMany.map((_, i) => i.toString(16).padStart(64, '0'));
    expect(parseManifest(JSON.stringify(manifest({ chunkTags: tooMany, chunkDigests: digests })))).toBeNull();
  });

  it('rejects a digest list that does not describe the chunk list (R11)', () => {
    // One digest per chunk tag, or the manifest cannot bind its chunks at all.
    expect(parseManifest(JSON.stringify(manifest({ chunkDigests: [] })))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ chunkDigests: [ONE_DIGEST(), ONE_DIGEST()] })))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ chunkDigests: ['not-a-digest'] })))).toBeNull();
    // Upper-case hex is as malformed as anything else — §3.10, one spelling.
    expect(parseManifest(JSON.stringify(manifest({ chunkDigests: [ONE_DIGEST().toUpperCase()] })))).toBeNull();
  });

  it('rejects a missing or over-cap opCount (R6)', () => {
    expect(parseManifest(JSON.stringify({ ...manifest(), opCount: undefined }))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ opCount: -1 })))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ opCount: 1.5 })))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ opCount: MAX_CHECKPOINT_OPS + 1 })))).toBeNull();
    expect(parseManifest(JSON.stringify(manifest({ opCount: MAX_CHECKPOINT_OPS })))).not.toBeNull();
  });

  it('rejects a checkpoint payload and vice versa', () => {
    expect(parseManifest(JSON.stringify(checkpoint()))).toBeNull();
    expect(parseCheckpointPayload(JSON.stringify(manifest()))).toBeNull();
  });
});

describe('parseChunkPayload', () => {
  it('accepts a well-formed chunk and rejects a negative index', () => {
    expect(parseChunkPayload(JSON.stringify(chunk()))).toEqual(chunk());
    expect(parseChunkPayload(JSON.stringify(chunk({ index: -1 })))).toBeNull();
    expect(parseChunkPayload(JSON.stringify(chunk({ index: 1.5 })))).toBeNull();
  });
});

describe('splitCheckpoint / reassembleChunks', () => {
  const tagAt = (index: number) => index.toString(16).padStart(32, '0');

  /** A chunk as the fetch leg hands it to `reassembleChunks`. */
  const received = (chunks: ChunkPayload[]): ReceivedChunk[] =>
    chunks.map((c) => ({ payload: c, plaintext: JSON.stringify(c) }));

  /**
   * Fixed-WIDTH clocks (100..), not 1.., so every operation serialises to the
   * same number of bytes. A varying width made the single-operation budget
   * below inexact, and the MAX_CHUNKS case then passed via the "one operation
   * alone does not fit" branch instead of the branch it names.
   */
  function bigCheckpoint(count: number): CheckpointPayload {
    const ops = Array.from({ length: count }, (_, i) =>
      op({ operationId: i.toString(16).padStart(32, '0'), logicalClock: 100 + i }));
    return checkpoint({ ops, frontier: { maxClock: 99 + count, opIds: ops.map((o) => o.operationId) } });
  }

  it('splits at operation boundaries and reassembles byte-identically', () => {
    const source = bigCheckpoint(40);
    // A body budget that forces several chunks.
    const split = splitCheckpoint(source, tagAt, 1500)!;
    expect(split).not.toBeNull();
    expect(split.chunks.length).toBeGreaterThan(1);
    expect(split.manifest.chunkTags).toEqual(split.chunks.map((c) => tagAt(c.index)));
    expect(split.manifest.seq).toBe(source.seq);
    expect(split.manifest.createdAt).toBe(source.createdAt);
    expect(split.manifest.opCount).toBe(40);
    // The manifest carries the clock but NOT the op-id list: a reader cannot
    // use a manifest without fetching its chunks anyway, and a full op-id list
    // would push a large checkpoint's manifest over the top bucket on its own.
    expect(split.manifest.frontier).toEqual({ maxClock: source.frontier.maxClock, opIds: [] });
    expect(split.manifest.deviceIds).toEqual(source.deviceIds);
    const rebuilt = reassembleChunks(split.manifest, received(split.chunks))!;
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(source.ops));
  });

  it('carries one digest per chunk, over that chunk exact plaintext', () => {
    const split = splitCheckpoint(bigCheckpoint(40), tagAt, 1500)!;
    expect(split.manifest.chunkDigests).toHaveLength(split.chunks.length);
    expect(split.manifest.chunkDigests).toEqual(split.chunks.map((c) => chunkDigest(JSON.stringify(c))));
    expect(split.manifest.chunkDigests.every((d) => /^[0-9a-f]{64}$/.test(d))).toBe(true);
  });

  it('numbers chunks from zero, contiguously, and carries the checkpoint seq', () => {
    const split = splitCheckpoint(bigCheckpoint(40), tagAt, 1500)!;
    expect(split.chunks.map((c) => c.index)).toEqual(split.chunks.map((_, i) => i));
    expect(split.chunks.every((c) => c.seq === 1)).toBe(true);
    expect(split.chunks.every((c) => c.kind === 'chunk' && c.v === 2)).toBe(true);
  });

  it('keeps every chunk body inside the budget', () => {
    const budget = 1500;
    for (const c of splitCheckpoint(bigCheckpoint(60), tagAt, budget)!.chunks) {
      expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(budget);
    }
  });

  it('chunks by operation COUNT as well as by bytes (R6)', () => {
    // A budget far larger than the payload, so only the count cap can split it.
    const split = splitCheckpoint(bigCheckpoint(10), tagAt, 100_000, 3)!;
    expect(split.chunks.map((c) => c.ops.length)).toEqual([3, 3, 3, 1]);
    expect(split.manifest.opCount).toBe(10);
    expect(reassembleChunks(split.manifest, received(split.chunks))).toHaveLength(10);
  });

  it('bounds a whole checkpoint at the chunk cap times the per-chunk count cap', () => {
    // The aggregate ceiling is not a third, separate bound: it IS these two
    // composed, which is why `MAX_CHECKPOINT_OPS` is defined as their product.
    expect(MAX_CHUNKS * MAX_OPS_PER_PAYLOAD).toBe(MAX_CHECKPOINT_OPS);
  });

  it('never drops an operation, even at a single-operation-per-chunk budget', () => {
    const source = bigCheckpoint(5);
    const oneEach = new TextEncoder().encode(JSON.stringify(chunk({ ops: [source.ops[0]] }))).length;
    const split = splitCheckpoint(source, tagAt, oneEach)!;
    expect(split.chunks).toHaveLength(5);
    expect(reassembleChunks(split.manifest, received(split.chunks))).toEqual(source.ops);
  });

  it('returns null when one operation cannot fit a chunk at all', () => {
    expect(splitCheckpoint(bigCheckpoint(3), tagAt, 10)).toBeNull();
  });

  it('returns null above MAX_CHUNKS rather than dropping the tail', () => {
    const source = bigCheckpoint(MAX_CHUNKS + 5);
    // Fixed-width clocks make this budget exact for EVERY operation, so the
    // split needs one chunk each and fails on the chunk cap — the branch this
    // case is about — not on "one operation alone does not fit".
    const oneEach = new TextEncoder().encode(JSON.stringify(chunk({ ops: [source.ops[0]] }))).length;
    expect(splitCheckpoint(source, tagAt, oneEach)).toBeNull();
    // Same refusal via the count cap, with a budget that could not be the cause.
    expect(splitCheckpoint(source, tagAt, 100_000, 1)).toBeNull();
  });

  it('returns null for an empty checkpoint — there is nothing to chunk', () => {
    expect(splitCheckpoint(checkpoint({ ops: [], frontier: { maxClock: 0, opIds: [] } }), tagAt, 1500)).toBeNull();
  });

  // M8: defence in depth — these two guards protect a caller that reaches
  // `splitCheckpoint` without having checked `exceedsCheckpointCeiling`
  // upstream (or that passes an oversized `maxOpsPerChunk` override).
  it('refuses upfront a checkpoint whose op count already exceeds the whole-checkpoint ceiling (M8)', () => {
    // A single reused reference — the guard fires on `.length` alone, before
    // any per-operation work, so building MAX_CHECKPOINT_OPS + 1 distinct
    // operations would cost nothing this test needs to pay for.
    const ops = new Array(MAX_CHECKPOINT_OPS + 1).fill(OP_A);
    expect(exceedsCheckpointCeiling(ops.length)).toBe(true);
    expect(splitCheckpoint(checkpoint({ ops, frontier: { maxClock: 1, opIds: [OP_A.operationId] } }), tagAt, 100_000)).toBeNull();
  });

  it('clamps an over-cap maxOpsPerChunk override to MAX_OPS_PER_PAYLOAD (M8)', () => {
    const source = bigCheckpoint(10);
    // A budget far larger than the payload and a per-chunk count cap well
    // past MAX_OPS_PER_PAYLOAD — without the clamp this would produce one
    // chunk of 10 operations; with it, the clamp itself is still far above
    // 10, so this alone doesn't discriminate. What discriminates is that the
    // clamped value is provably MAX_OPS_PER_PAYLOAD, not the raw override —
    // proven directly against a count that only the clamp, not the override,
    // would split on.
    const overCapSplit = splitCheckpoint(source, tagAt, 5_000_000, MAX_OPS_PER_PAYLOAD * 10)!;
    expect(overCapSplit.chunks).toHaveLength(1); // 10 ops is under the clamp either way
    const atClampSplit = splitCheckpoint(bigCheckpoint(MAX_OPS_PER_PAYLOAD + 5), tagAt, 5_000_000, MAX_OPS_PER_PAYLOAD * 10)!;
    // If the override (20000) had been honoured verbatim, this would be one
    // chunk. Clamped to MAX_OPS_PER_PAYLOAD (2000), it must split in two.
    expect(atClampSplit.chunks).toHaveLength(2);
    expect(atClampSplit.chunks[0].ops).toHaveLength(MAX_OPS_PER_PAYLOAD);
    expect(atClampSplit.chunks[1].ops).toHaveLength(5);
  });

  it('defaults the budget to the top bucket less the length prefix', () => {
    expect(MAX_CHUNK_BODY_BYTES).toBe(65536 - 4);
  });
});

describe('reassembleChunks — refusal', () => {
  const tagAt = (index: number) => index.toString(16).padStart(32, '0');
  const received = (chunks: ChunkPayload[]): ReceivedChunk[] =>
    chunks.map((c) => ({ payload: c, plaintext: JSON.stringify(c) }));

  const twenty = () => checkpoint({
    ops: Array.from({ length: 20 }, (_, i) =>
      op({ operationId: i.toString(16).padStart(32, '0'), logicalClock: 100 + i })),
  });

  it('refuses a missing chunk rather than returning a partial log', () => {
    const split = splitCheckpoint(twenty(), tagAt, 900)!;
    expect(reassembleChunks(split.manifest, received(split.chunks.slice(1)))).toBeNull();
  });

  it('refuses a duplicated index, a wrong seq and an out-of-range index', () => {
    const split = splitCheckpoint(twenty(), tagAt, 900)!;
    expect(reassembleChunks(split.manifest, received([split.chunks[0], split.chunks[0]]))).toBeNull();
    expect(reassembleChunks(split.manifest, received(split.chunks.map((c) => ({ ...c, seq: 99 }))))).toBeNull();
    expect(reassembleChunks(split.manifest, received([...split.chunks, chunk({ index: 99 })]))).toBeNull();
  });

  it('refuses a chunk whose plaintext does not match its manifest digest (R11)', () => {
    const split = splitCheckpoint(twenty(), tagAt, 900)!;
    const tampered = received(split.chunks);
    // Same parsed payload, one byte different on the wire — exactly the
    // swapped-contents case a tag-and-index check alone cannot see.
    tampered[0] = { payload: tampered[0].payload, plaintext: `${tampered[0].plaintext} ` };
    expect(reassembleChunks(split.manifest, tampered)).toBeNull();
  });

  it('refuses when the chunks do not add up to the manifest opCount (R11)', () => {
    const split = splitCheckpoint(twenty(), tagAt, 900)!;
    const lying = { ...split.manifest, opCount: split.manifest.opCount + 1 };
    expect(reassembleChunks(lying, received(split.chunks))).toBeNull();
  });

  it('refuses a manifest whose digest list does not describe its chunk list', () => {
    const split = splitCheckpoint(twenty(), tagAt, 900)!;
    const short = { ...split.manifest, chunkDigests: split.manifest.chunkDigests.slice(1) };
    expect(reassembleChunks(short, received(split.chunks))).toBeNull();
  });

  it('refuses a manifest claiming more operations than a checkpoint may hold (R6)', () => {
    const split = splitCheckpoint(twenty(), tagAt, 900)!;
    const greedy = { ...split.manifest, opCount: MAX_CHECKPOINT_OPS + 1 };
    expect(reassembleChunks(greedy, received(split.chunks))).toBeNull();
  });

  it('reassembles regardless of the order the chunks arrived in', () => {
    const source = twenty();
    const split = splitCheckpoint(source, tagAt, 900)!;
    expect(reassembleChunks(split.manifest, received([...split.chunks].reverse()))).toEqual(source.ops);
  });
});

describe('shouldPublishCheckpoint', () => {
  const NOW = 1_700_000_000_000;
  const SELF = '1'.repeat(32);
  const OTHER = '2'.repeat(32);
  /** A remote checkpoint that lists this device and is neither stale nor huge. */
  const fresh = { seq: 3, createdAt: NOW - 1000, deviceIds: [SELF, OTHER] };

  it('trigger (a): there is no remote checkpoint at all', () => {
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: null, checkpointState: 'absent', selfDeviceId: SELF, outboxOpCount: 1, now: NOW,
    })).toBe(true);
    // Even with an empty outbox — a device's first-ever publish is a
    // checkpoint, because that is how its device id becomes discoverable.
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: null, checkpointState: 'absent', selfDeviceId: SELF, outboxOpCount: 0, now: NOW,
    })).toBe(true);
  });

  it('trigger (b): this device is holding more than the threshold', () => {
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: fresh, checkpointState: 'present', selfDeviceId: SELF,
      outboxOpCount: OUTBOX_CHECKPOINT_THRESHOLD, now: NOW,
    })).toBe(false);
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: fresh, checkpointState: 'present', selfDeviceId: SELF,
      outboxOpCount: OUTBOX_CHECKPOINT_THRESHOLD + 1, now: NOW,
    })).toBe(true);
  });

  it('trigger (c): the newest checkpoint is over a day old AND the outbox is non-empty', () => {
    const stale = { seq: 3, createdAt: NOW - CHECKPOINT_MAX_AGE_MS - 1, deviceIds: [SELF] };
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: stale, checkpointState: 'present', selfDeviceId: SELF, outboxOpCount: 1, now: NOW,
    })).toBe(true);
    // A stale checkpoint with nothing to add is not worth a republish.
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: stale, checkpointState: 'present', selfDeviceId: SELF, outboxOpCount: 0, now: NOW,
    })).toBe(false);
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: { seq: 3, createdAt: NOW - CHECKPOINT_MAX_AGE_MS + 1000, deviceIds: [SELF] },
      checkpointState: 'present', selfDeviceId: SELF, outboxOpCount: 1, now: NOW,
    })).toBe(false);
  });

  it('trigger (d): this device is not in the checkpoint device list (R7)', () => {
    // Evicted at the cap by another device's checkpoint. Nobody will ever read
    // this device's outbox again unless it re-inserts itself — so it does,
    // even with an empty outbox and a fresh checkpoint.
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: { seq: 3, createdAt: NOW - 1000, deviceIds: [OTHER] },
      checkpointState: 'present', selfDeviceId: SELF, outboxOpCount: 0, now: NOW,
    })).toBe(true);
    // Listed: no trigger from this rule.
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: fresh, checkpointState: 'present', selfDeviceId: SELF, outboxOpCount: 0, now: NOW,
    })).toBe(false);
  });

  it('never compacts over a checkpoint it could not read (R2)', () => {
    // Every other trigger says yes; `'unusable'` overrides all of them. A
    // checkpoint event exists, we simply cannot see what is in it, and
    // replacing it would destroy every other device's operations.
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: null, checkpointState: 'unusable', selfDeviceId: SELF,
      outboxOpCount: OUTBOX_CHECKPOINT_THRESHOLD + 1, now: NOW,
    })).toBe(false);
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: { seq: 1, createdAt: 0, deviceIds: [] },
      checkpointState: 'unusable', selfDeviceId: SELF, outboxOpCount: 5, now: NOW,
    })).toBe(false);
  });

  it('honours injected bounds', () => {
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: { seq: 1, createdAt: NOW, deviceIds: [SELF] }, checkpointState: 'present',
      selfDeviceId: SELF, outboxOpCount: 3, now: NOW, threshold: 2,
    })).toBe(true);
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: { seq: 1, createdAt: NOW - 10, deviceIds: [SELF] }, checkpointState: 'present',
      selfDeviceId: SELF, outboxOpCount: 1, now: NOW, maxAgeMs: 5,
    })).toBe(true);
  });

  it('treats a checkpoint stamped in the future as fresh, not stale', () => {
    expect(shouldPublishCheckpoint({
      remoteCheckpoint: { seq: 1, createdAt: NOW + CHECKPOINT_MAX_AGE_MS, deviceIds: [SELF] },
      checkpointState: 'present', selfDeviceId: SELF, outboxOpCount: 1, now: NOW,
    })).toBe(false);
  });
});

describe('selectOutboxOps', () => {
  const a = op({ operationId: 'a'.repeat(32) });
  const b = op({ operationId: 'b'.repeat(32) });

  it('keeps only what the checkpoint does not already carry', () => {
    expect(selectOutboxOps([a, b], [a.operationId])).toEqual([b]);
  });

  it('keeps everything when the checkpoint is empty', () => {
    expect(selectOutboxOps([a, b], [])).toEqual([a, b]);
  });

  it('returns an empty list when the checkpoint already carries everything', () => {
    expect(selectOutboxOps([a, b], [a.operationId, b.operationId])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const local = [a, b];
    selectOutboxOps(local, [a.operationId]);
    expect(local).toEqual([a, b]);
  });
});

describe('nextCheckpointSeq / mergeDeviceIds', () => {
  it('starts at 1 and otherwise increments', () => {
    expect(nextCheckpointSeq(null)).toBe(1);
    expect(nextCheckpointSeq(0)).toBe(1);
    expect(nextCheckpointSeq(7)).toBe(8);
    expect(nextCheckpointSeq(-3)).toBe(1);
  });

  it('never regresses below a sequence this device already recorded (R2)', () => {
    // A relay serving an older checkpoint, or one that cannot be read at all,
    // must not be able to walk the sequence backwards: the seq-1 chunk tags
    // would then collide with the previous seq-1 chunk events.
    expect(nextCheckpointSeq(null, 7)).toBe(8);
    expect(nextCheckpointSeq(3, 7)).toBe(8);
    expect(nextCheckpointSeq(9, 7)).toBe(10);
    expect(nextCheckpointSeq(null, null)).toBe(1);
    expect(nextCheckpointSeq(null, 0)).toBe(1);
  });

  it('adds this device once, keeps remote order, and never exceeds the cap', () => {
    const remote = ['1'.repeat(32), '2'.repeat(32)];
    expect(mergeDeviceIds(remote, '2'.repeat(32))).toEqual(remote);
    expect(mergeDeviceIds(remote, '3'.repeat(32))).toEqual([...remote, '3'.repeat(32)]);
    const full = Array.from({ length: MAX_DEVICE_IDS }, (_, i) => i.toString(16).padStart(32, '0'));
    const merged = mergeDeviceIds(full, 'f'.repeat(32));
    expect(merged).toHaveLength(MAX_DEVICE_IDS);
    // This device must survive the cap — it is the one that has to be
    // readable by the others. The OLDEST listed device is the one dropped,
    // and trigger (d) is how that device gets itself back on the list.
    expect(merged).toContain('f'.repeat(32));
    expect(merged).not.toContain(full[0]);
  });

  it('drops a malformed remote id', () => {
    expect(mergeDeviceIds(['not-hex'], '1'.repeat(32))).toEqual(['1'.repeat(32)]);
  });

  // F4: a remote list carrying the same device id twice (a relay that
  // deduped nothing, or a malformed manifest) must not produce a duplicate
  // in the merged list.
  it('dedupes a duplicated remote id, keeping its first position', () => {
    const remote = ['1'.repeat(32), '1'.repeat(32), '2'.repeat(32)];
    expect(mergeDeviceIds(remote, '2'.repeat(32))).toEqual(['1'.repeat(32), '2'.repeat(32)]);
    expect(mergeDeviceIds(remote, '3'.repeat(32))).toEqual(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
  });
});
