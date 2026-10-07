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
  hmacUploaderBackend, AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, type UploaderBackend,
} from './blossom-uploader';
import { deleteFromBlossom, BlossomDeleteError } from './blossom';
import { listIdentityStoreRows } from './db';
import {
  OLD_PHOTO_DELETED_COPY, OLD_PHOTO_NOT_DELETED_COPY, OLD_PICTURE_DELETED_COPY, OLD_PICTURE_NOT_DELETED_COPY,
  withBlobHost,
} from './blob-deletion-copy';

/** `deleted`: gone (2xx or 404). `failed`: the server refused or was unreachable. `kept`: still referenced, or could not be checked, so nothing was sent. */
export type DeleteOutcome = 'deleted' | 'failed' | 'kept';

const HEX64 = /^[0-9a-f]{64}$/;

/** Every slot field that names a Blossom blob by hash. */
const SLOT_HASH_FIELDS = ['pictureBlossomHash', 'bannerBlossomHash', 'avatarHash', 'contactAvatarHash'] as const;

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
  /** The unlock key: the uploader secret is stored encrypted under it. */
  encryptionKey: string;
  /** Test seam. Defaults to the stored `identity` rows. */
  loadRows?: () => Promise<readonly unknown[]>;
  fetchImpl?: typeof fetch;
}

/** Delete one of this install's blobs, unless something still references it. Never throws. */
export async function deleteOwnedBlob(args: DeleteOwnedBlobArgs): Promise<DeleteOutcome> {
  const { server, domain, encryptionKey } = args;
  const hash = args.hash.toLowerCase();
  if (!HEX64.test(hash) || !server) return 'failed';

  try {
    const rows = await (args.loadRows ?? listIdentityStoreRows)();
    if (isBlobReferenced(hash, rows)) return 'kept';
  } catch {
    // Cannot prove nothing references it: leave the blob alone.
    return 'kept';
  }

  let backend: UploaderBackend | null = null;
  try {
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

/** The Blossom blobs one slot points at (private avatar, then the #242 share copy). */
export interface SlotBlobs {
  avatar?: { hash: string; server: string };
  share?: { hash: string; server: string };
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
  return { avatar: pair(slot.avatarHash, slot.avatarBlossomUrl), share: pair(slot.contactAvatarHash, slot.contactAvatarBlossomUrl) };
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
