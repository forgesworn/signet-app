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
import { contactPictureGeneration } from './contact-picture-crypto';
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
  env: BackupEnv & { server: string },
  record: BackupRecordRef,
  writePointer: (directoryId: string, contactId: string, p: PicturePointer) => Promise<void>,
  clearPointer: ((directoryId: string, contactId: string) => Promise<void>) | undefined,
  deps: FlowDeps,
): Promise<void> {
  return (deps.backupPending ?? backupPendingPictures)(env.encryptionKey, {
    records: [record], server: env.server, pref: env.pref,
    only: { directoryId: record.directoryId, contactId: record.contactId },
    writePointer, ...(clearPointer ? { clearPointer } : {}),
  }).then(() => undefined, () => undefined);
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
  /** `PictureBackupRunner.clearPointer`: undoes a pointer written after its row was removed. */
  clearPointer?: (directoryId: string, contactId: string) => Promise<void>;
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
    ? backupOne({ ...env, server: env.server }, args.record ?? { directoryId: args.directoryId, contactId: args.contactId, lifecycle: 'active' }, args.writePointer, args.clearPointer, deps)
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
  clearPointer?: (directoryId: string, contactId: string) => Promise<void>;
}

/**
 * "Back them up" / the status line's "Back it up": preference on, this
 * contact's picture marked pending and uploaded in the background.
 */
export async function turnBackupOn(args: TurnOnArgs, deps: FlowDeps = {}): Promise<{ background: Promise<void> }> {
  const { env } = args;
  // Never record consent for a backup that cannot happen on this install.
  if (env.pairedChild || env.server === null) return { background: Promise.resolve() };
  await args.setPref('on');
  const marked = await (deps.setBackupState ?? setOwnPictureBackupState)(env.encryptionKey, args.directoryId, args.contactId, 'pending');
  if (!marked) return { background: Promise.resolve() };
  return {
    // The preference was only just set: the caller's `env.pref` is stale.
    background: backupOne({ ...env, server: env.server, pref: 'on' }, args.record ?? { directoryId: args.directoryId, contactId: args.contactId, lifecycle: 'active' }, args.writePointer, args.clearPointer, deps),
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
  /** The on-screen record: only a fallback if the log cannot be folded (the pointer is decided from a fresh fold). */
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
export async function removeOwnPicture(args: RemoveOwnPictureArgs, deps: FlowDeps & { fold?: (encryptionKey: string) => Promise<BackupRecordRef[]> } = {}): Promise<void> {
  // The on-screen record can be stale (a background upload may have written a pointer
  // since it rendered); a missed pointer would be restored as a picture again.
  let record = args.record;
  try {
    const folded = (await (deps.fold ?? foldBackupRecords)(args.encryptionKey))
      .find(r => r.directoryId === args.directoryId && r.contactId === args.contactId);
    record = folded;
  } catch { /* keep the on-screen record */ }
  const pointer = record?.lifecycle !== 'removed' ? record?.picture : undefined;
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
  /** Restore, then sweep. At most once per unlock (key generation); never on a paired-child install. */
  runOnUnlock: () => Promise<void>;
  /** Restore only, after the contacts rail merged remote operations. Coalesces while one is waiting. */
  runRestore: () => Promise<void>;
  /** Write `clear-picture` for a contact (any directory) and refresh the hooks, through the live context. */
  clearPointer: (directoryId: string, contactId: string) => Promise<void>;
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
  // Latched on the key GENERATION, not the key: the same unlock key comes back on every unlock.
  let latchedGeneration = -1;
  let restoreWaiting: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task).catch(() => undefined);
    chain = next;
    return next;
  };

  const runRestoreStep = async (key: string, ctx: Pick<RunnerContext, 'pref' | 'server'>, gen: number): Promise<BackupRecordRef[] | null> => {
    // Uploads off (no server) means no automatic GETs either; preference off means none at all.
    if (ctx.pref === 'off' || ctx.server === null) return null;
    const fresh = await fold(key);
    await restore(key, { records: fresh, generation: gen });
    return fresh;
  };

  const actorFor = (ctx: RunnerContext, directoryId: string) => ctx.actor && {
    actorPubkey: ctx.actor.actorPubkey, actorDeviceId: ctx.actor.actorDeviceId,
    actorRole: (directoryId === 'owner' ? 'owner' : 'guardian') as 'owner' | 'guardian',
  };

  return {
    runOnUnlock() {
      const first = getContext();
      const gen = contactPictureGeneration();
      if (!first.encryptionKey || first.pairedChild || latchedGeneration === gen) return Promise.resolve();
      const key = first.encryptionKey;
      latchedGeneration = gen;
      return enqueue(async () => {
        const ctx = getContext();
        if (ctx.encryptionKey !== key || ctx.pairedChild || contactPictureGeneration() !== gen) return;
        const records = await runRestoreStep(key, ctx, gen);
        const env: BackupEnv = { ...ctx, encryptionKey: key };
        if (!backupPossible(env) || !ctx.actor || !env.server) return;
        const swept = records ?? await fold(key);
        // The hooks are refreshed through the LIVE context after every write: the one
        // captured at the start may be bound to a directory the user has since left.
        const wroteOne = () => { getContext().onSweepWrote(); };
        await backupPending(key, {
          records: swept,
          server: env.server,
          pref: ctx.pref,
          generation: gen,
          writePointer: async (directoryId, contactId, p) => {
            const actor = actorFor(getContext(), directoryId);
            if (!actor) throw new Error('contacts: no actor');
            await writeOp(key, { directoryId, contactId, action: 'set-picture', value: p, actor, generation: gen });
            wroteOne();
          },
          clearPointer: async (directoryId, contactId) => {
            const actor = actorFor(getContext(), directoryId);
            if (!actor) throw new Error('contacts: no actor');
            await writeOp(key, { directoryId, contactId, action: 'clear-picture', value: {}, actor, generation: gen });
            wroteOne();
          },
        });
      });
    },

    runRestore() {
      const ctx = getContext();
      if (!ctx.encryptionKey || ctx.pairedChild || ctx.pref === 'off' || ctx.server === null) return Promise.resolve();
      if (restoreWaiting) return restoreWaiting;
      const key = ctx.encryptionKey;
      const gen = contactPictureGeneration();
      restoreWaiting = enqueue(async () => {
        restoreWaiting = null;
        const now = getContext();
        if (now.encryptionKey !== key || now.pairedChild || contactPictureGeneration() !== gen) return;
        await runRestoreStep(key, now, gen);
      });
      return restoreWaiting;
    },

    async clearPointer(directoryId, contactId) {
      const ctx = getContext();
      const actor = actorFor(ctx, directoryId);
      if (!ctx.encryptionKey || ctx.pairedChild || !actor) throw new Error('contacts: cannot clear picture');
      await writeOp(ctx.encryptionKey, { directoryId, contactId, action: 'clear-picture', value: {}, actor });
      getContext().onSweepWrote();
    },
  };
}
