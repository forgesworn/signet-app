/**
 * The guardian's half of "send a card backdrop to the child's phone": upload an
 * encrypted copy, point the dependant's slot at it (the inventory publisher then
 * carries the pointer), and delete the blob it replaces. Pure and injectable so
 * the flow is testable outside App.tsx.
 *
 * The picture is already saved locally by the time `sendBackdropToChild` runs;
 * nothing here can undo that. Every failure leaves the local picture alone and
 * the slot as it was (so the child keeps whatever it had), and is reported as a
 * short reason the card shows.
 */

import { BlossomUploadError } from './blossom';
import { BACKDROP_UPLOADER_DOMAIN } from './blossom-uploader';
import { deleteReplacedBackdrop, type DeleteOutcome } from './blob-deletion';
import { uploadBackdrop, type BackdropMetadata } from './backdrop-blob';
import { BACKDROP_COPY } from './child-device-copy';
import type { BackdropSendResult } from './backdrop-send-context';
import { backdropDigest } from './backdrop-digest';
import { pairedDeviceAllows } from './paired-device-personas';
import { isDependantNaturalPersonActive } from './identity-display';
import type { DependantIdentity } from '../types';

export interface BackdropSendDeps {
  /**
   * Which slot this is (dependant id + target). Sends and removes on one slot
   * are ordered by it: the newest change wins, whatever order uploads land in.
   */
  slotKey: string;
  /** The unlock key the send started under; null while locked. */
  encryptionKey: string | null;
  /**
   * The LIVE unlock key, read again once the upload lands. An upload takes
   * seconds and hide = lock, so the app may have locked (or re-unlocked under
   * another key) meanwhile; the slot is then neither saved nor reloaded into state.
   */
  getKey?: () => string | null;
  blossomUrl: string | undefined;
  blossomConsent: boolean;
  upload?: (blob: Blob, url: string, consent: boolean, key: string) => Promise<BackdropMetadata>;
  /**
   * Point the dependant's slot at `meta` (or clear it with null) and persist.
   * Resolves with the blob the slot pointed at beforehand. Must have saved
   * before it resolves: the delete that follows reads the stored rows (R1).
   * `sentDigest` is the sha256 of the local picture this pointer carries,
   * stored beside it so the card can tell whether the current picture was sent.
   */
  saveSlot: (meta: BackdropMetadata | null, sentDigest?: string) => Promise<{ previous?: { hash: string; server: string } }>;
  deleteBlob: (domain: string, hash: string, server: string) => Promise<DeleteOutcome>;
}

// Per-slot "newest change" counters and save queues. Module-level because the
// lookup (and so its closures) is rebuilt whenever the dependants state changes,
// while an upload started before that is still in flight.
const generations = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

function bump(slotKey: string): number {
  const next = (generations.get(slotKey) ?? 0) + 1;
  generations.set(slotKey, next);
  return next;
}

/** Run `task` after every earlier task on this slot has settled. */
function serial<T>(slotKey: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(slotKey) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(slotKey, tail);
  void tail.then(() => { if (queues.get(slotKey) === tail) queues.delete(slotKey); });
  return run;
}

/** The reason to show for a thrown upload error: the messages the upload path writes are already plain English. */
function reasonFor(err: unknown): string {
  if (err instanceof BlossomUploadError) return err.message;
  if (err instanceof Error && err.message.length > 0 && err.message.length <= 240) return err.message;
  return BACKDROP_COPY.reasons.failed;
}

/**
 * Encrypt and upload `blob`, store the pointer, then delete the replaced blob.
 * The delete is started, not awaited, so a slow server cannot hold the card;
 * `deletion` settles when it has (for tests). Never throws.
 */
export async function sendBackdropToChild(
  blob: Blob,
  deps: BackdropSendDeps,
): Promise<BackdropSendResult & { deletion?: Promise<unknown> }> {
  if (!deps.encryptionKey) return { ok: false, reason: BACKDROP_COPY.reasons.locked };
  if (!deps.blossomUrl) return { ok: false, reason: BACKDROP_COPY.reasons.noServer };
  if (!deps.blossomConsent) return { ok: false, reason: BACKDROP_COPY.reasons.noConsent };

  // A newer send or a remove on this slot, started after this point, outranks
  // this one: it will find the counter moved on and discard what it uploaded.
  const generation = bump(deps.slotKey);

  let meta: BackdropMetadata;
  let digest: string;
  try {
    digest = await backdropDigest(blob);
    meta = await (deps.upload ?? uploadBackdrop)(blob, deps.blossomUrl, deps.blossomConsent, deps.encryptionKey);
  } catch (err) {
    return { ok: false, reason: reasonFor(err) };
  }

  // The new blob is an orphan nothing references until the pointer lands.
  const discard = () => { void deps.deleteBlob(BACKDROP_UPLOADER_DOMAIN, meta.hash, meta.blossomUrl).catch(() => undefined); };

  const saved = await serial(deps.slotKey, async (): Promise<{ ok: true; previous?: { hash: string; server: string } } | { ok: false; reason: string }> => {
    if (generations.get(deps.slotKey) !== generation) {
      discard();
      return { ok: false, reason: BACKDROP_COPY.reasons.superseded };
    }
    const liveKey = deps.getKey ? deps.getKey() : deps.encryptionKey;
    if (liveKey === null || liveKey !== deps.encryptionKey) {
      // Locked mid-upload. Deleting needs the unlock key (the uploader secret is
      // sealed under it), so while locked this attempt is a silent no-op and the
      // blob stays on the server as an unreferenced, encrypted orphan.
      discard();
      return { ok: false, reason: BACKDROP_COPY.reasons.locked };
    }
    try {
      const { previous } = await deps.saveSlot(meta, digest);
      return { ok: true, previous };
    } catch {
      discard();
      return { ok: false, reason: BACKDROP_COPY.reasons.failed };
    }
  });
  if (!saved.ok) return saved;

  // Replaced: the old blob goes now that nothing stored points at it.
  const deletion = deleteReplacedBackdrop(saved.previous, meta.hash, deps.deleteBlob).catch(() => undefined);
  return { ok: true, deletion };
}

/** Clear the slot's pointer (the publisher republishes without it), then delete the blob. Never throws. */
export async function removeBackdropFromChild(deps: Pick<BackdropSendDeps, 'slotKey' | 'saveSlot' | 'deleteBlob'>): Promise<void> {
  // Bumped before anything is awaited: an upload still in flight is now stale
  // and will discard itself, so a remove during a send wins.
  bump(deps.slotKey);
  const previous = await serial(deps.slotKey, async () => {
    try {
      return (await deps.saveSlot(null)).previous;
    } catch {
      // Still pointed at: leave the blob so the child's copy keeps working.
      return null;
    }
  });
  if (previous === null) return;
  await deleteReplacedBackdrop(previous, undefined, deps.deleteBlob).catch(() => undefined);
}

export interface BackdropLinkEnv {
  /** A paired-child install never uploads a backdrop: the guardian holds the Blossom server and uploader. */
  isPairedChild: boolean;
  dependants: readonly DependantSlotsView[];
  /** The LIVE unlock key, read at send time (the card may outlive an unlock). */
  getKey: () => string | null;
  blossomUrl: string | undefined;
  blossomConsent: boolean;
  setSlot: (depId: string, target: string, meta: BackdropMetadata | null, sentDigest?: string) => Promise<{ previous?: { hash: string; server: string } }>;
  deleteBlob: BackdropSendDeps['deleteBlob'];
  upload?: BackdropSendDeps['upload'];
}

type SlotFields = { backdropHash?: string; backdropKey?: string; backdropBlossomUrl?: string; backdropSentDigest?: string };

/** The part of a dependant the lookup reads. */
export interface DependantSlotsView extends Pick<DependantIdentity, 'hiddenOnPairedDeviceKeys' | 'childDevice' | 'naturalPersonActive'> {
  id: string;
  displayName: string;
  /** A phone is paired when `authorizedClientPubkey` is set (phone-paired and child-direct both write it): the publisher's own gate. */
  bunkerEndpoint?: { authorizedClientPubkey?: string };
  naturalPerson: { publicKey: string; displayName: string } & SlotFields;
  persona: { publicKey: string } & SlotFields;
  extraPersonas?: ReadonlyArray<{ publicKey: string; hidden?: boolean } & SlotFields>;
}

/**
 * Which card pubkeys are a guardian's dependant slots, and how to send a
 * backdrop for each. Resolves by slot pubkey across every dependant (not by
 * carousel row type), so a dependant card on the guardian's home ring and the
 * same dependant's persona cards in child mode on the guardian's phone both
 * link. Persona is matched before the real-name slot, so a key shared by both
 * (an imported persona) is the persona. A card that is not a dependant slot
 * gets null, as does everything on a paired-child install.
 *
 * Every slot of a dependant gets a link, paired or not: Remove must be able to
 * clear a pointer the slot still holds. `canSend` is the publisher's own rule
 * (`usePersonaInventoryPublisher`): a phone is paired, and the slot is one the
 * publisher sends (`pairedDeviceAllows`, real identity active).
 */
export function buildDependantBackdropLookup(env: BackdropLinkEnv): (pubkey: string) => import('./backdrop-send-context').DependantBackdropLink | null {
  if (env.isPairedChild) return () => null;
  return (pubkey: string) => {
    if (!pubkey) return null;
    for (const dep of env.dependants) {
      const allows = pairedDeviceAllows(dep);
      let target: string | null = null;
      let slot: SlotFields | undefined;
      let visible = false;
      if (dep.persona.publicKey === pubkey) { target = 'persona'; slot = dep.persona; visible = allows(dep.persona.publicKey); }
      else if (dep.naturalPerson.publicKey === pubkey) {
        target = 'natural-person'; slot = dep.naturalPerson;
        visible = isDependantNaturalPersonActive(dep) && allows(dep.naturalPerson.publicKey);
      } else {
        const extra = dep.extraPersonas?.find(p => p.publicKey === pubkey);
        if (extra) { target = extra.publicKey; slot = extra; visible = allows(extra.publicKey, extra.hidden === true); }
      }
      if (target === null || !slot) continue;
      // No phone paired: the inventory goes to nobody, so there is nothing to
      // send to and the backdrop stays device-local ("Only on this device").
      const canSend = !!dep.bunkerEndpoint?.authorizedClientPubkey && visible;
      const t = target;
      const deps = (): BackdropSendDeps => ({
        slotKey: `${dep.id}:${t}`,
        encryptionKey: env.getKey(),
        getKey: env.getKey,
        blossomUrl: env.blossomUrl,
        blossomConsent: env.blossomConsent,
        upload: env.upload,
        saveSlot: (meta, sentDigest) => env.setSlot(dep.id, t, meta, sentDigest),
        deleteBlob: env.deleteBlob,
      });
      return {
        name: dep.displayName,
        canSend,
        unlocked: env.getKey() !== null,
        sentDigest: slot.backdropSentDigest,
        sent: !!(slot.backdropHash && slot.backdropKey && slot.backdropBlossomUrl),
        send: blob => (canSend
          ? sendBackdropToChild(blob, deps())
          : Promise.resolve<BackdropSendResult>({ ok: false, reason: BACKDROP_COPY.reasons.failed })),
        remove: () => removeBackdropFromChild(deps()),
      };
    }
    return null;
  };
}
