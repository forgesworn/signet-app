/**
 * Encrypted Blossom backup of the user's OWN contact pictures (data layer).
 *
 * Spec: signet-plans `2026-10-07-contact-picture-crop-badge-backup-design.md` §3.
 *
 * A picture is AES-256-GCM encrypted under a fresh content key and uploaded as
 * an opaque blob. The pointer `{ server, hash, key, plainHash }` rides the
 * contacts-v2 operation log (`set-picture`), so it syncs on the existing sealed
 * rail. The kind-24242 auth for the upload and any later delete is signed by a
 * one-off keypair DERIVED from the content key, so nothing ties the blob to the
 * user's persona and no raw Nostr key is stored anywhere.
 *
 * `pointer.key` is a SECRET: never log it, never export it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encryptPhotoWithKey, decryptPhoto } from './photo-crypto';
import { readBodyCapped } from './avatar';
import { isSafeBlossomBase } from './safe-url';
import { uploadToBlossom, deleteFromBlossom, BlossomUploadError, DEFAULT_BLOSSOM_URL } from './blossom';
import {
  CONTACT_PICTURE_UPLOADER_DOMAIN, deriveUploaderKey as deriveKey, derivedUploaderBackend,
} from './blossom-uploader';
import type { LocalSigningBackend } from './signing-backend';
import { sniffImageFormat } from './image-header';
import {
  contactPictureGeneration, ownPictureId, CONTACT_PICTURE_MAX_STORED_BYTES,
} from './contact-picture-crypto';
import {
  loadContactPictures, cachedOwnPictureState, setOwnPictureBackupState, storeRestoredOwnPicture, removeOwnPictureIfSynced,
  readOwnPictureState, type RestoreExpectation,
} from './contact-pictures';
import * as db from './db';
import { buildOperation } from './contacts-v2-mutations';
import { validateOperation } from './contacts-v2-reducer';
import { frontierOf, nextClock } from './contacts-v2-clock';
import { newOperationId } from './contacts-v2-ids';
import { contactsMutationQueue } from './contacts-v2-queue';
import type { ContactActorRole } from '../types';

export const CONTACT_PICTURE_SWEEP_CAP = 20;
export const CONTACT_PICTURE_DOWNLOAD_MAX_BYTES = 512 * 1024;
const CONCURRENCY = 4;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_SERVER_CHARS = 512;
const HEX64 = /^[0-9a-f]{64}$/;

export interface PicturePointer { server: string; hash: string; key: string; plainHash: string }

/** `defaultBlossomUrl` undefined => the app-wide default (`DEFAULT_BLOSSOM_URL`); '' => null (uploads off); else that URL. */
export function resolveBackupServer(defaultBlossomUrl: string | undefined): string | null {
  if (defaultBlossomUrl === undefined) return DEFAULT_BLOSSOM_URL;
  if (defaultBlossomUrl === '') return null;
  return defaultBlossomUrl;
}

/**
 * sk = sha256(utf8("signet:contact-picture-uploader:v1") || keyBytes), with the
 * counter retry described on the shared `deriveUploaderKey`. The caller zero-fills.
 * Output is byte-identical to before the derivation was generalised.
 */
export function deriveUploaderKey(contentKeyHex: string): Uint8Array {
  return deriveKey(contentKeyHex, CONTACT_PICTURE_UPLOADER_DOMAIN);
}

/** A well-formed pointer with a server that passes the https-only Blossom guard. */
function pointerIsUsable(p: PicturePointer): boolean {
  return typeof p.server === 'string' && p.server.length > 0 && p.server.length <= MAX_SERVER_CHARS
    && p.server.startsWith('https://') && isSafeBlossomBase(p.server)
    && HEX64.test(p.hash) && HEX64.test(p.key) && HEX64.test(p.plainHash);
}

export interface UploadDeps {
  upload?: typeof uploadToBlossom;
}

/**
 * Fresh 32-byte content key; AES-GCM encrypt; upload with the derived one-off
 * key (consent gate passed as `true`: the caller only gets here after the user
 * agreed to the backup). Returns the pointer to record.
 */
export async function uploadOwnPicture(jpeg: Uint8Array, server: string, deps: UploadDeps = {}): Promise<PicturePointer> {
  const base = server.replace(/\/+$/, '');
  if (base.length > MAX_SERVER_CHARS || !base.startsWith('https://') || !isSafeBlossomBase(base)) {
    throw new Error('Backup server must be a public https URL');
  }
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = bytesToHex(keyBytes);
  keyBytes.fill(0);
  const encrypted = await encryptPhotoWithKey(jpeg, key);
  let backend: LocalSigningBackend | null = null;
  try {
    backend = derivedUploaderBackend(key, CONTACT_PICTURE_UPLOADER_DOMAIN);
    const blob = new Blob([encrypted as BlobPart], { type: 'application/octet-stream' });
    const hash = (await (deps.upload ?? uploadToBlossom)(blob, base, backend, true)).toLowerCase();
    if (!HEX64.test(hash)) throw new Error('Backup upload returned an invalid hash');
    return { server: base, hash, key, plainHash: bytesToHex(sha256(jpeg)) };
  } finally {
    encrypted.fill(0);
    backend?.destroy();
  }
}

export interface DownloadDeps {
  fetch?: typeof fetch;
}

/**
 * GET {server}/{hash}; body capped; sha256(ciphertext) == hash; decrypt;
 * sha256(plaintext) == plainHash; JPEG magic bytes. Any failure => null.
 */
export async function downloadOwnPicture(p: PicturePointer, deps: DownloadDeps = {}): Promise<Uint8Array | null> {
  let ciphertext: Uint8Array | null = null;
  let plain: Uint8Array | null = null;
  try {
    if (!pointerIsUsable(p)) return null;
    const response = await (deps.fetch ?? fetch)(`${p.server.replace(/\/+$/, '')}/${p.hash}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      credentials: 'omit',
      // A redirect would send this device's address to a host the server chose.
      redirect: 'error',
    });
    if (!response.ok) return null;
    ciphertext = await readBodyCapped(response, CONTACT_PICTURE_DOWNLOAD_MAX_BYTES);
    if (bytesToHex(sha256(ciphertext)) !== p.hash) return null;
    plain = await decryptPhoto(ciphertext, p.key);
    if (plain.length === 0 || plain.length > CONTACT_PICTURE_MAX_STORED_BYTES
      || bytesToHex(sha256(plain)) !== p.plainHash || sniffImageFormat(plain) !== 'jpeg') {
      plain.fill(0);
      return null;
    }
    const out = plain;
    plain = null;
    return out;
  } catch {
    return null;
  } finally {
    ciphertext?.fill(0);
    plain?.fill(0);
  }
}

export interface DeleteDeps {
  fetch?: typeof fetch;
}

/** Best-effort `DELETE {server}/{hash}` signed by the derived uploader key. Never throws; true on 2xx. */
export async function deleteOwnPictureBlob(p: PicturePointer, deps: DeleteDeps = {}): Promise<boolean> {
  let backend: LocalSigningBackend | null = null;
  try {
    if (!pointerIsUsable(p)) return false;
    backend = derivedUploaderBackend(p.key, CONTACT_PICTURE_UPLOADER_DOMAIN);
    await deleteFromBlossom(p.hash, p.server, backend, deps.fetch ?? fetch);
    return true;
  } catch {
    return false;
  } finally {
    backend?.destroy();
  }
}

export interface BackupRecordRef { directoryId: string; contactId: string; lifecycle: string; picture?: PicturePointer }

function recordKey(directoryId: string, contactId: string): string {
  return `${directoryId}/${contactId}`;
}

async function runLanes<T>(jobs: T[], stopped: () => boolean, work: (job: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < jobs.length && !stopped()) await work(jobs[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, jobs.length)) }, lane));
}

export interface BackupDeps {
  records: BackupRecordRef[];
  server: string;
  /** The user's backup preference; nothing uploads unless it is `'on'` (the callers gate too: defence in depth). */
  pref: 'on' | 'off' | undefined;
  /** Back up only this contact's row (read directly, instead of listing every picture row). */
  only?: { directoryId: string; contactId: string };
  writePointer: (directoryId: string, contactId: string, p: PicturePointer) => Promise<void>;
  /** Write `clear-picture`, for a pointer written after its row was removed. */
  clearPointer?: (directoryId: string, contactId: string) => Promise<void>;
  upload?: (jpeg: Uint8Array, server: string) => Promise<PicturePointer>;
  deleteBlob?: (p: PicturePointer) => Promise<boolean>;
  generation?: number;
}

/** Rows being uploaded right now, by `directory/contact/plainHash`: the page save and the sweep never upload the same picture at once. */
const inFlight = new Set<string>();

function splitOwnId(id: string): { directoryId: string; contactId: string } | null {
  if (!id.startsWith('own:')) return null;
  const rest = id.slice(4);
  const cut = rest.lastIndexOf(':');
  return cut > 0 ? { directoryId: rest.slice(0, cut), contactId: rest.slice(cut + 1) } : null;
}

/**
 * For each `pending` own row whose record exists and is not removed: upload,
 * write the pointer, mark `synced`. At most 4 at a time and at most
 * CONTACT_PICTURE_SWEEP_CAP per run; stops when the app locks. A failure leaves
 * the row `pending`. A different pointer already on the record has its blob
 * deleted (best effort) once the new pointer is written.
 */
export async function backupPendingPictures(encryptionKey: string, deps: BackupDeps): Promise<{ uploaded: number; failed: number }> {
  const result = { uploaded: 0, failed: 0 };
  if (deps.pref !== 'on') return result;
  const gen = deps.generation ?? contactPictureGeneration();
  const live = () => gen === contactPictureGeneration();
  if (!live()) return result;
  const upload = deps.upload ?? ((jpeg: Uint8Array, server: string) => uploadOwnPicture(jpeg, server));
  const deleteBlob = deps.deleteBlob ?? ((p: PicturePointer) => deleteOwnPictureBlob(p));
  const byKey = new Map<string, BackupRecordRef>();
  for (const r of deps.records) byKey.set(recordKey(r.directoryId, r.contactId), r);

  let rows;
  try {
    if (deps.only) {
      const row = await db.getContactPicture(ownPictureId(deps.only.directoryId, deps.only.contactId), encryptionKey, gen);
      rows = row ? [row] : [];
    } else {
      rows = await db.listContactPictures(encryptionKey, gen);
    }
  } catch { return result; }
  const jobs: { directoryId: string; contactId: string; jpeg: Uint8Array; plainHash: string; record: BackupRecordRef; at: number }[] = [];
  for (const row of rows) {
    const ids = splitOwnId(row.id);
    const record = ids ? byKey.get(recordKey(ids.directoryId, ids.contactId)) : undefined;
    if (ids && record && record.lifecycle !== 'removed' && row.backup === 'pending') {
      jobs.push({ ...ids, jpeg: row.jpeg, plainHash: row.plainHash ?? bytesToHex(sha256(row.jpeg)), record, at: row.updatedAt });
    } else {
      row.jpeg.fill(0);
    }
  }
  jobs.sort((a, b) => a.at - b.at);
  for (const dropped of jobs.splice(CONTACT_PICTURE_SWEEP_CAP)) dropped.jpeg.fill(0);

  // A 4xx on an upload means the server refuses what we send: stop spending uploads against it.
  let refused = false;
  const uploadJob = async (job: (typeof jobs)[number]): Promise<void> => {
    let pointer: PicturePointer | null = null;
    try {
      if (!live()) return;
      pointer = await upload(job.jpeg, deps.server);
      if (!live()) {
        // Locked mid-upload: no operation will be written, so nobody will ever hold this key.
        await deleteBlob(pointer);
        return;
      }
      // The user may have swapped or removed the picture while it uploaded. Writing the
      // pointer now would put an older picture's pointer after a newer one's (or one
      // for a picture that is gone), and restore would then act on it.
      let current: Awaited<ReturnType<typeof readOwnPictureState>> | undefined;
      try { current = await readOwnPictureState(encryptionKey, job.directoryId, job.contactId, gen); } catch { current = undefined; }
      if (!current || current.backup !== 'pending' || current.plainHash !== job.plainHash || !live()) {
        await deleteBlob(pointer);
        return;
      }
      await deps.writePointer(job.directoryId, job.contactId, pointer);
    } catch (e) {
      // Deliberately NOT deleting `pointer`'s blob here: if the write threw after the
      // operation was saved, the log points at it, and deleting would break a live pointer.
      if (e instanceof BlossomUploadError && e.status >= 400 && e.status < 500) refused = true;
      result.failed += 1;
      return;
    } finally {
      job.jpeg.fill(0);
    }
    result.uploaded += 1;
    let marked = false;
    try { marked = await setOwnPictureBackupState(encryptionKey, job.directoryId, job.contactId, 'synced', job.plainHash, gen); } catch { /* stays pending; the next run re-uploads */ }
    if (!marked && live()) {
      // Removed between the check and the write: the pointer must not outlive its row.
      let gone = false;
      try { gone = (await readOwnPictureState(encryptionKey, job.directoryId, job.contactId, gen)) === null; } catch { /* unknown: leave it */ }
      if (gone && deps.clearPointer) {
        try {
          await deps.clearPointer(job.directoryId, job.contactId);
          await deleteBlob(pointer);
        } catch { /* the next restore sees a pointer with no row; best effort */ }
      }
    }
    const old = job.record.picture;
    if (old && old.hash !== pointer.hash) await deleteBlob(old);
  };
  await runLanes(jobs, () => !live() || refused, async job => {
    const flightKey = `${recordKey(job.directoryId, job.contactId)}/${job.plainHash}`;
    if (inFlight.has(flightKey)) { job.jpeg.fill(0); return; }
    inFlight.add(flightKey);
    // Held until the row is marked synced, not just until the upload ends: a run
    // starting in between would still see it pending and upload it a second time.
    try { await uploadJob(job); } finally { inFlight.delete(flightKey); }
  });
  // Jobs a lock stopped us reaching still hold their plaintext.
  for (const job of jobs) job.jpeg.fill(0);
  return result;
}

export interface RestoreDeps {
  records: BackupRecordRef[];
  download?: (p: PicturePointer) => Promise<Uint8Array | null>;
  generation?: number;
}

/**
 * Bring local own rows in line with the operation log's pointers:
 * - pointer, and no row or a `synced` row with a different plainHash: download and store as `synced`;
 * - pointer, `pending`/`local` row: the local choice stands;
 * - no pointer (or the record removed) and a `synced` row: the picture was removed elsewhere, delete the row.
 * `records` must be a fresh read of the log: a record list that predates a just-written
 * `set-picture` reads as "no pointer" and would delete the row that write belongs to.
 */
export async function restorePictures(encryptionKey: string, deps: RestoreDeps): Promise<{ restored: number; removed: number; failed: number }> {
  const result = { restored: 0, removed: 0, failed: 0 };
  const gen = deps.generation ?? contactPictureGeneration();
  const live = () => gen === contactPictureGeneration();
  if (!live()) return result;
  const download = deps.download ?? ((p: PicturePointer) => downloadOwnPicture(p));
  await loadContactPictures(encryptionKey, gen);
  if (!live()) return result;

  // Both branches act only if the row is still as it was when decided (compare-and-set):
  // a download takes seconds, and the user may save or remove a picture meanwhile.
  const downloads: { record: BackupRecordRef; pointer: PicturePointer; expected: RestoreExpectation }[] = [];
  const deletions: { record: BackupRecordRef; plainHash: string | undefined }[] = [];
  for (const record of deps.records) {
    const state = cachedOwnPictureState(encryptionKey, record.directoryId, record.contactId);
    const pointer = record.lifecycle !== 'removed' ? record.picture : undefined;
    if (pointer) {
      if (!state) downloads.push({ record, pointer, expected: { kind: 'absent' } });
      else if (state.backup === 'synced' && state.plainHash !== pointer.plainHash) downloads.push({ record, pointer, expected: { kind: 'synced', plainHash: state.plainHash } });
    } else if (state && state.backup === 'synced') {
      deletions.push({ record, plainHash: state.plainHash });
    }
  }

  for (const { record, plainHash } of deletions) {
    if (!live()) break;
    try {
      if (await removeOwnPictureIfSynced(encryptionKey, record.directoryId, record.contactId, plainHash, gen)) result.removed += 1;
    } catch { /* locked or storage error: leave it */ }
  }
  await runLanes(downloads, () => !live(), async ({ record, pointer, expected }) => {
    let jpeg: Uint8Array | null = null;
    try {
      jpeg = await download(pointer);
      if (!jpeg) { result.failed += 1; return; }
      if (!live()) return;
      if (await storeRestoredOwnPicture(encryptionKey, record.directoryId, record.contactId, jpeg, pointer.plainHash, gen, expected)) result.restored += 1;
      else if (live()) result.failed += 1;
    } catch {
      result.failed += 1;
    } finally {
      jpeg?.fill(0);
    }
  });
  return result;
}

/**
 * One serialised writer for the unlock sweep, for any directory. It shares the
 * process-wide contacts mutation queue (`contactsMutationQueue`) with the
 * hooks, so a sweep write can never read the same frontier as a hook write.
 * That queue is NOT re-entrant: never call this from inside a queued task.
 * The caller must reload the contacts hooks afterwards (their in-memory Lamport
 * clocks would otherwise sit behind this operation) and bump the rail counter.
 */
export async function writeContactPictureOp(encryptionKey: string, args: {
  directoryId: string;
  contactId: string;
  action: 'set-picture' | 'clear-picture';
  value: PicturePointer | Record<string, never>;
  actor: { actorPubkey: string; actorRole: Extract<ContactActorRole, 'owner' | 'guardian'>; actorDeviceId: string };
  /** The lock generation the caller started under (default: now). A write queued behind other work when the app locks is refused. */
  generation?: number;
}): Promise<void> {
  const gen = args.generation ?? contactPictureGeneration();
  return contactsMutationQueue.run(async () => {
    if (gen !== contactPictureGeneration()) throw new Error('contacts: locked');
    const ops = await db.listContactOperationsV2(args.directoryId, encryptionKey);
    const op = buildOperation({
      directoryId: args.directoryId,
      contactId: args.contactId,
      action: args.action,
      value: args.action === 'set-picture'
        ? (() => { const v = args.value as PicturePointer; return { server: v.server, hash: v.hash, key: v.key, plainHash: v.plainHash }; })()
        : {},
      clock: nextClock(0, frontierOf(ops).maxClock),
      actor: args.actor,
      now: Date.now(),
      operationId: newOperationId(),
    });
    if (!validateOperation(op)) throw new Error(`contacts: cannot ${args.action} — invalid operation`);
    if (gen !== contactPictureGeneration()) throw new Error('contacts: locked');
    await db.saveContactOperationV2(op, encryptionKey);
  });
}
