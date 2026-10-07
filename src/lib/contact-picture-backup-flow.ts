/**
 * Orchestration of the encrypted Blossom backup of the user's own contact
 * pictures (spec §3 "Saving", "Uploader", "Restore", "Removing"; §4 status line).
 *
 * `contact-picture-backup.ts` is the data layer; this module decides WHEN to
 * use it. All I/O is injectable, so App.tsx only supplies the live pieces
 * (preference, server, the contacts hooks' mutators) and the tests drive the
 * rest.
 *
 * Never call anything here that writes a contacts operation from inside a
 * `useContactsV2` mutator or a `contactsMutationQueue` task: the queue is not
 * re-entrant.
 */

import type { PictureCrop } from './picture-crop';
import type { OwnPictureOutcome } from './contact-pictures';
import {
  setOwnContactPicture, removeOwnContactPicture, setOwnPictureBackupState, listContactRecordsFromLog,
} from './contact-pictures';
import {
  backupPendingPictures, restorePictures, deleteOwnPictureBlob, writeContactPictureOp,
  type BackupRecordRef, type PicturePointer,
} from './contact-picture-backup';
import type { ContactRecord } from '../types';

export type ContactPictureBackupPref = 'on' | 'off' | undefined;

export interface BackupEnv {
  encryptionKey: string;
  pairedChild: boolean;
  /** `resolveBackupServer(preferences.defaultBlossomUrl)`; null = Blossom uploads are off. */
  server: string | null;
  pref: ContactPictureBackupPref;
}

/** Backup is possible: not a paired-child install, uploads not off, and the user said yes. */
export function backupPossible(env: Pick<BackupEnv, 'pairedChild' | 'server' | 'pref'>): boolean {
  return !env.pairedChild && env.server !== null && env.pref === 'on';
}

/** The one-time ask is due: never asked, and a backup could be offered at all. */
export function consentNeeded(env: Pick<BackupEnv, 'pairedChild' | 'server' | 'pref'>): boolean {
  return !env.pairedChild && env.server !== null && env.pref === undefined;
}

/** The pointer-carrying part of a contacts-v2 record, as the flow needs it. */
export function backupRefOf(record: Pick<ContactRecord, 'directoryId' | 'contactId' | 'lifecycle' | 'picture'>): BackupRecordRef {
  return {
    directoryId: record.directoryId, contactId: record.contactId, lifecycle: record.lifecycle,
    ...(record.picture ? { picture: record.picture } : {}),
  };
}

/** A fresh fold of the operation log (never a hook's possibly-stale state). */
export async function foldBackupRecords(encryptionKey: string): Promise<BackupRecordRef[]> {
  return (await listContactRecordsFromLog(encryptionKey)).map(backupRefOf);
}

export interface FlowDeps {
  setOwn?: typeof setOwnContactPicture;
  removeOwn?: typeof removeOwnContactPicture;
  setBackupState?: typeof setOwnPictureBackupState;
  backupPending?: typeof backupPendingPictures;
  deleteBlob?: (p: PicturePointer) => Promise<boolean>;
}

/** Back up THIS contact's pending picture (records narrowed to it). Never throws. */
function backupOne(
  encryptionKey: string,
  server: string,
  record: BackupRecordRef,
  writePointer: (directoryId: string, contactId: string, p: PicturePointer) => Promise<void>,
  deps: FlowDeps,
): Promise<void> {
  return (deps.backupPending ?? backupPendingPictures)(encryptionKey, { records: [record], server, writePointer })
    .then(() => undefined, () => undefined);
}

export interface SaveOwnPictureArgs {
  env: BackupEnv;
  directoryId: string;
  contactId: string;
  file: File;
  crop?: PictureCrop;
  /** This contact's record from the contacts hook's `records` (its pointer, if any). */
  record: BackupRecordRef | undefined;
  /** `contactsV2.setPicture`: the page's own mutator. */
  writePointer: (directoryId: string, contactId: string, p: PicturePointer) => Promise<void>;
}

export interface SaveOwnPictureResult {
  outcome: OwnPictureOutcome;
  /** The first save on this install: the page shows the one-time ask. */
  askConsent: boolean;
  /** Settles when the background upload (if any) has finished. The page does not wait for it. */
  background: Promise<void>;
}

/** Store the picture at once; if a backup is possible, upload it in the background. */
export async function saveOwnPicture(args: SaveOwnPictureArgs, deps: FlowDeps = {}): Promise<SaveOwnPictureResult> {
  const { env } = args;
  const possible = backupPossible(env);
  const outcome = await (deps.setOwn ?? setOwnContactPicture)(
    env.encryptionKey, args.directoryId, args.contactId, args.file, args.crop,
    { backup: possible ? 'pending' : 'local' },
  );
  const saved = outcome === 'saved';
  const background = saved && possible && env.server
    ? backupOne(env.encryptionKey, env.server, args.record ?? { directoryId: args.directoryId, contactId: args.contactId, lifecycle: 'active' }, args.writePointer, deps)
    : Promise.resolve();
  return { outcome, askConsent: saved && consentNeeded(env), background };
}

export interface TurnOnArgs {
  env: BackupEnv;
  directoryId: string;
  contactId: string;
  record: BackupRecordRef | undefined;
  setPref: (value: 'on' | 'off') => Promise<void>;
  writePointer: (directoryId: string, contactId: string, p: PicturePointer) => Promise<void>;
}

/**
 * "Back them up" / the status line's "Back it up": preference on, this
 * contact's picture marked pending and uploaded in the background.
 */
export async function turnBackupOn(args: TurnOnArgs, deps: FlowDeps = {}): Promise<{ background: Promise<void> }> {
  const { env } = args;
  await args.setPref('on');
  if (env.pairedChild || env.server === null) return { background: Promise.resolve() };
  const marked = await (deps.setBackupState ?? setOwnPictureBackupState)(env.encryptionKey, args.directoryId, args.contactId, 'pending');
  if (!marked) return { background: Promise.resolve() };
  return {
    background: backupOne(env.encryptionKey, env.server, args.record ?? { directoryId: args.directoryId, contactId: args.contactId, lifecycle: 'active' }, args.writePointer, deps),
  };
}

/** "Only on this phone": remember the choice; the row stays local and the app does not ask again. */
export async function declineBackup(setPref: (value: 'on' | 'off') => Promise<void>): Promise<void> {
  await setPref('off');
}

export interface RemoveOwnPictureArgs {
  encryptionKey: string;
  directoryId: string;
  contactId: string;
  record: BackupRecordRef | undefined;
  /** `contactsV2.clearPicture`. */
  clearPointer: (contactId: string) => Promise<void>;
}

/**
 * Remove the user's own picture. With a pointer on the record (so it was
 * backed up, whatever the preference says now): clear the pointer, then drop
 * the row, then best-effort delete the blob (fire and forget).
 *
 * The pointer is cleared BEFORE the row goes: if that write fails nothing has
 * changed and the user can retry; the other order would leave a pointer with
 * no row, which the next restore turns back into a picture.
 */
export async function removeOwnPicture(args: RemoveOwnPictureArgs, deps: FlowDeps = {}): Promise<void> {
  const pointer = args.record?.lifecycle !== 'removed' ? args.record?.picture : undefined;
  if (pointer) await args.clearPointer(args.contactId);
  await (deps.removeOwn ?? removeOwnContactPicture)(args.encryptionKey, args.directoryId, args.contactId);
  if (pointer) void (deps.deleteBlob ?? ((p: PicturePointer) => deleteOwnPictureBlob(p)))(pointer).catch(() => false);
}

// --- Unlock run and post-merge restore ---

export interface RunnerContext extends Omit<BackupEnv, 'encryptionKey'> {
  encryptionKey: string | null;
  /** The install's R-ACTOR pubkey and contacts-v2 device id; null until both exist. */
  actor: { actorPubkey: string; actorDeviceId: string } | null;
  /** The sweep wrote operations: reload both contacts hooks and bump the rail counter. */
  onSweepWrote: () => void;
}

export interface RunnerDeps {
  fold?: (encryptionKey: string) => Promise<BackupRecordRef[]>;
  restore?: typeof restorePictures;
  backupPending?: typeof backupPendingPictures;
  writeOp?: typeof writeContactPictureOp;
}

export interface PictureBackupRunner {
  /** Restore, then sweep. At most once per unlock key; never on a paired-child install. */
  runOnUnlock: () => Promise<void>;
  /** Restore only, after the contacts rail merged remote operations. Coalesces while one is waiting. */
  runRestore: () => Promise<void>;
}

/**
 * `getContext` is read when a run starts (not captured), so the preference and
 * actor are the live ones. Runs are serialised on one chain: they never overlap.
 */
export function createPictureBackupRunner(getContext: () => RunnerContext, deps: RunnerDeps = {}): PictureBackupRunner {
  const fold = deps.fold ?? foldBackupRecords;
  const restore = deps.restore ?? restorePictures;
  const backupPending = deps.backupPending ?? backupPendingPictures;
  const writeOp = deps.writeOp ?? writeContactPictureOp;
  let latchedKey: string | null = null;
  let restoreWaiting: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task).catch(() => undefined);
    chain = next;
    return next;
  };

  const runRestoreStep = async (key: string, pref: ContactPictureBackupPref, records: BackupRecordRef[] | null): Promise<BackupRecordRef[] | null> => {
    if (pref === 'off') return records;
    const fresh = records ?? await fold(key);
    await restore(key, { records: fresh });
    return fresh;
  };

  return {
    runOnUnlock() {
      const first = getContext();
      if (!first.encryptionKey || first.pairedChild || latchedKey === first.encryptionKey) return Promise.resolve();
      const key = first.encryptionKey;
      latchedKey = key;
      return enqueue(async () => {
        const ctx = getContext();
        if (ctx.encryptionKey !== key || ctx.pairedChild) return;
        const records = await runRestoreStep(key, ctx.pref, null);
        const env: BackupEnv = { ...ctx, encryptionKey: key };
        if (!backupPossible(env) || !ctx.actor || !env.server) return;
        const actor = ctx.actor;
        const swept = records ?? await fold(key);
        let wrote = false;
        try {
          await backupPending(key, {
            records: swept,
            server: env.server,
            writePointer: async (directoryId, contactId, p) => {
              await writeOp(key, {
                directoryId, contactId, action: 'set-picture', value: p,
                actor: { actorPubkey: actor.actorPubkey, actorDeviceId: actor.actorDeviceId, actorRole: directoryId === 'owner' ? 'owner' : 'guardian' },
              });
              wrote = true;
            },
          });
        } finally {
          if (wrote) ctx.onSweepWrote();
        }
      });
    },

    runRestore() {
      const ctx = getContext();
      if (!ctx.encryptionKey || ctx.pairedChild || ctx.pref === 'off') return Promise.resolve();
      if (restoreWaiting) return restoreWaiting;
      const key = ctx.encryptionKey;
      restoreWaiting = enqueue(async () => {
        restoreWaiting = null;
        const now = getContext();
        if (now.encryptionKey !== key || now.pairedChild) return;
        await runRestoreStep(key, now.pref, null);
      });
      return restoreWaiting;
    },
  };
}
