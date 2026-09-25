/**
 * Contacts v2 relay rail (internal design exploration §7, §8.2–8.4).
 *
 * SHAPE. The contacts log is an append-only operation set (Phase B), not a
 * snapshot, so the rail is a per-device OUTBOX plus a periodically compacted
 * CHECKPOINT rather than one replaceable record:
 *
 *   checkpoint  — the full compacted operation set plus the frontier and the
 *                 list of device ids whose outboxes a reader must also fetch.
 *                 Replaceable; one per author. Chunked into numbered `chunk`
 *                 events behind a `checkpoint-manifest` when it outgrows the
 *                 top padding bucket. Records are never dropped.
 *   outbox      — one replaceable event per device, carrying the operations
 *                 that device created or merged since the checkpoint it last
 *                 saw. This is why two devices never overwrite each other: a
 *                 device only ever replaces its OWN outbox.
 *
 * A device's first-ever publish is a checkpoint, which is how its device id
 * becomes discoverable to the others at all: a reader learns which outboxes
 * exist only from the newest checkpoint's `deviceIds`.
 *
 * TAGS. `d` tags are `sha256('signet:contacts:v2:<kind>:<author>[:<extra>]')`
 * truncated to 32 hex. They are computable by ANYONE who knows the author
 * pubkey — opacity against an idle relay scan is all they buy while the rail
 * is still authored by the natural person. They are not a confidentiality
 * boundary, and nothing about the payload's protection depends on them.
 *
 * PAYLOADS are sealed in the v2 vault envelope (`vault-envelope.ts`), so the
 * signer only ever wraps a 32-byte content key.
 *
 * THIS MODULE REDUCES NOTHING. It parses, bounds, splits, fetches and
 * publishes `ContactOperation[]`. Ordering, conflict resolution and tombstone
 * semantics live in Phase B's `contacts-v2-clock.ts` / `contacts-v2-reducer.ts`
 * and must not be duplicated here.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { TOP_BUCKET, LENGTH_PREFIX_BYTES, sealVaultPayload, openVaultPayloadOrThrow } from './vault-envelope';
import type { ContactOperation } from '../types';
import { validateOperation } from './contacts-v2-reducer';
import { frontierOf, mergeOps } from './contacts-v2-clock';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';

/** Same replaceable-event kind as every other sync rail. */
export const CONTACTS_V2_KIND = 30078;

/**
 * Per-payload operation cap. A real family log is hundreds of operations; a
 * payload claiming thousands is either a bug or a hostile relay trying to
 * make us do unbounded work, and either way it is refused whole rather than
 * silently truncated.
 */
export const MAX_OPS_PER_PAYLOAD = 2000;

/** Chunk cap for one checkpoint — 32 × 64 KiB is a 2 MiB ceiling. */
export const MAX_CHUNKS = 32;

/**
 * Operation cap for a WHOLE checkpoint, chunks included (ruling R6).
 *
 * `MAX_OPS_PER_PAYLOAD` bounds one payload; without this second, aggregate
 * bound the rail would be able to READ a 64 000-operation checkpoint but
 * never re-publish one, so a log that grew past 2000 operations would stop
 * being backed up silently and forever. It also bounds the work a hostile
 * relay can impose: every reassembled operation is reduced and then written
 * to IndexedDB as its own PBKDF2-encrypted row.
 *
 * The hook surfaces `backupState: 'too-large'` when the local log exceeds it,
 * so the failure is visible rather than silent.
 */
export const MAX_CHECKPOINT_OPS = MAX_CHUNKS * MAX_OPS_PER_PAYLOAD;

/**
 * Is this operation count past the whole-checkpoint ceiling? A predicate
 * rather than an inline comparison so the publish path, the reassembly path
 * and the hook's `backupState` all ask the same question in the same words,
 * and so it can be tested without building 64 001 operations.
 */
export function exceedsCheckpointCeiling(opCount: number): boolean {
  return opCount > MAX_CHECKPOINT_OPS;
}

/** Devices whose outboxes one checkpoint may list. */
export const MAX_DEVICE_IDS = 16;

/** Outbox size that forces a fresh compacted checkpoint. */
export const OUTBOX_CHECKPOINT_THRESHOLD = 50;

/** A checkpoint older than this, with anything in the outbox, is recompacted. Milliseconds. */
export const CHECKPOINT_MAX_AGE_MS = 86_400_000;

const HEX32 = /^[0-9a-f]{32}$/;
/** §3.10: strict lowercase everywhere. `tagFor` lowercases, `validateOperation`
 *  requires lowercase, and `fetchNewestFromRelays` lowercases both sides of the
 *  author pin — a case-insensitive spelling here would be the one place a
 *  mixed-case value slipped through. */
const HEX64 = /^[0-9a-f]{64}$/;

export type ContactsV2TagKind = 'checkpoint' | 'outbox' | 'chunk';

/**
 * What the last fetch found at the checkpoint tag (ruling R2).
 *
 * `'unusable'` is NOT `'absent'`. A checkpoint event that exists but cannot be
 * opened, parsed or reassembled — or one older than the checkpoint this device
 * already recorded — means "I do not know what is out there", and compacting
 * over it would replace a live replaceable record with one carrying only this
 * device's operations. That is exactly the "log with records deleted" state
 * chunking exists to prevent, reached by a different door.
 */
export type CheckpointState = 'absent' | 'present' | 'unusable';

/**
 * Deterministic opaque `d` tag. See the module header: computable by anyone
 * holding the author pubkey.
 */
export function tagFor(authorPubkey: string, kind: ContactsV2TagKind, extra?: string): string {
  const base = `signet:contacts:v2:${kind}:${authorPubkey.toLowerCase()}${extra ? `:${extra}` : ''}`;
  return bytesToHex(sha256(new TextEncoder().encode(base))).slice(0, 32);
}

/** The `extra` component of a chunk tag: the checkpoint sequence and the chunk index. */
export function chunkExtra(seq: number, index: number): string {
  return `${seq}:${index}`;
}

/**
 * The digest a manifest carries for one chunk: sha256 of that chunk's
 * PLAINTEXT JSON, lowercase hex (ruling R11).
 *
 * Over the plaintext string as sealed and as received, deliberately — not over
 * a re-serialised parse. All four payload kinds are sealed to the same
 * self-key, so without this a chunk from checkpoint seq N whose CONTENTS were
 * replaced by an older self-authored chunk at the same `(seq, index)` would be
 * accepted on its own say-so. Digesting the exact bytes leaves no room for a
 * re-serialisation to disagree with what was signed.
 */
export function chunkDigest(plaintext: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(plaintext)));
}

/** The operation frontier as it travels on the wire (a Set is not JSON). */
export interface CheckpointFrontierWire {
  maxClock: number;
  opIds: string[];
}

export interface OutboxPayload {
  v: 2;
  kind: 'outbox';
  deviceId: string;
  /** The checkpoint frontier's `maxClock` this outbox was written against. */
  baseFrontierMaxClock: number;
  ops: ContactOperation[];
}

export interface CheckpointPayload {
  v: 2;
  kind: 'checkpoint';
  seq: number;
  /** Milliseconds, matching `ContactOperation.createdAt` — NOT the event's seconds. */
  createdAt: number;
  deviceIds: string[];
  frontier: CheckpointFrontierWire;
  ops: ContactOperation[];
}

export interface CheckpointManifest {
  v: 2;
  kind: 'checkpoint-manifest';
  seq: number;
  chunkTags: string[];
  /** R11: `chunkDigest` of each chunk's plaintext JSON, positionally aligned with `chunkTags`. */
  chunkDigests: string[];
  /** R11/R6: how many operations the chunks must add up to, and a ceiling on them. */
  opCount: number;
  frontier: CheckpointFrontierWire;
  deviceIds: string[];
  createdAt: number;
}

export interface ChunkPayload {
  v: 2;
  kind: 'chunk';
  seq: number;
  index: number;
  ops: ContactOperation[];
}

function asObject(raw: string): Record<string, unknown> | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Bound then validate. An over-cap payload is refused WHOLE (we cannot tell
 * which half was meant); an individual malformed operation is dropped, which
 * is the same posture every other rail's parser takes toward one bad record.
 */
function parseOps(value: unknown): ContactOperation[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_OPS_PER_PAYLOAD) return null;
  return value.filter((candidate): candidate is ContactOperation => validateOperation(candidate));
}

function parseDeviceIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_DEVICE_IDS) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !HEX32.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseFrontier(value: unknown): CheckpointFrontierWire | null {
  if (typeof value !== 'object' || value === null) return null;
  const f = value as Record<string, unknown>;
  if (!isNonNegativeInt(f.maxClock)) return null;
  if (!Array.isArray(f.opIds)) return null;
  if (f.opIds.length > MAX_OPS_PER_PAYLOAD) return null;
  const seen = new Set<string>();
  const opIds: string[] = [];
  for (const id of f.opIds) {
    if (typeof id !== 'string' || !HEX32.test(id) || seen.has(id)) continue;
    seen.add(id);
    opIds.push(id);
  }
  return { maxClock: f.maxClock, opIds };
}

export function parseOutboxPayload(raw: string): OutboxPayload | null {
  const p = asObject(raw);
  if (!p || p.v !== 2 || p.kind !== 'outbox') return null;
  if (typeof p.deviceId !== 'string' || !HEX32.test(p.deviceId)) return null;
  if (!isNonNegativeInt(p.baseFrontierMaxClock)) return null;
  const ops = parseOps(p.ops);
  if (ops === null) return null;
  return { v: 2, kind: 'outbox', deviceId: p.deviceId, baseFrontierMaxClock: p.baseFrontierMaxClock, ops };
}

export function parseCheckpointPayload(raw: string): CheckpointPayload | null {
  const p = asObject(raw);
  if (!p || p.v !== 2 || p.kind !== 'checkpoint') return null;
  if (!isNonNegativeInt(p.seq) || !isNonNegativeInt(p.createdAt)) return null;
  const deviceIds = parseDeviceIds(p.deviceIds);
  if (deviceIds === null) return null;
  const frontier = parseFrontier(p.frontier);
  if (frontier === null) return null;
  const ops = parseOps(p.ops);
  if (ops === null) return null;
  return { v: 2, kind: 'checkpoint', seq: p.seq, createdAt: p.createdAt, deviceIds, frontier, ops };
}

export function parseManifest(raw: string): CheckpointManifest | null {
  const p = asObject(raw);
  if (!p || p.v !== 2 || p.kind !== 'checkpoint-manifest') return null;
  if (!isNonNegativeInt(p.seq) || !isNonNegativeInt(p.createdAt)) return null;
  if (!Array.isArray(p.chunkTags) || p.chunkTags.length === 0 || p.chunkTags.length > MAX_CHUNKS) return null;
  // Every tag must be well-formed: a manifest pointing at one unreadable
  // chunk cannot be partially honoured without losing records.
  if (!p.chunkTags.every((t) => typeof t === 'string' && HEX32.test(t))) return null;
  // R11: exactly one digest per chunk, or the manifest cannot bind its chunks.
  if (!Array.isArray(p.chunkDigests) || p.chunkDigests.length !== p.chunkTags.length) return null;
  if (!p.chunkDigests.every((d) => typeof d === 'string' && HEX64.test(d))) return null;
  // R6: the aggregate ceiling is checked here, before anything is fetched.
  if (!isNonNegativeInt(p.opCount) || p.opCount > MAX_CHECKPOINT_OPS) return null;
  const deviceIds = parseDeviceIds(p.deviceIds);
  if (deviceIds === null) return null;
  const frontier = parseFrontier(p.frontier);
  if (frontier === null) return null;
  return {
    v: 2, kind: 'checkpoint-manifest', seq: p.seq, createdAt: p.createdAt,
    chunkTags: p.chunkTags as string[], chunkDigests: p.chunkDigests as string[],
    opCount: p.opCount, frontier, deviceIds,
  };
}

export function parseChunkPayload(raw: string): ChunkPayload | null {
  const p = asObject(raw);
  if (!p || p.v !== 2 || p.kind !== 'chunk') return null;
  if (!isNonNegativeInt(p.seq) || !isNonNegativeInt(p.index)) return null;
  if (p.index >= MAX_CHUNKS) return null;
  const ops = parseOps(p.ops);
  if (ops === null) return null;
  return { v: 2, kind: 'chunk', seq: p.seq, index: p.index, ops };
}

/**
 * The largest chunk body we will build. A chunk is sealed on its own, so its
 * JSON must fit the top padding bucket with the length prefix subtracted.
 */
export const MAX_CHUNK_BODY_BYTES = TOP_BUCKET - LENGTH_PREFIX_BYTES;

/**
 * A chunk as the fetch leg received it: the parsed payload AND the exact
 * plaintext string it arrived as. The manifest's digest is over those bytes
 * (R11), so reassembly must see them rather than a re-serialised parse.
 */
export interface ReceivedChunk {
  payload: ChunkPayload;
  plaintext: string;
}

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Split a checkpoint that will not fit one envelope into numbered chunk
 * payloads plus the manifest that lists them.
 *
 * Splitting is at OPERATION boundaries and is greedy in operation order, so
 * the concatenation of the chunks' `ops` is byte-identical to the source
 * checkpoint's `ops`. A chunk is closed when EITHER the byte budget or
 * `maxOpsPerChunk` would be exceeded — chunking by bytes alone let a payload
 * carry more operations than `parseChunkPayload` will accept back (R6).
 *
 * Returns null rather than dropping anything when a single operation cannot
 * fit a chunk, when the split would need more than `MAX_CHUNKS`, or when there
 * is nothing to chunk. The whole-checkpoint ceiling needs no separate check
 * here: at most `MAX_CHUNKS` chunks of at most `MAX_OPS_PER_PAYLOAD`
 * operations each IS `MAX_CHECKPOINT_OPS`, which is how that constant is
 * defined.
 *
 * `chunkTag` maps a chunk index to its `d` tag — the caller supplies it so
 * this stays pure (the tag needs the author pubkey and the sequence number).
 */
export function splitCheckpoint(
  checkpoint: CheckpointPayload,
  chunkTag: (index: number) => string,
  maxBodyBytes: number = MAX_CHUNK_BODY_BYTES,
  maxOpsPerChunk: number = MAX_OPS_PER_PAYLOAD,
): { manifest: CheckpointManifest; chunks: ChunkPayload[] } | null {
  if (checkpoint.ops.length === 0) return null;
  if (maxOpsPerChunk < 1) return null;
  // M8: defence in depth — mirror the whole-checkpoint ceiling the publish
  // and reassembly paths already enforce, so a caller that reaches this
  // function without having checked `exceedsCheckpointCeiling` upstream
  // still cannot produce a checkpoint that could never be read back.
  if (exceedsCheckpointCeiling(checkpoint.ops.length)) return null;
  // M8: clamp rather than trust a caller-supplied override — the reader
  // (`parseChunkPayload`) refuses any single chunk over `MAX_OPS_PER_PAYLOAD`
  // regardless of what this function was asked to build.
  const opsPerChunk = Math.min(maxOpsPerChunk, MAX_OPS_PER_PAYLOAD);

  const chunks: ChunkPayload[] = [];
  let current: ChunkPayload = { v: 2, kind: 'chunk', seq: checkpoint.seq, index: 0, ops: [] };

  for (const operation of checkpoint.ops) {
    const candidate: ChunkPayload = { ...current, ops: [...current.ops, operation] };
    const withinCount = candidate.ops.length <= opsPerChunk;
    if (withinCount && utf8Length(JSON.stringify(candidate)) <= maxBodyBytes) {
      current = candidate;
      continue;
    }
    if (current.ops.length === 0) return null; // one operation alone does not fit
    chunks.push(current);
    const next: ChunkPayload = { v: 2, kind: 'chunk', seq: checkpoint.seq, index: chunks.length, ops: [operation] };
    if (utf8Length(JSON.stringify(next)) > maxBodyBytes) return null;
    current = next;
  }
  chunks.push(current);

  if (chunks.length > MAX_CHUNKS) return null;

  const manifest: CheckpointManifest = {
    v: 2,
    kind: 'checkpoint-manifest',
    seq: checkpoint.seq,
    createdAt: checkpoint.createdAt,
    chunkTags: chunks.map((c) => chunkTag(c.index)),
    // R11: digest the exact bytes `publishSealed` will seal — it stringifies
    // the same object, so the two serialisations cannot drift.
    chunkDigests: chunks.map((c) => chunkDigest(JSON.stringify(c))),
    opCount: checkpoint.ops.length,
    // Clock only. A reader must fetch every chunk to use a manifest at all, so
    // it can derive the op-id set from the reassembled operations; carrying a
    // full op-id list here would push a large checkpoint's manifest over the
    // top padding bucket by itself and make chunking self-defeating.
    frontier: { maxClock: checkpoint.frontier.maxClock, opIds: [] },
    deviceIds: checkpoint.deviceIds,
  };
  return { manifest, chunks };
}

/**
 * Rebuild a chunked checkpoint's operation list. Returns null unless EVERY
 * chunk the manifest names is present exactly once at the manifest's own
 * sequence, with the plaintext the manifest's digest describes, adding up to
 * the operation count the manifest claimed — a partial or substituted
 * reassembly would look like a log with records deleted, which is precisely
 * the state the chunking exists to avoid.
 */
export function reassembleChunks(
  manifest: CheckpointManifest,
  received: ReceivedChunk[],
): ContactOperation[] | null {
  const expected = manifest.chunkTags.length;
  if (manifest.chunkDigests.length !== expected) return null;
  if (exceedsCheckpointCeiling(manifest.opCount)) return null;

  const byIndex = new Map<number, ReceivedChunk>();
  for (const item of received) {
    const c = item.payload;
    if (c.seq !== manifest.seq) return null;
    if (c.index >= expected) return null;
    if (byIndex.has(c.index)) return null;
    // R11. All four payload kinds are sealed to the same self-key, so without
    // this a chunk whose CONTENTS were swapped for another self-authored chunk
    // at the same (seq, index) would be accepted on its own say-so.
    if (chunkDigest(item.plaintext) !== manifest.chunkDigests[c.index]) return null;
    byIndex.set(c.index, item);
  }
  if (byIndex.size !== expected) return null;

  const ops: ContactOperation[] = [];
  for (let i = 0; i < expected; i += 1) {
    const item = byIndex.get(i);
    if (!item) return null;
    // Stop rather than grow past the ceiling, even if the manifest's own
    // `opCount` was inside it.
    if (exceedsCheckpointCeiling(ops.length + item.payload.ops.length)) return null;
    ops.push(...item.payload.ops);
  }
  // The count the manifest claimed must be the count that arrived. A chunk
  // that lost an operation to `validateOperation` on the way in fails here.
  if (ops.length !== manifest.opCount) return null;
  return ops;
}

/**
 * When to replace the compacted checkpoint instead of just replacing this
 * device's outbox. Four triggers, in the order a reader will care about:
 *
 *   (a) there is no remote checkpoint — including this device's first-ever
 *       publish, which MUST be a checkpoint so its device id is discoverable;
 *   (b) this device's outbox has grown past `OUTBOX_CHECKPOINT_THRESHOLD`,
 *       so a fresh reader's fan-out is getting expensive;
 *   (c) the newest checkpoint is over `CHECKPOINT_MAX_AGE_MS` old AND there
 *       is something to fold into it. A stale checkpoint with an empty outbox
 *       is not worth the relay traffic;
 *   (d) this device is not in the checkpoint's `deviceIds` (R7). At the cap
 *       `mergeDeviceIds` drops the oldest listed device, and a device nobody
 *       lists is a device whose outbox nobody ever reads — silent data loss.
 *       Re-publishing the checkpoint re-adds it and folds its outbox in.
 *
 * And ONE refusal that overrides all four: `checkpointState === 'unusable'`
 * (R2). A checkpoint event exists but could not be opened, parsed,
 * reassembled, or is older than the one this device already recorded. We do
 * not know what it holds, and the checkpoint tag is a REPLACEABLE event —
 * publishing over it would delete every other device's folded operations. A
 * device in that state still publishes its own outbox, which is lossless.
 */
export function shouldPublishCheckpoint(args: {
  remoteCheckpoint: { seq: number; createdAt: number; deviceIds: readonly string[] } | null;
  checkpointState: CheckpointState;
  /** This device's own `contactsDeviceId`, for trigger (d). */
  selfDeviceId: string;
  outboxOpCount: number;
  /** Milliseconds, same clock as `CheckpointPayload.createdAt`. */
  now: number;
  maxAgeMs?: number;
  threshold?: number;
}): boolean {
  const { remoteCheckpoint, checkpointState, selfDeviceId, outboxOpCount, now } = args;
  const maxAgeMs = args.maxAgeMs ?? CHECKPOINT_MAX_AGE_MS;
  const threshold = args.threshold ?? OUTBOX_CHECKPOINT_THRESHOLD;

  // Never compact over a checkpoint we could not read. This comes first
  // deliberately: every other branch below would otherwise say yes.
  if (checkpointState === 'unusable') return false;

  if (!remoteCheckpoint) return true;
  if (outboxOpCount > threshold) return true;
  // `now - createdAt` rather than an absolute comparison, so a checkpoint
  // stamped in the future by a device with a skewed clock reads as fresh
  // instead of triggering a recompaction every cycle.
  if (outboxOpCount > 0 && now - remoteCheckpoint.createdAt > maxAgeMs) return true;
  if (!remoteCheckpoint.deviceIds.includes(selfDeviceId)) return true;
  return false;
}

/**
 * The operations this device owes the relay: everything in the local log that
 * the newest checkpoint does not already carry. That set is exactly "created
 * or merged here since the checkpoint I last saw", without needing to track
 * authorship — a merged operation from another device is republished here
 * harmlessly, because `mergeOps` is a union by operation id.
 */
export function selectOutboxOps(
  localOps: ContactOperation[],
  checkpointOpIds: readonly string[],
): ContactOperation[] {
  if (checkpointOpIds.length === 0) return [...localOps];
  const known = new Set(checkpointOpIds);
  return localOps.filter((o) => !known.has(o.operationId));
}

/**
 * Checkpoint sequence numbers start at 1 and only ever go up.
 *
 * R2: the next sequence is taken over BOTH the sequence the relay just served
 * and the highest sequence this device has ever recorded (`syncSeen`). A relay
 * that serves an older checkpoint — or a fetch that could not read the current
 * one — must not be able to walk the sequence backwards, because the chunk
 * tags are `sha256(... 'chunk' ... seq:index)` and a reused sequence would
 * publish chunks straight over the previous generation's.
 */
export function nextCheckpointSeq(remoteSeq: number | null, persistedSeq?: number | null): number {
  const safe = (value: number | null | undefined): number =>
    (typeof value === 'number' && Number.isFinite(value) && value >= 1) ? Math.floor(value) : 0;
  return Math.max(safe(remoteSeq), safe(persistedSeq)) + 1;
}

/**
 * The device-id list for a checkpoint this device is about to publish: the
 * remote list plus this device, capped. At the cap the OLDEST listed device
 * is dropped rather than this one — a device that cannot list itself can
 * never have its outbox read, so it would drop off the rail entirely.
 *
 * R7: this is the ONE cap policy. `publishContactsV2Checkpoint` takes the
 * result verbatim and refuses an over-cap list rather than re-capping with a
 * different rule — a `slice(0, MAX_DEVICE_IDS)` there would drop precisely the
 * local device this function exists to protect.
 */
export function mergeDeviceIds(remote: readonly string[], local: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of remote) {
    if (typeof id !== 'string' || !HEX32.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (!seen.has(local)) out.push(local);
  return out.length <= MAX_DEVICE_IDS ? out : out.slice(out.length - MAX_DEVICE_IDS);
}

/**
 * The `created_at` for the next event this module publishes, in seconds.
 *
 * Strictly monotonic within the process (S12). Two replaceable events with the
 * same `created_at` are resolved by relays on LOWEST EVENT ID, not on latest
 * write — so a retry inside the same second could lose to the very event it
 * was meant to replace. Chunks and a manifest go out back-to-back, which makes
 * that a routine timing, not an exotic one.
 */
let lastEventCreatedAt = 0;
export function nextEventCreatedAt(nowSeconds: number): number {
  const stamp = Math.max(Math.floor(nowSeconds), lastEventCreatedAt + 1);
  lastEventCreatedAt = stamp;
  return stamp;
}

/**
 * Sign and publish an ALREADY-SEALED `content` under `dTag`.
 *
 * ONE event builder for every payload kind (P14): the chunked and unchunked
 * checkpoint paths, the manifest and the outbox all go through here, so the
 * `created_at` policy, the author spelling and the tag shape cannot drift
 * between them. The checkpoint path needs this half on its own because it
 * seals first to discover whether the payload fits at all.
 */
async function publishContent(
  dTag: string,
  content: string,
  backend: DecryptingSigningBackend,
  targets: string[],
): Promise<boolean> {
  const event: UnsignedEvent = {
    kind: CONTACTS_V2_KIND,
    // §3.10: one spelling of a pubkey on this rail. `tagFor` lowercases, the
    // fetch filter lowercases, and the callers refuse a non-lowercase author
    // outright — this keeps the event itself consistent with the tag.
    pubkey: backend.activePublicKeyHex.toLowerCase(),
    created_at: nextEventCreatedAt(Date.now() / 1000),
    tags: [['d', dTag]],
    content,
  };
  try {
    // A connected-but-declining bunker (or a dropped NIP-46 round-trip)
    // rejects `signEvent` rather than resolving it — a refusal like any
    // other on this rail, never an unhandled rejection escaping into the
    // caller's hook effect (global constraint: nothing throws out of a
    // publish). `publishToRelays` itself never throws (`Promise.allSettled`
    // internally), so folding it into the same try adds no new risk.
    const signed = await backend.signEvent(event);
    return await publishToRelays(signed, targets);
  } catch {
    return false;
  }
}

/**
 * Seal `payload` and publish it under `dTag`. Returns false when the payload
 * will not fit an envelope, when the backend's `nip44Encrypt` rejects (a
 * connected signer declining to encrypt), or when no relay accepts it —
 * never throws.
 */
async function publishSealed(
  dTag: string,
  payload: unknown,
  backend: DecryptingSigningBackend,
  targets: string[],
): Promise<boolean> {
  // Pre-merge minor: no `try` here. `sealVaultPayload` fails CLOSED by
  // contract — every failure mode, including a `nip44Encrypt` a bunker
  // refuses, is caught inside it and returned as `null`. A catch around a
  // function that cannot throw reads as if it could, and invites the next
  // reader to assume every seal path is equally defended when the real
  // guarantee lives in one place. `publishContent` keeps its own try, because
  // `signEvent` genuinely can reject.
  const content = await sealVaultPayload(JSON.stringify(payload), backend);
  if (content === null) return false;
  return publishContent(dTag, content, backend, targets);
}

/**
 * Replace THIS device's outbox. A device only ever writes its own outbox tag,
 * which is what makes two devices publishing at once safe: there is no shared
 * replaceable record for them to race over.
 */
export async function publishContactsV2Outbox(args: {
  deviceId: string;
  ops: ContactOperation[];
  baseFrontierMaxClock: number;
  backend: DecryptingSigningBackend;
  relayUrls: string[];
}): Promise<boolean> {
  const targets = args.relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return false;
  if (!HEX32.test(args.deviceId)) return false;
  if (!HEX64.test(args.backend.activePublicKeyHex)) return false;
  // Never publish an information-free record — an empty outbox carries nothing
  // and can only destroy a real one (same rule as every shipped rail).
  if (args.ops.length === 0) return false;
  if (args.ops.length > MAX_OPS_PER_PAYLOAD) return false;

  const payload: OutboxPayload = {
    v: 2,
    kind: 'outbox',
    deviceId: args.deviceId,
    baseFrontierMaxClock: Math.max(0, Math.floor(args.baseFrontierMaxClock) || 0),
    ops: args.ops,
  };
  return publishSealed(
    tagFor(args.backend.activePublicKeyHex, 'outbox', args.deviceId),
    payload,
    args.backend,
    targets,
  );
}

/**
 * Replace the compacted checkpoint. The frontier is DERIVED from `ops` rather
 * than passed in, so it can never disagree with the operations it describes.
 *
 * When the checkpoint will not fit one envelope it is chunked. Ordering is
 * load-bearing: every chunk is published FIRST, and the manifest only after
 * all of them succeeded, so a reader never finds a manifest pointing at a
 * chunk that is not on the relay. A failed chunk aborts with `false` and
 * leaves the previous checkpoint in place — the orphaned chunks sit under
 * tags nothing references and are replaced by the next attempt at that seq.
 *
 * R6: the ceiling here is the WHOLE-checkpoint one. Above
 * `MAX_OPS_PER_PAYLOAD` the single-envelope attempt is skipped outright — a
 * payload that big would be refused by `parseCheckpointPayload` on the way
 * back in, so sealing it would produce a checkpoint nothing can read.
 *
 * The single-envelope-vs-chunk decision is made by MEASURING the JSON body
 * up front (`bodyBytes <= MAX_CHUNK_BODY_BYTES`), not by whether
 * `sealVaultPayload` returns null (fix round 2, Opus review). `sealVaultPayload`
 * fails closed with `null` on ANY failure now — a bad recipient, a signer
 * declining the request, or the payload genuinely not fitting one envelope
 * are all indistinguishable from its return value alone. Deciding by size
 * first means a `null` seal on the single-envelope attempt can only mean
 * "the signer declined": it is refused outright and never falls through to
 * chunking, which would otherwise re-ask the very same declining backend
 * once per chunk instead of failing fast.
 *
 * R7: `deviceIds` arrives already merged by `mergeDeviceIds` and is used
 * VERBATIM. An over-cap, duplicated or malformed list is refused rather than
 * silently re-capped, because a second cap policy here dropped the local
 * device that `mergeDeviceIds` deliberately keeps.
 */
export async function publishContactsV2Checkpoint(args: {
  seq: number;
  deviceIds: string[];
  ops: ContactOperation[];
  /** Milliseconds, same clock as `ContactOperation.createdAt`. */
  now: number;
  backend: DecryptingSigningBackend;
  relayUrls: string[];
}): Promise<boolean> {
  const targets = args.relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return false;
  const author = args.backend.activePublicKeyHex;
  if (!HEX64.test(author)) return false;
  if (args.ops.length === 0) return false;             // information-free guard
  // R6: the whole-checkpoint ceiling, not the per-payload one. Above this the
  // log has outgrown the rail; the hook reports `backupState: 'too-large'` so
  // the user is told rather than quietly losing their backup.
  if (exceedsCheckpointCeiling(args.ops.length)) return false;

  // R7: verbatim, or refuse. Never a second cap policy.
  const deviceIds = args.deviceIds;
  if (deviceIds.length > MAX_DEVICE_IDS) return false;
  if (!deviceIds.every((id) => HEX32.test(id))) return false;
  if (new Set(deviceIds).size !== deviceIds.length) return false;

  const derived = frontierOf(args.ops);
  const payload: CheckpointPayload = {
    v: 2,
    kind: 'checkpoint',
    seq: args.seq,
    createdAt: args.now,
    deviceIds,
    frontier: { maxClock: derived.maxClock, opIds: Array.from(derived.opIds) },
    ops: args.ops,
  };

  const checkpointTag = tagFor(author, 'checkpoint');
  // R6, fix round 2: only attempt the single-envelope form when a reader
  // could parse it back AND the body is measured to fit one envelope BEFORE
  // sealing — `parseCheckpointPayload` refuses above `MAX_OPS_PER_PAYLOAD`,
  // so a bigger checkpoint goes straight to chunking however well it would
  // seal, and a body over `MAX_CHUNK_BODY_BYTES` would not fit the top
  // padding bucket regardless of op count.
  const body = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(body).length;
  if (bodyBytes <= MAX_CHUNK_BODY_BYTES && args.ops.length <= MAX_OPS_PER_PAYLOAD) {
    // The size check above already decided this fits one envelope, so a
    // `null` seal here can only mean the signer declined the request — never
    // a "too big" signal (that distinction no longer exists on
    // `sealVaultPayload`'s return value, which fails closed to `null` on ANY
    // failure). Refuse outright; do NOT fall through to chunking, which would
    // only re-ask the same declining backend once per chunk. P14: the event
    // itself is built by `publishContent`, the same builder every other
    // payload kind uses.
    const sealed = await sealVaultPayload(body, args.backend);
    if (sealed === null) return false;
    return publishContent(checkpointTag, sealed, args.backend, targets);
  }

  const split = splitCheckpoint(payload, (index) => tagFor(author, 'chunk', chunkExtra(args.seq, index)));
  if (!split) return false;
  for (const chunk of split.chunks) {
    const ok = await publishSealed(
      tagFor(author, 'chunk', chunkExtra(args.seq, chunk.index)),
      chunk,
      args.backend,
      targets,
    );
    if (!ok) return false;
  }
  // The manifest itself can in principle be too large to seal (a very long
  // device list). `publishSealed` returns false and the previous checkpoint
  // stands — a refused publish, never a dangling manifest.
  return publishSealed(checkpointTag, split.manifest, args.backend, targets);
}

export interface ContactsV2RemoteCheckpoint {
  seq: number;
  /** Milliseconds, from the payload. */
  createdAt: number;
  deviceIds: string[];
  /**
   * The operation ids the checkpoint carries. DERIVED from its operations, not
   * read from the wire `frontier` — a chunked checkpoint's manifest carries no
   * op-id list at all, and deriving keeps the two cases identical.
   */
  frontierOpIds: string[];
  /** The wire frontier's clock, for the next outbox's `baseFrontierMaxClock`. */
  frontierMaxClock: number;
  /** The relay event, for `syncSeen`. */
  eventId: string;
  /** Seconds, the event's own `created_at`. */
  eventCreatedAt: number;
}

export interface ContactsV2Remote {
  /**
   * Everything the relay could produce: checkpoint operations plus every
   * outbox. F1: aggregate ceiling is `MAX_CHECKPOINT_OPS` (the checkpoint,
   * already bounded there) plus `MAX_DEVICE_IDS` outboxes at
   * `MAX_OPS_PER_PAYLOAD` each — worst case 64 000 + 16 × 2000 = 96 000
   * operations for one fetch, before `mergeOps` collapses id duplicates.
   */
  ops: ContactOperation[];
  /** The checkpoint this device may treat as the one to compact over. Null unless `checkpointState` is `'present'`. */
  checkpoint: ContactsV2RemoteCheckpoint | null;
  /** R2: `'absent'` (no event), `'present'` (adopted), `'unusable'` (an event exists but we may not act on it). */
  checkpointState: CheckpointState;
  reachableRelays: number;
}

/** Per-tag decrypt cache factory (§11.1.10). One rail, many `d` tags. */
export type CacheForTag = (tag: string) => SyncDecryptCache | undefined;

/**
 * F1: defence in depth against a relay that ignores — or only loosely
 * honours — the `#d` filter. `fetchNewestFromRelays` already pins the
 * author; this pins the tag too, so a relay that returns "everything by
 * this author" (or a stale/foreign event under this querier's own id
 * bookkeeping) cannot be mistaken for the record this call asked for.
 */
function eventCarriesTag(event: NostrEvent, dTag: string): boolean {
  return event.tags.some((t) => t[0] === 'd' && t[1] === dTag);
}

/**
 * Fetch and open one `d` tag. Returns null for "nothing usable there".
 *
 * `eventId` and `createdAt` come back because the caller needs them: the
 * checkpoint's event id and `created_at` are what `syncSeen` records, and the
 * `createdAt` is half of R2's rollback guard.
 */
async function readTag(
  dTag: string,
  authorPubkey: string,
  backend: DecryptingSigningBackend,
  targets: string[],
  cacheFor?: CacheForTag,
): Promise<{ plaintext: string; eventId: string; createdAt: number } | null> {
  const { event } = await fetchNewestFromRelays(
    { kinds: [CONTACTS_V2_KIND], authors: [authorPubkey], '#d': [dTag], limit: 1 },
    targets,
    authorPubkey,
  );
  if (!event) return null;
  if (!eventCarriesTag(event, dTag)) return null;
  try {
    const plaintext = await readSyncPlaintext(
      cacheFor?.(dTag),
      event,
      // S5: no legacy fallback on this rail, ever. It never had a v1 format,
      // and one fetch opens up to 49 relay-supplied strings.
      () => openVaultPayloadOrThrow(event.content, backend, authorPubkey, { legacyFallback: false }),
    );
    return { plaintext, eventId: event.id, createdAt: event.created_at };
  } catch {
    return null;
  }
}

/**
 * Read the whole rail: the checkpoint (or its manifest plus every chunk),
 * then every outbox the checkpoint names plus this device's own.
 *
 * There is deliberately no `sinceCreatedAt` cursor. The checkpoint and the
 * outboxes move independently, so a cursor on the checkpoint would suppress
 * outbox reads; cost is handled by the per-tag decrypt cache instead, and
 * correctness by `mergeOps` being a union (re-reading is idempotent). The
 * rollback protection a cursor would have given is provided instead by
 * `args.persisted`, which refuses to ADOPT an older checkpoint without
 * refusing to READ it.
 *
 * `'unreachable'` means the pool could not answer the CHECKPOINT query — the
 * one query that must succeed for a fetch to mean anything. `null` means a
 * malformed author, which is a caller bug rather than a relay fact.
 */
export async function fetchContactsV2Sync(args: {
  authorPubkey: string;
  backend: DecryptingSigningBackend;
  relayUrls: string[];
  localDeviceId: string;
  /** What this device recorded for the checkpoint tag last time (R2). */
  persisted?: { seq: number | null; eventCreatedAt: number | null };
  cacheFor?: CacheForTag;
}): Promise<ContactsV2Remote | null | 'unreachable'> {
  const { backend, localDeviceId, cacheFor } = args;
  // F1: the author gate comes FIRST, ahead of the empty-pool check — a
  // malformed author is a caller bug regardless of what `relayUrls` holds,
  // and returning 'unreachable' for it would misreport a caller bug as a
  // relay-pool problem.
  // §3.10: one spelling. The tag is derived from the lowercase author and
  // `fetchNewestFromRelays` pins the author case-insensitively, so normalise
  // once here rather than leaving two namespaces reachable.
  const authorPubkey = args.authorPubkey.toLowerCase();
  if (!HEX64.test(authorPubkey)) return null;

  const targets = args.relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return 'unreachable';

  const persistedSeq = args.persisted?.seq ?? null;
  const persistedCreatedAt = args.persisted?.eventCreatedAt ?? null;

  const checkpointTag = tagFor(authorPubkey, 'checkpoint');
  const probe = await fetchNewestFromRelays(
    { kinds: [CONTACTS_V2_KIND], authors: [authorPubkey], '#d': [checkpointTag], limit: 1 },
    targets,
    authorPubkey,
  );
  if (probe.reachableRelays === 0) return 'unreachable';
  // F1: same tag-pin as `readTag` — a relay that ignores the `#d` filter
  // must not be able to hand back some OTHER event under this author as
  // "the checkpoint".
  const probeEvent = probe.event && eventCarriesTag(probe.event, checkpointTag) ? probe.event : null;

  let checkpoint: ContactsV2RemoteCheckpoint | null = null;
  let checkpointState: CheckpointState = 'absent';
  let checkpointOps: ContactOperation[] = [];
  // Device ids we LEARNED about, even from a checkpoint we refuse to adopt.
  // Reading another device's outbox can only add operations, so discovering
  // more of them is always safe.
  let discoveredDeviceIds: string[] = [];

  if (probeEvent) {
    const event = probeEvent;
    // A checkpoint event EXISTS from here on. Every failure below is
    // 'unusable', never 'absent' — that is the whole of R2.
    checkpointState = 'unusable';

    let plaintext: string | null = null;
    try {
      plaintext = await readSyncPlaintext(
        cacheFor?.(checkpointTag),
        event,
        () => openVaultPayloadOrThrow(event.content, backend, authorPubkey, { legacyFallback: false }),
      );
    } catch {
      plaintext = null;
    }

    let candidate: ContactsV2RemoteCheckpoint | null = null;
    let candidateOps: ContactOperation[] = [];

    if (plaintext !== null) {
      const direct = parseCheckpointPayload(plaintext);
      if (direct) {
        candidateOps = direct.ops;
        candidate = {
          seq: direct.seq,
          createdAt: direct.createdAt,
          deviceIds: direct.deviceIds,
          frontierOpIds: direct.ops.map((o) => o.operationId),
          frontierMaxClock: direct.frontier.maxClock,
          eventId: event.id,
          eventCreatedAt: event.created_at,
        };
      } else {
        const manifest = parseManifest(plaintext);
        if (manifest) {
          const received: ReceivedChunk[] = [];
          for (const [index, chunkTag] of manifest.chunkTags.entries()) {
            // F1: recompute the chunk tag from (seq, index) rather than
            // trusting the manifest's own list verbatim — a manifest whose
            // `chunkTags` were tampered post-parse (or that simply names a
            // slot's tag wrong) must not be followed to wherever it points.
            const expectedTag = tagFor(authorPubkey, 'chunk', chunkExtra(manifest.seq, index));
            if (chunkTag !== expectedTag) { received.length = 0; break; }
            const read = await readTag(expectedTag, authorPubkey, backend, targets, cacheFor);
            const parsed = read ? parseChunkPayload(read.plaintext) : null;
            // Index is pinned to the manifest's own ordering — a chunk that
            // claims a different slot is not the one we asked for. The
            // CONTENTS are pinned by the manifest's digest inside
            // `reassembleChunks`.
            if (!read || !parsed || parsed.index !== index) { received.length = 0; break; }
            received.push({ payload: parsed, plaintext: read.plaintext });
          }
          const rebuilt = received.length === manifest.chunkTags.length
            ? reassembleChunks(manifest, received)
            : null;
          // A partially-readable chunked checkpoint is discarded WHOLE. Half a
          // checkpoint looks exactly like a log with records deleted, which is
          // the one thing this rail must never produce.
          if (rebuilt) {
            candidateOps = rebuilt;
            candidate = {
              seq: manifest.seq,
              createdAt: manifest.createdAt,
              deviceIds: manifest.deviceIds,
              frontierOpIds: rebuilt.map((o) => o.operationId),
              frontierMaxClock: manifest.frontier.maxClock,
              eventId: event.id,
              eventCreatedAt: event.created_at,
            };
          }
        }
      }
    }

    if (candidate) {
      discoveredDeviceIds = candidate.deviceIds;
      // R2 rollback guard. A relay — or one misbehaving relay in a pool — can
      // serve an older replaceable record; adopting its `seq` and republishing
      // at `oldSeq + 1` is a relay-driven history rewrite.
      const rolledBack =
        (persistedSeq !== null && candidate.seq < persistedSeq)
        || (persistedCreatedAt !== null && candidate.eventCreatedAt < persistedCreatedAt);
      if (rolledBack) {
        // Its operations are still merged below: `mergeOps` is a union by
        // operation id, so re-reading an older record can only ADD. What is
        // refused is ADOPTING it as the checkpoint to compact over.
        checkpointOps = candidateOps;
      } else {
        checkpoint = candidate;
        checkpointState = 'present';
        checkpointOps = candidateOps;
      }
    }
  }

  // Every outbox the checkpoint named, plus our own — a device that has never
  // checkpointed is not listed anywhere, so without the local id its own
  // unmerged operations would be invisible to it after a reinstall.
  // F1: this is at most `MAX_DEVICE_IDS` sequential relay-pool reads — the R7
  // cap is what keeps this fan-out bounded; nothing further limits it here.
  const deviceIds = mergeDeviceIds(discoveredDeviceIds, localDeviceId);
  const outboxOps: ContactOperation[] = [];
  for (const deviceId of deviceIds) {
    const read = await readTag(tagFor(authorPubkey, 'outbox', deviceId), authorPubkey, backend, targets, cacheFor);
    if (!read) continue;
    const parsed = parseOutboxPayload(read.plaintext);
    // A payload published under device X's tag but claiming to be device Y is
    // a relabelled record; ignore it rather than merging a lie about origin.
    if (!parsed || parsed.deviceId !== deviceId) continue;
    outboxOps.push(...parsed.ops);
  }

  // Union by operation id. Ordering, conflict resolution and tombstones are
  // the reducer's job, not this module's. F1: argument order matters on a
  // (vanishingly unlikely — operation ids are immutable) id collision —
  // `mergeOps(local, remote)` lets `local` win, and `checkpointOps` is passed
  // in that slot, so the checkpoint's own copy of an operation wins over an
  // outbox's copy of the same id, never the reverse.
  const { ops } = mergeOps(checkpointOps, outboxOps);
  return { ops, checkpoint, checkpointState, reachableRelays: probe.reachableRelays };
}
