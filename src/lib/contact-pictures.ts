/**
 * Contact pictures: small encrypted thumbnails kept on this device.
 *
 * Two kinds, both in the `contactPictures` store (DB v27), never on any sync
 * rail or contacts operation:
 * - `kind0:<pubkey>` — a contact's kind-0 `picture`, DOWNLOADED ONLY on an
 *   explicit user action (the follows import, or "Refresh pictures" on the
 *   Contacts page), each time after the consent step. Never in the
 *   background, on unlock, or while browsing. Keyed by pubkey, so one
 *   download serves every directory that holds that contact.
 * - `own:<directoryId>:<contactId>` — a picture the user chose for a contact.
 *   Always wins; a refresh never touches it.
 *
 * Display precedence (see `useContactPicture`): own picture > the #242 shared
 * encrypted avatar > the downloaded kind-0 thumbnail > initials.
 *
 * Not on a paired-child install: nothing downloads there (own pictures are
 * allowed).
 */

import type { Kind0Profile } from './nostr-follows';
import { downloadPictureBytes } from './picture-download';
import { makeThumbnail } from './picture-thumbnail';
import { kind0PictureId, ownPictureId, contactPictureGeneration, ContactPicturesLockedError, type ContactPicture } from './contact-picture-crypto';
import { saveContactPicture, deleteContactPicture, listContactPictures, listAllContactRecordsV2 } from './db';
import { primaryIdentityPubkey } from './contacts-v2-list';
import type { ContactRecord } from '../types';

export const PICTURE_DOWNLOAD_CONCURRENCY = 4;
/** The file picker filter (the header gate still decides what is accepted). */
export const OWN_PICTURE_ACCEPT = 'image/*';
/** Largest file accepted from the file picker. */
export const OWN_PICTURE_MAX_FILE_BYTES = 20 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

export interface PictureRunResult {
  /** Pictures newly downloaded and stored this run. */
  downloaded: number;
  /** Pictures that changed (or were new) but could not be downloaded. The old thumbnail, if any, is kept. */
  failed: number;
  /** Stored thumbnails dropped because the profile no longer has a picture. */
  removed: number;
  /** Pictures whose URL had not changed — not downloaded again. */
  unchanged: number;
}

export interface ApplyKind0PicturesDeps {
  /** The `sourceUrl` of each pubkey's stored `kind0:` thumbnail. */
  stored: ReadonlyMap<string, string | undefined>;
  download: (url: string) => Promise<Uint8Array | null>;
  thumbnail: (bytes: Uint8Array) => Promise<Uint8Array | null>;
  save: (pubkey: string, jpeg: Uint8Array, sourceUrl: string) => Promise<void>;
  remove: (pubkey: string) => Promise<void>;
  concurrency?: number;
  /** True once the run must stop (the app locked). Checked between steps; no lane starts or saves anything after. */
  stopped?: () => boolean;
}

/**
 * Bring the stored `kind0:` thumbnails in line with freshly fetched profiles.
 * Per pubkey:
 * - profile not fetched (absent from `profiles`) → leave whatever is stored;
 * - fetched, no picture → delete the stored thumbnail;
 * - picture URL equal to the stored source URL → nothing (not re-downloaded);
 * - new or changed URL → download, re-encode, store. A failure counts and
 *   keeps the old thumbnail.
 * Once `stopped()` reads true every lane ends after its current step.
 */
export async function applyKind0Pictures(
  pubkeys: Iterable<string>,
  profiles: ReadonlyMap<string, Kind0Profile>,
  deps: ApplyKind0PicturesDeps,
): Promise<PictureRunResult> {
  const result: PictureRunResult = { downloaded: 0, failed: 0, removed: 0, unchanged: 0 };
  const stopped = deps.stopped ?? (() => false);
  const jobs: { pubkey: string; url: string }[] = [];
  for (const raw of new Set(Array.from(pubkeys, p => p.toLowerCase()))) {
    if (!HEX64.test(raw)) continue;
    const profile = profiles.get(raw);
    if (!profile) continue;
    const hasStored = deps.stored.has(raw);
    if (!profile.pictureUrl) {
      if (hasStored && !stopped()) {
        try { await deps.remove(raw); result.removed += 1; } catch { /* keep going */ }
      }
      continue;
    }
    if (hasStored && deps.stored.get(raw) === profile.pictureUrl) { result.unchanged += 1; continue; }
    jobs.push({ pubkey: raw, url: profile.pictureUrl });
  }

  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !stopped()) {
      const job = jobs[next++];
      try {
        const bytes = await deps.download(job.url);
        if (stopped()) { bytes?.fill(0); return; }
        const jpeg = bytes ? await deps.thumbnail(bytes) : null;
        if (stopped()) { jpeg?.fill(0); return; }
        if (!jpeg) { result.failed += 1; continue; }
        await deps.save(job.pubkey, jpeg, job.url);
        result.downloaded += 1;
      } catch {
        result.failed += 1;
      }
    }
  };
  const lanes = Math.max(1, Math.min(deps.concurrency ?? PICTURE_DOWNLOAD_CONCURRENCY, jobs.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return result;
}

// --- Decrypted thumbnail cache (one load per unlock) ---
//
// Every entry and every run carries the key generation it started under
// (`contactPictureGeneration`, bumped by `forgetContactPictureKeys` on lock and
// purge). Work from an older generation is a no-op: it cannot rebuild the
// cache, re-derive the key, or store anything after the app locked.

type Listener = () => void;
let cache: { key: string; gen: number; byId: Map<string, Blob>; sources: Map<string, string | undefined>; load: Promise<void> } | null = null;
let version = 0;
const listeners = new Set<Listener>();

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function blobOf(jpeg: Uint8Array): Blob {
  return new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
}

function live(gen: number): boolean {
  return gen === contactPictureGeneration();
}

function cacheFor(encryptionKey: string, gen: number) {
  return cache && cache.key === encryptionKey && cache.gen === gen && live(gen) ? cache : null;
}

/** Load every stored thumbnail for this unlock key, once. A stale `gen` (locked since) loads nothing. */
export function loadContactPictures(encryptionKey: string, gen: number = contactPictureGeneration()): Promise<void> {
  if (!live(gen)) return Promise.resolve();
  const current = cacheFor(encryptionKey, gen);
  if (current) return current.load;
  const entry = {
    key: encryptionKey,
    gen,
    byId: new Map<string, Blob>(),
    sources: new Map<string, string | undefined>(),
    load: Promise.resolve(),
  };
  cache = entry;
  entry.load = (async () => {
    let pictures: ContactPicture[] = [];
    try { pictures = await listContactPictures(encryptionKey, gen); } catch { pictures = []; }
    if (cache !== entry || !live(gen)) {
      for (const p of pictures) p.jpeg.fill(0);
      return;
    }
    for (const p of pictures) {
      // A write that landed while we were reading wins over the stored copy.
      if (!entry.byId.has(p.id)) {
        entry.byId.set(p.id, blobOf(p.jpeg));
        entry.sources.set(p.id, p.sourceUrl);
      }
      p.jpeg.fill(0);
    }
    notify();
  })();
  return entry.load;
}

/** Drop the decrypted cache (on lock). */
export function forgetContactPictureCache(): void {
  cache = null;
  notify();
}

export function subscribeContactPictures(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function contactPicturesVersion(): number {
  return version;
}

/** The cached thumbnail for `id` under this unlock key, if any. */
export function cachedContactPicture(encryptionKey: string | null, id: string): Blob | null {
  if (!encryptionKey) return null;
  return cacheFor(encryptionKey, contactPictureGeneration())?.byId.get(id) ?? null;
}

/** Rejects with `ContactPicturesLockedError` (nothing written) when `gen` is stale. */
async function storePicture(encryptionKey: string, picture: ContactPicture, gen: number): Promise<void> {
  if (!live(gen)) throw new ContactPicturesLockedError();
  await saveContactPicture(picture, encryptionKey, gen);
  const entry = cacheFor(encryptionKey, gen);
  if (entry) {
    entry.byId.set(picture.id, blobOf(picture.jpeg));
    entry.sources.set(picture.id, picture.sourceUrl);
    notify();
  }
}

async function dropPicture(encryptionKey: string, id: string, gen: number): Promise<void> {
  if (!live(gen)) throw new ContactPicturesLockedError();
  await deleteContactPicture(id);
  const entry = cacheFor(encryptionKey, gen);
  if (entry) {
    entry.byId.delete(id);
    entry.sources.delete(id);
    notify();
  }
}

/** The stored source URL of each `kind0:` thumbnail, by pubkey. */
async function storedKind0Sources(encryptionKey: string, gen: number): Promise<Map<string, string | undefined>> {
  await loadContactPictures(encryptionKey, gen);
  const out = new Map<string, string | undefined>();
  const entry = cacheFor(encryptionKey, gen);
  if (!entry) return out;
  for (const [id, source] of entry.sources) {
    if (id.startsWith('kind0:')) out.set(id.slice(6), source);
  }
  return out;
}

export interface PictureRunDeps {
  download?: (url: string) => Promise<Uint8Array | null>;
  thumbnail?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
  now?: () => number;
  /** The key generation the run started under; defaults to the current one. */
  generation?: number;
}

const EMPTY_RESULT = (): PictureRunResult => ({ downloaded: 0, failed: 0, removed: 0, unchanged: 0 });

/** Download/refresh the kind-0 thumbnails for `pubkeys` from already-fetched profiles. Consent is the caller's. */
export async function syncKind0Pictures(
  encryptionKey: string,
  pubkeys: Iterable<string>,
  profiles: ReadonlyMap<string, Kind0Profile>,
  deps: PictureRunDeps = {},
): Promise<PictureRunResult> {
  const now = deps.now ?? Date.now;
  const gen = deps.generation ?? contactPictureGeneration();
  if (!live(gen)) return EMPTY_RESULT();
  const stored = await storedKind0Sources(encryptionKey, gen);
  if (!live(gen)) return EMPTY_RESULT();
  return applyKind0Pictures(pubkeys, profiles, {
    stored,
    stopped: () => !live(gen),
    download: deps.download ?? (url => downloadPictureBytes(url)),
    thumbnail: deps.thumbnail ?? (bytes => makeThumbnail(bytes)),
    save: (pubkey, jpeg, sourceUrl) => {
      const t = now();
      return storePicture(encryptionKey, { id: kind0PictureId(pubkey), jpeg, sourceUrl, fetchedAt: t, updatedAt: t }, gen);
    },
    remove: pubkey => dropPicture(encryptionKey, kind0PictureId(pubkey), gen),
  });
}

/** Set the user's own picture for one contact from a file they picked. Resolves false when the image is refused. */
export async function setOwnContactPicture(
  encryptionKey: string,
  directoryId: string,
  contactId: string,
  file: Blob,
  deps: { thumbnail?: (bytes: Uint8Array) => Promise<Uint8Array | null>; now?: () => number } = {},
): Promise<boolean> {
  // A picked file is untrusted input too. Camera photos are larger than the
  // 2 MB download cap, so the file cap is looser; the header gate (8192 px a
  // side, 40 MP) is what bounds the decode either way.
  if (file.size === 0 || file.size > OWN_PICTURE_MAX_FILE_BYTES) return false;
  const gen = contactPictureGeneration();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpeg = await (deps.thumbnail ?? makeThumbnail)(bytes);
  if (!jpeg) return false;
  if (!live(gen)) { jpeg.fill(0); return false; }
  const t = (deps.now ?? Date.now)();
  await storePicture(encryptionKey, { id: ownPictureId(directoryId, contactId), jpeg, fetchedAt: t, updatedAt: t }, gen);
  return true;
}

export async function removeOwnContactPicture(encryptionKey: string, directoryId: string, contactId: string): Promise<void> {
  await dropPicture(encryptionKey, ownPictureId(directoryId, contactId), contactPictureGeneration());
}

/**
 * The pubkeys whose pictures a refresh covers: the primary identity key of
 * every contact this device holds, in any directory, that is not removed and
 * not quarantined — exactly the key each avatar renders by.
 */
export function contactPicturePubkeys(records: Iterable<ContactRecord>): string[] {
  const out = new Set<string>();
  for (const record of records) {
    if (record.lifecycle === 'removed' || record.directoryId === 'quarantine') continue;
    const pk = primaryIdentityPubkey(record);
    if (pk && HEX64.test(pk.toLowerCase())) out.add(pk.toLowerCase());
  }
  return [...out];
}

export interface RefreshContactPicturesDeps extends PictureRunDeps {
  listRecords?: (encryptionKey: string) => Promise<ContactRecord[]>;
  fetchProfiles: (pubkeys: string[]) => Promise<Map<string, Kind0Profile>>;
}

/**
 * "Refresh pictures": fetch kind 0 for every contact key (newest per author,
 * author-pinned, verified) and re-download only what changed. Call ONLY after
 * the user agreed to the consent step for this run.
 */
export async function refreshContactPictures(
  encryptionKey: string,
  deps: RefreshContactPicturesDeps,
): Promise<PictureRunResult> {
  // Captured before anything else: a lock at any point after this stops the run.
  const generation = deps.generation ?? contactPictureGeneration();
  const records = await (deps.listRecords ?? listAllContactRecordsV2)(encryptionKey);
  if (!live(generation)) return EMPTY_RESULT();
  const pubkeys = contactPicturePubkeys(records);
  if (pubkeys.length === 0) return EMPTY_RESULT();
  const profiles = await deps.fetchProfiles(pubkeys);
  if (!live(generation)) return EMPTY_RESULT();
  return syncKind0Pictures(encryptionKey, pubkeys, profiles, { ...deps, generation });
}
