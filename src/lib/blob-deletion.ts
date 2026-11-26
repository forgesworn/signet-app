/**
 * Deleting old pictures from Blossom (design 2026-10-07 §2, rules R1 to R6).
 *
 * A picture, banner or photo that is removed or replaced leaves its blob on the
 * Blossom server unless this install deletes it. The delete is signed by the
 * HMAC uploader of the field's domain (`hmacUploaderBackend`), rebuilt from the
 * blob's hash, so only the install that uploaded can delete.
 *
 * - R1: a blob that any stored slot or identity still references is never
 *   deleted. The same bytes give the same hash, so a public picture can be
 *   shared between slots, and the venue photo lives on `photoHash`, not a slot.
 *   The check reads the stored rows at delete time, never a React copy.
 * - R6: 2xx and 404 count as deleted; anything else (401/403 for a blob
 *   uploaded before uploader keys, a network error) is a failure. This module
 *   never throws, so a delete can never block the save or remove it follows.
 *
 * Callers decide WHEN to delete (R2 to R5); this module decides whether it is
 * safe and how it went.
 */

import {
  hmacUploaderBackend, AVATAR_UPLOADER_DOMAIN, BACKDROP_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN,
  CONTACT_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN, PUBLIC_PICTURE_UPLOADER_DOMAIN, type UploaderBackend,
} from './blossom-uploader';
import { deleteFromBlossom, BlossomDeleteError } from './blossom';
import { listIdentityStoreRows, putBlobOrphanRow, listBlobOrphanRows, deleteBlobOrphanRow } from './db';
import {
  OLD_PHOTO_DELETED_COPY, OLD_PHOTO_NOT_DELETED_COPY, OLD_PICTURE_DELETED_COPY, OLD_PICTURE_NOT_DELETED_COPY,
  withBlobHost,
} from './blob-deletion-copy';

/** `deleted`: gone (2xx or 404). `failed`: the server refused or was unreachable. `kept`: still referenced, or could not be checked, so nothing was sent. */
export type DeleteOutcome = 'deleted' | 'failed' | 'kept';

const HEX64 = /^[0-9a-f]{64}$/;

/** Every slot field that names a Blossom blob by hash. */
const SLOT_HASH_FIELDS = ['pictureBlossomHash', 'bannerBlossomHash', 'avatarHash', 'contactAvatarHash', 'backdropHash'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function addHash(out: Set<string>, v: unknown): void {
  if (typeof v === 'string' && v) out.add(v.toLowerCase());
}

function addSlot(out: Set<string>, slot: unknown): void {
  if (!isRecord(slot)) return;
  for (const f of SLOT_HASH_FIELDS) addHash(out, slot[f]);
  for (const h of publishedBlobHashes(slot.publicProfileBase as { content?: unknown } | undefined)) out.add(h);
}

/**
 * The Blossom blobs the PUBLISHED kind-0 of a slot shows: the hashes at the end
 * of the `picture` and `banner` URLs in the stored `publicProfileBase` (the
 * kind-0 as last published or matched). This is the durable record of "the
 * live profile still shows it": unlike the slot's own hash fields it survives
 * a "Save locally for now" (saved `h1`, published `h0`) and a remount. A URL
 * that is not `{server}/{hash}` (an external link) contributes nothing.
 */
export function publishedBlobHashes(base: { content?: unknown } | null | undefined): string[] {
  if (!isRecord(base) || typeof base.content !== 'string') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(base.content); } catch { return []; }
  if (!isRecord(parsed)) return [];
  const out: string[] = [];
  for (const field of ['picture', 'banner'] as const) {
    const url = parsed[field];
    if (typeof url !== 'string') continue;
    const m = /\/([0-9a-f]{64})$/i.exec(url);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

/**
 * Every Blossom hash named by the given stored rows (identity and dependant
 * rows): each slot's picture, banner, avatar and share copy, and the venue
 * photo on `photoHash`. Rows are read defensively: a marker row or a malformed
 * one simply contributes nothing.
 */
export function collectReferencedHashes(rows: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    addHash(out, row.photoHash);
    addSlot(out, row.naturalPerson);
    addSlot(out, row.persona);
    addSlot(out, row.professionalPersona);
    if (Array.isArray(row.extraPersonas)) for (const p of row.extraPersonas) addSlot(out, p);
  }
  return out;
}

/** R1: does any of these stored rows still reference `hash`? */
export function isBlobReferenced(hash: string, rows: readonly unknown[]): boolean {
  return collectReferencedHashes(rows).has(hash.toLowerCase());
}

/**
 * The Blossom server holding the blob at `url`, or null when `url` is not
 * `{server}/{hash}` (a pasted external link, which was never uploaded here).
 */
export function serverFromBlobUrl(url: string | undefined, hash: string): string | null {
  if (!url || !HEX64.test(hash)) return null;
  const suffix = `/${hash}`;
  if (!url.toLowerCase().endsWith(suffix)) return null;
  const base = url.slice(0, url.length - suffix.length);
  return base ? base : null;
}

export interface DeleteOwnedBlobArgs {
  /** sha256 hex of the blob's exact bytes (lowercase). */
  hash: string;
  /** Base URL of the Blossom server that holds it. */
  server: string;
  /** The uploader domain the blob was uploaded under (`*_UPLOADER_DOMAIN`). */
  domain: string;
  /**
   * The unlock key: the uploader secret is stored encrypted under it. Null when
   * the app is locked or the handler never had the key: nothing is sent then,
   * and the answer is `kept` (silent), never a "Couldn't delete" for a request
   * the server was never asked (M1).
   */
  encryptionKey: string | null;
  /** Test seam. Defaults to the stored `identity` rows. */
  loadRows?: () => Promise<readonly unknown[]>;
  fetchImpl?: typeof fetch;
}

/** Delete one of this install's blobs, unless something still references it. Never throws. */
export async function deleteOwnedBlob(args: DeleteOwnedBlobArgs): Promise<DeleteOutcome> {
  const { server, domain, encryptionKey } = args;
  const hash = args.hash.toLowerCase();
  if (!HEX64.test(hash) || !server) return 'failed';
  if (!encryptionKey) return 'kept';

  try {
    const rows = await (args.loadRows ?? listIdentityStoreRows)();
    if (isBlobReferenced(hash, rows)) return 'kept';
  } catch {
    // Cannot prove nothing references it: leave the blob alone.
    return 'kept';
  }

  let backend: UploaderBackend | null = null;
  try {
    // M7: this may MINT the install's uploader secret (getOrCreateUploaderSecret)
    // on a fresh install, as a side effect of a delete that is then refused with
    // 401/403 because the blob was not ours. Harmless: the secret is random,
    // local and sealed, and the next upload would mint the same thing.
    backend = await hmacUploaderBackend(domain, hash, encryptionKey);
    await deleteFromBlossom(hash, server, backend, args.fetchImpl ?? fetch);
    return 'deleted';
  } catch (err) {
    if (err instanceof BlossomDeleteError && err.status === 404) return 'deleted';
    return 'failed';
  } finally {
    backend?.destroy();
  }
}

/** The one-line result for an outcome, or undefined when nothing should be said (`kept`). */
export function blobDeletionNote(kind: 'photo' | 'picture', outcome: DeleteOutcome, server: string): string | undefined {
  if (outcome === 'kept') return undefined;
  const template = kind === 'photo'
    ? (outcome === 'deleted' ? OLD_PHOTO_DELETED_COPY : OLD_PHOTO_NOT_DELETED_COPY)
    : (outcome === 'deleted' ? OLD_PICTURE_DELETED_COPY : OLD_PICTURE_NOT_DELETED_COPY);
  return withBlobHost(template, server);
}

/** The Blossom blobs one slot points at (private avatar, the #242 share copy, the guardian-set card backdrop). */
export interface SlotBlobs {
  avatar?: { hash: string; server: string };
  share?: { hash: string; server: string };
  backdrop?: { hash: string; server: string };
}

/**
 * The blobs on the slot `target` of an identity or dependant: `'natural-person'`,
 * `'persona'`, or an extra persona's pubkey. Read it BEFORE the change that
 * replaces or clears them.
 */
export function findSlotBlobs(
  holder: { naturalPerson?: unknown; persona?: unknown; extraPersonas?: readonly unknown[] } | null | undefined,
  target: string,
): SlotBlobs {
  if (!holder) return {};
  const slot = target === 'natural-person' ? holder.naturalPerson
    : target === 'persona' ? holder.persona
    : holder.extraPersonas?.find(p => isRecord(p) && p.publicKey === target);
  if (!isRecord(slot)) return {};
  const pair = (hash: unknown, server: unknown) =>
    typeof hash === 'string' && HEX64.test(hash.toLowerCase()) && typeof server === 'string' && server
      ? { hash: hash.toLowerCase(), server }
      : undefined;
  return {
    avatar: pair(slot.avatarHash, slot.avatarBlossomUrl),
    share: pair(slot.contactAvatarHash, slot.contactAvatarBlossomUrl),
    backdrop: pair(slot.backdropHash, slot.backdropBlossomUrl),
  };
}

/** Deletes one blob under an uploader domain (the App binds the unlock key). */
export type BlobDeleter = (domain: string, hash: string, server: string) => Promise<DeleteOutcome>;

/**
 * R3: delete the private avatar a Change or Remove just replaced, once nothing
 * points at it, and say how it went. A re-upload of the same bytes (same hash)
 * deletes nothing.
 */
export async function deleteReplacedAvatar(
  old: { hash: string; server: string } | undefined,
  newHash: string | undefined,
  del: BlobDeleter,
): Promise<string | undefined> {
  if (!old || old.hash === newHash?.toLowerCase()) return undefined;
  return blobDeletionNote('photo', await del(AVATAR_UPLOADER_DOMAIN, old.hash, old.server), old.server);
}

/**
 * R5: Stop sharing deletes the share blob (after the pointer is retracted).
 * Only Stop sharing does: a NEW share copy after a picture change never
 * deletes the previous one, because Kinterest child consent fetches it by hash.
 */
export async function deleteStoppedShareCopy(
  share: { hash: string; server: string } | undefined,
  del: BlobDeleter,
): Promise<string | undefined> {
  if (!share) return undefined;
  return blobDeletionNote('photo', await del(CONTACT_AVATAR_UPLOADER_DOMAIN, share.hash, share.server), share.server);
}

/**
 * Delete the guardian-set card backdrop a replace or remove just superseded,
 * once nothing points at it (R1 is enforced by the deleter: it reads the stored
 * rows, so the caller must have saved the new slot fields first). Signed by the
 * backdrop-domain HMAC uploader. A re-pick of identical bytes (same hash)
 * deletes nothing. Silent: the outcome is for tests and diagnostics, because a
 * backdrop is not a user-visible "photo" the way an avatar is.
 */
export async function deleteReplacedBackdrop(
  old: { hash: string; server: string } | undefined,
  newHash: string | undefined,
  del: BlobDeleter,
): Promise<DeleteOutcome | undefined> {
  if (!old || old.hash === newHash?.toLowerCase()) return undefined;
  return del(BACKDROP_UPLOADER_DOMAIN, old.hash, old.server);
}

// --- Orphaned uploads (gap 5) ---
//
// An upload that nothing will point at (superseded, refused, or the app locked
// before its pointer was saved) is deleted at once when this install can sign
// the delete. When it cannot (locked: the uploader secret is sealed under the
// unlock key) or the server could not be reached, the blob is recorded as an
// orphan instead, and the next unlock's sweep deletes it. Uploads are never
// registered with the publish flush (`lock-after-flush`): the lock does not
// wait for them.

/** At most this many orphan rows; recording one more drops the oldest. */
export const BLOB_ORPHAN_CAP = 50;
/** A delete that fails this many times (refused, unreachable) is given up. */
export const BLOB_ORPHAN_MAX_ATTEMPTS = 5;

const ORPHAN_ID_PREFIX = 'blob-orphan:';
const UPLOADER_DOMAINS: ReadonlySet<string> = new Set([
  AVATAR_UPLOADER_DOMAIN, BACKDROP_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN,
  CONTACT_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN, PUBLIC_PICTURE_UPLOADER_DOMAIN,
]);

export interface OrphanBlob {
  /** The uploader domain the blob was uploaded under. */
  domain: string;
  /** sha256 hex, lowercase. */
  hash: string;
  /** Base URL of the Blossom server holding it (https). */
  url: string;
  addedAt: number;
  attempts: number;
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

/** A stored orphan row, or null when it is junk (any field malformed, or an id that does not match its hash). */
export function parseOrphanBlob(raw: unknown): OrphanBlob | null {
  if (!isRecord(raw)) return null;
  const { id, domain, hash, url, addedAt, attempts } = raw;
  if (typeof domain !== 'string' || !UPLOADER_DOMAINS.has(domain)) return null;
  if (typeof hash !== 'string' || !HEX64.test(hash)) return null;
  if (id !== undefined && id !== ORPHAN_ID_PREFIX + hash) return null;
  if (!isHttpsUrl(url)) return null;
  if (typeof addedAt !== 'number' || !Number.isFinite(addedAt) || addedAt < 0) return null;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0 || attempts >= BLOB_ORPHAN_MAX_ATTEMPTS) return null;
  return { domain, hash, url, addedAt, attempts };
}

function rowId(raw: unknown): string | null {
  return isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
}

/**
 * Remember an uploaded blob nothing points at, for the next unlock's sweep.
 * Needs no key (it runs at lock time). Never throws. Recording a hash already
 * recorded keeps the earlier row and its attempt count. Over the cap, the
 * oldest rows (and any junk) are dropped.
 */
export async function recordOrphanBlob(
  entry: { domain: string; hash: string; url: string },
  now: number = Date.now(),
): Promise<void> {
  try {
    const parsed = parseOrphanBlob({ ...entry, hash: entry.hash.toLowerCase(), addedAt: now, attempts: 0 });
    if (!parsed) return;
    const rows = await listBlobOrphanRows();
    if (!rows.some(r => rowId(r) === ORPHAN_ID_PREFIX + parsed.hash && parseOrphanBlob(r))) {
      await putBlobOrphanRow(parsed);
      rows.push({ id: ORPHAN_ID_PREFIX + parsed.hash, ...parsed });
    }
    const valid: Array<{ id: string; addedAt: number }> = [];
    for (const r of rows) {
      const id = rowId(r);
      if (!id) continue;
      const o = parseOrphanBlob(r);
      if (!o) { await deleteBlobOrphanRow(id); continue; }
      if (!valid.some(v => v.id === id)) valid.push({ id, addedAt: o.addedAt });
    }
    valid.sort((a, b) => a.addedAt - b.addedAt);
    for (const v of valid.slice(0, Math.max(0, valid.length - BLOB_ORPHAN_CAP))) await deleteBlobOrphanRow(v.id);
  } catch {
    // Best effort: an orphan that cannot be recorded stays on the server, as before.
  }
}

/**
 * Throw away a blob just uploaded that nothing will point at. Deleted now when
 * the key is still live; otherwise (locked, or the server could not be reached)
 * recorded for the sweep. Never throws.
 */
export async function discardUpload(args: {
  domain: string;
  hash: string;
  server: string;
  /** Whether the unlock key the upload started under is still the live one. */
  live: boolean;
  deleteBlob: BlobDeleter;
  recordOrphan?: (entry: { domain: string; hash: string; url: string }) => Promise<void>;
}): Promise<void> {
  const record = args.recordOrphan ?? recordOrphanBlob;
  const entry = { domain: args.domain, hash: args.hash, url: args.server };
  try {
    if (!args.live) { await record(entry); return; }
    if (await args.deleteBlob(args.domain, args.hash, args.server) === 'failed') await record(entry);
  } catch { /* never throws */ }
}

/** One blob this install uploaded, to be deleted when its slot goes. */
export interface SlotBlobToDelete { domain: string; hash: string; server: string }

/**
 * The private-avatar and guardian-backdrop blobs on a dependant's (or
 * identity's) slots: every slot (real-name, persona, extras), or only
 * `targets`. Never the #242 share copy (only Stop sharing deletes that). One
 * entry per hash, since two slots may point at the same bytes. Read it BEFORE
 * the change that clears them.
 */
export function collectSlotBlobsToDelete(
  holder: { naturalPerson?: unknown; persona?: unknown; extraPersonas?: readonly unknown[] } | null | undefined,
  kinds: ReadonlyArray<'avatar' | 'backdrop'>,
  targets?: readonly string[],
): SlotBlobToDelete[] {
  if (!holder) return [];
  const all = ['natural-person', 'persona',
    ...(holder.extraPersonas ?? []).flatMap(p => (isRecord(p) && typeof p.publicKey === 'string' ? [p.publicKey] : []))];
  const out: SlotBlobToDelete[] = [];
  const seen = new Set<string>();
  for (const target of targets ?? all) {
    const blobs = findSlotBlobs(holder, target);
    for (const kind of kinds) {
      const b = blobs[kind];
      if (!b || seen.has(`${kind}:${b.hash}`)) continue;
      seen.add(`${kind}:${b.hash}`);
      out.push({ domain: kind === 'avatar' ? AVATAR_UPLOADER_DOMAIN : BACKDROP_UPLOADER_DOMAIN, hash: b.hash, server: b.server });
    }
  }
  return out;
}

/**
 * Delete blobs whose slot is already gone (removal, unpair), after the record
 * stopped pointing at them. Best effort, never throws, never blocks the
 * removal. Each goes through the App deleter (R1: a blob some other stored row
 * still references is kept). A blob that cannot be deleted because the app is
 * locked (checked again after each attempt, since the lock can land mid-run),
 * or whose server could not be reached, is recorded as an orphan for the next
 * unlock's sweep.
 */
export async function deleteRemovedBlobs(blobs: readonly SlotBlobToDelete[], args: {
  deleteBlob: BlobDeleter;
  isLive: () => boolean;
  recordOrphan?: (entry: { domain: string; hash: string; url: string }) => Promise<void>;
}): Promise<void> {
  const record = args.recordOrphan ?? recordOrphanBlob;
  for (const b of blobs) {
    const entry = { domain: b.domain, hash: b.hash, url: b.server };
    try {
      if (!args.isLive()) { await record(entry); continue; }
      const outcome = await args.deleteBlob(b.domain, b.hash, b.server);
      if (outcome === 'failed' || (outcome === 'kept' && !args.isLive())) await record(entry);
    } catch { /* never throws */ }
  }
}

export interface SweepResult { deleted: number; dropped: number; retried: number; stopped: boolean }

/**
 * Delete every recorded orphan this install can (once per unlock). For each
 * entry: still referenced by a stored row (R1) → keep the blob, drop the entry;
 * deleted (2xx or 404) → drop; failed → count an attempt, drop after
 * `BLOB_ORPHAN_MAX_ATTEMPTS`. `deleter` must be bound to the sweep's own key,
 * and the pass stops, leaving every remaining entry as it is, as soon as that
 * key is no longer live (or the deleter answers `kept` for a blob nothing
 * references, which means it could not act). Junk rows are dropped. Never throws.
 */
export async function sweepOrphanBlobs(args: {
  deleter: BlobDeleter;
  isLive: () => boolean;
  loadRows?: () => Promise<readonly unknown[]>;
}): Promise<SweepResult> {
  const out: SweepResult = { deleted: 0, dropped: 0, retried: 0, stopped: false };
  try {
    const stored = await listBlobOrphanRows();
    for (const raw of stored) {
      if (!args.isLive()) { out.stopped = true; break; }
      const id = rowId(raw);
      if (!id) continue;
      const entry = parseOrphanBlob(raw);
      if (!entry) { await deleteBlobOrphanRow(id); out.dropped++; continue; }
      let referenced: boolean;
      try {
        referenced = isBlobReferenced(entry.hash, await (args.loadRows ?? listIdentityStoreRows)());
      } catch { out.stopped = true; break; }
      if (referenced) { await deleteBlobOrphanRow(id); out.dropped++; continue; }
      const outcome = await args.deleter(entry.domain, entry.hash, entry.url);
      if (!args.isLive()) { out.stopped = true; break; }
      if (outcome === 'deleted') { await deleteBlobOrphanRow(id); out.deleted++; continue; }
      if (outcome === 'kept') { out.stopped = true; break; }
      const attempts = entry.attempts + 1;
      if (attempts >= BLOB_ORPHAN_MAX_ATTEMPTS) { await deleteBlobOrphanRow(id); out.dropped++; }
      else { await putBlobOrphanRow({ ...entry, attempts }); out.retried++; }
    }
  } catch { out.stopped = true; }
  return out;
}
