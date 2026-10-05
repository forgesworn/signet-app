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
import { kind0PictureId, ownPictureId, type ContactPicture } from './contact-picture-crypto';
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
}

/**
 * Bring the stored `kind0:` thumbnails in line with freshly fetched profiles.
 * Per pubkey:
 * - profile not fetched (absent from `profiles`) → leave whatever is stored;
 * - fetched, no picture → delete the stored thumbnail;
 * - picture URL equal to the stored source URL → nothing (not re-downloaded);
 * - new or changed URL → download, re-encode, store. A failure counts and
 *   keeps the old thumbnail.
 */
export async function applyKind0Pictures(
  pubkeys: Iterable<string>,
  profiles: ReadonlyMap<string, Kind0Profile>,
  deps: ApplyKind0PicturesDeps,
): Promise<PictureRunResult> {
  const result: PictureRunResult = { downloaded: 0, failed: 0, removed: 0, unchanged: 0 };
  const jobs: { pubkey: string; url: string }[] = [];
  for (const raw of new Set(Array.from(pubkeys, p => p.toLowerCase()))) {
    if (!HEX64.test(raw)) continue;
    const profile = profiles.get(raw);
    if (!profile) continue;
    const hasStored = deps.stored.has(raw);
    if (!profile.pictureUrl) {
      if (hasStored) {
        try { await deps.remove(raw); result.removed += 1; } catch { /* keep going */ }
      }
      continue;
    }
    if (hasStored && deps.stored.get(raw) === profile.pictureUrl) { result.unchanged += 1; continue; }
    jobs.push({ pubkey: raw, url: profile.pictureUrl });
  }

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const bytes = await deps.download(job.url);
        const jpeg = bytes ? await deps.thumbnail(bytes) : null;
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

type Listener = () => void;
let cache: { key: string; byId: Map<string, Blob>; sources: Map<string, string | undefined>; load: Promise<void> } | null = null;
let version = 0;
const listeners = new Set<Listener>();

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function blobOf(jpeg: Uint8Array): Blob {
  return new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
}

/** Load every stored thumbnail for this unlock key, once. */
export function loadContactPictures(encryptionKey: string): Promise<void> {
  if (cache && cache.key === encryptionKey) return cache.load;
  const entry = {
    key: encryptionKey,
    byId: new Map<string, Blob>(),
    sources: new Map<string, string | undefined>(),
    load: Promise.resolve(),
  };
  cache = entry;
  entry.load = (async () => {
    let pictures: ContactPicture[] = [];
    try { pictures = await listContactPictures(encryptionKey); } catch { pictures = []; }
    if (cache !== entry) return;
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
  if (!encryptionKey || !cache || cache.key !== encryptionKey) return null;
  return cache.byId.get(id) ?? null;
}

async function storePicture(encryptionKey: string, picture: ContactPicture): Promise<void> {
  await saveContactPicture(picture, encryptionKey);
  if (cache && cache.key === encryptionKey) {
    cache.byId.set(picture.id, blobOf(picture.jpeg));
    cache.sources.set(picture.id, picture.sourceUrl);
    notify();
  }
}

async function dropPicture(encryptionKey: string, id: string): Promise<void> {
  await deleteContactPicture(id);
  if (cache && cache.key === encryptionKey) {
    cache.byId.delete(id);
    cache.sources.delete(id);
    notify();
  }
}

/** The stored source URL of each `kind0:` thumbnail, by pubkey. */
async function storedKind0Sources(encryptionKey: string): Promise<Map<string, string | undefined>> {
  await loadContactPictures(encryptionKey);
  const out = new Map<string, string | undefined>();
  if (!cache || cache.key !== encryptionKey) return out;
  for (const [id, source] of cache.sources) {
    if (id.startsWith('kind0:')) out.set(id.slice(6), source);
  }
  return out;
}

export interface PictureRunDeps {
  download?: (url: string) => Promise<Uint8Array | null>;
  thumbnail?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
  now?: () => number;
}

/** Download/refresh the kind-0 thumbnails for `pubkeys` from already-fetched profiles. Consent is the caller's. */
export async function syncKind0Pictures(
  encryptionKey: string,
  pubkeys: Iterable<string>,
  profiles: ReadonlyMap<string, Kind0Profile>,
  deps: PictureRunDeps = {},
): Promise<PictureRunResult> {
  const now = deps.now ?? Date.now;
  return applyKind0Pictures(pubkeys, profiles, {
    stored: await storedKind0Sources(encryptionKey),
    download: deps.download ?? (url => downloadPictureBytes(url)),
    thumbnail: deps.thumbnail ?? (bytes => makeThumbnail(bytes)),
    save: (pubkey, jpeg, sourceUrl) => {
      const t = now();
      return storePicture(encryptionKey, { id: kind0PictureId(pubkey), jpeg, sourceUrl, fetchedAt: t, updatedAt: t });
    },
    remove: pubkey => dropPicture(encryptionKey, kind0PictureId(pubkey)),
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpeg = await (deps.thumbnail ?? makeThumbnail)(bytes);
  if (!jpeg) return false;
  const t = (deps.now ?? Date.now)();
  await storePicture(encryptionKey, { id: ownPictureId(directoryId, contactId), jpeg, fetchedAt: t, updatedAt: t });
  return true;
}

export async function removeOwnContactPicture(encryptionKey: string, directoryId: string, contactId: string): Promise<void> {
  await dropPicture(encryptionKey, ownPictureId(directoryId, contactId));
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
  const records = await (deps.listRecords ?? listAllContactRecordsV2)(encryptionKey);
  const pubkeys = contactPicturePubkeys(records);
  if (pubkeys.length === 0) return { downloaded: 0, failed: 0, removed: 0, unchanged: 0 };
  const profiles = await deps.fetchProfiles(pubkeys);
  return syncKind0Pictures(encryptionKey, pubkeys, profiles, deps);
}
