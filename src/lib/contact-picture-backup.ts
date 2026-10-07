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
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { encryptPhotoWithKey, decryptPhoto } from './photo-crypto';
import { readBodyCapped } from './avatar';
import { isSafeBlossomBase } from './safe-url';
import { uploadToBlossom, deleteFromBlossom } from './blossom';
import { LocalSigningBackend } from './signing-backend';
import { sniffImageFormat } from './image-header';
import {
  contactPictureGeneration, CONTACT_PICTURE_MAX_STORED_BYTES,
} from './contact-picture-crypto';
import {
  loadContactPictures, cachedOwnPictureState, setOwnPictureBackupState, storeRestoredOwnPicture, removeOwnContactPicture,
} from './contact-pictures';
import * as db from './db';
import { buildOperation } from './contacts-v2-mutations';
import { validateOperation } from './contacts-v2-reducer';
import { frontierOf, nextClock } from './contacts-v2-clock';
import { newOperationId } from './contacts-v2-ids';
import { contactsMutationQueue } from './contacts-v2-queue';
import type { ContactActorRole } from '../types';

export const CONTACT_PICTURE_BACKUP_DEFAULT_URL = 'https://nostr.download';
export const CONTACT_PICTURE_SWEEP_CAP = 20;
export const CONTACT_PICTURE_DOWNLOAD_MAX_BYTES = 512 * 1024;
const CONCURRENCY = 4;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_SERVER_CHARS = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const UPLOADER_DOMAIN = new TextEncoder().encode('signet:contact-picture-uploader:v1');
/** secp256k1 group order. */
const CURVE_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

export interface PicturePointer { server: string; hash: string; key: string; plainHash: string }

/** `defaultBlossomUrl` undefined => the backup default; '' => null (uploads off); else that URL. */
export function resolveBackupServer(defaultBlossomUrl: string | undefined): string | null {
  if (defaultBlossomUrl === undefined) return CONTACT_PICTURE_BACKUP_DEFAULT_URL;
  if (defaultBlossomUrl === '') return null;
  return defaultBlossomUrl;
}

function isValidScalar(sk: Uint8Array): boolean {
  const n = BigInt('0x' + bytesToHex(sk));
  return n > 0n && n < CURVE_N;
}

/**
 * sk = sha256(utf8("signet:contact-picture-uploader:v1") || keyBytes). In the
 * (2^-128) case that is not a valid secp256k1 scalar, the hash is retried with
 * a counter byte (1, 2, ...) appended to the input. The caller zero-fills.
 */
export function deriveUploaderKey(contentKeyHex: string): Uint8Array {
  if (!HEX64.test(contentKeyHex)) throw new Error('Invalid picture key');
  const keyBytes = hexToBytes(contentKeyHex);
  try {
    for (let counter = 0; counter < 256; counter += 1) {
      const input = new Uint8Array(UPLOADER_DOMAIN.length + keyBytes.length + (counter === 0 ? 0 : 1));
      input.set(UPLOADER_DOMAIN, 0);
      input.set(keyBytes, UPLOADER_DOMAIN.length);
      if (counter !== 0) input[input.length - 1] = counter;
      const sk = sha256(input);
      input.fill(0);
      if (isValidScalar(sk)) return sk;
      sk.fill(0);
    }
    throw new Error('Could not derive an uploader key');
  } finally {
    keyBytes.fill(0);
  }
}

/** A well-formed pointer with a server that passes the https-only Blossom guard. */
function pointerIsUsable(p: PicturePointer): boolean {
  return typeof p.server === 'string' && p.server.length > 0 && p.server.length <= MAX_SERVER_CHARS
    && p.server.startsWith('https://') && isSafeBlossomBase(p.server)
    && HEX64.test(p.hash) && HEX64.test(p.key) && HEX64.test(p.plainHash);
}

function uploaderBackend(contentKeyHex: string): LocalSigningBackend {
  const sk = deriveUploaderKey(contentKeyHex);
  try {
    return new LocalSigningBackend(bytesToHex(sk));
  } finally {
    sk.fill(0);
  }
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
  try {
    const backend = uploaderBackend(key);
    const blob = new Blob([encrypted as BlobPart], { type: 'application/octet-stream' });
    const hash = (await (deps.upload ?? uploadToBlossom)(blob, base, backend, true)).toLowerCase();
    if (!HEX64.test(hash)) throw new Error('Backup upload returned an invalid hash');
    return { server: base, hash, key, plainHash: bytesToHex(sha256(jpeg)) };
  } finally {
    encrypted.fill(0);
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
  try {
    if (!pointerIsUsable(p)) return false;
    await deleteFromBlossom(p.hash, p.server, uploaderBackend(p.key), deps.fetch ?? fetch);
    return true;
  } catch {
    return false;
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
  writePointer: (directoryId: string, contactId: string, p: PicturePointer) => Promise<void>;
  upload?: (jpeg: Uint8Array, server: string) => Promise<PicturePointer>;
  deleteBlob?: (p: PicturePointer) => Promise<boolean>;
  generation?: number;
}

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
  const gen = deps.generation ?? contactPictureGeneration();
  const live = () => gen === contactPictureGeneration();
  if (!live()) return result;
  const upload = deps.upload ?? ((jpeg: Uint8Array, server: string) => uploadOwnPicture(jpeg, server));
  const deleteBlob = deps.deleteBlob ?? ((p: PicturePointer) => deleteOwnPictureBlob(p));
  const byKey = new Map<string, BackupRecordRef>();
  for (const r of deps.records) byKey.set(recordKey(r.directoryId, r.contactId), r);

  let rows;
  try { rows = await db.listContactPictures(encryptionKey, gen); } catch { return result; }
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

  await runLanes(jobs, () => !live(), async job => {
    let pointer: PicturePointer | null = null;
    try {
      if (!live()) return;
      pointer = await upload(job.jpeg, deps.server);
      if (!live()) {
        // Locked mid-upload: no operation will be written, so nobody will ever hold this key.
        await deleteBlob(pointer);
        return;
      }
      await deps.writePointer(job.directoryId, job.contactId, pointer);
    } catch {
      // Deliberately NOT deleting `pointer`'s blob here: if the write threw after the
      // operation was saved, the log points at it, and deleting would break a live pointer.
      result.failed += 1;
      return;
    } finally {
      job.jpeg.fill(0);
    }
    result.uploaded += 1;
    try { await setOwnPictureBackupState(encryptionKey, job.directoryId, job.contactId, 'synced', job.plainHash, gen); } catch { /* stays pending; the next run re-uploads */ }
    const old = job.record.picture;
    if (old && old.hash !== pointer.hash) await deleteBlob(old);
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

  const downloads: { record: BackupRecordRef; pointer: PicturePointer }[] = [];
  const deletions: BackupRecordRef[] = [];
  for (const record of deps.records) {
    const state = cachedOwnPictureState(encryptionKey, record.directoryId, record.contactId);
    const pointer = record.lifecycle !== 'removed' ? record.picture : undefined;
    if (pointer) {
      if (!state || (state.backup === 'synced' && state.plainHash !== pointer.plainHash)) downloads.push({ record, pointer });
    } else if (state && state.backup === 'synced') {
      deletions.push(record);
    }
  }

  for (const record of deletions) {
    if (!live()) break;
    try {
      await removeOwnContactPicture(encryptionKey, record.directoryId, record.contactId, gen);
      result.removed += 1;
    } catch { /* locked or storage error: leave it */ }
  }
  await runLanes(downloads, () => !live(), async ({ record, pointer }) => {
    let jpeg: Uint8Array | null = null;
    try {
      jpeg = await download(pointer);
      if (!jpeg) { result.failed += 1; return; }
      if (!live()) return;
      if (await storeRestoredOwnPicture(encryptionKey, record.directoryId, record.contactId, jpeg, pointer.plainHash, gen)) result.restored += 1;
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
}): Promise<void> {
  return contactsMutationQueue.run(async () => {
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
    await db.saveContactOperationV2(op, encryptionKey);
  });
}
