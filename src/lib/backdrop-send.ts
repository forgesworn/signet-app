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
import { deleteReplacedBackdrop, discardUpload, type DeleteOutcome } from './blob-deletion';
import { createSlotSequencer } from './slot-sequencer';
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
   * `stillCurrent` (sends only) is for the writer to ask inside its own write
   * queue: false means an unpair or a newer change outranked this send while it
   * waited, and nothing may be saved.
   */
  saveSlot: (meta: BackdropMetadata | null, sentDigest?: string, stillCurrent?: () => boolean) => Promise<{ previous?: { hash: string; server: string } }>;
  deleteBlob: (domain: string, hash: string, server: string) => Promise<DeleteOutcome>;
  /** Test seam: remember an upload that could not be deleted (defaults to the `blob-orphan:` rows). */
  recordOrphan?: (entry: { domain: string; hash: string; url: string }) => Promise<void>;
  /**
   * An automatic resend (the backfill), never a user action. It yields to one:
   * it sends only when nothing is in flight on the slot and the slot's
   * generation is still the one the caller read BEFORE it looked at the stored
   * rows, so a set or remove the user started meanwhile is never superseded by
   * it. (The other direction needs nothing extra: a user action started after
   * this one bumps the generation and this upload discards itself.)
   */
  backfill?: { generation: number };
}

// Per-slot "newest change" counters and save queues. Module-level because the
// lookup (and so its closures) is rebuilt whenever the dependants state changes,
// while an upload started before that is still in flight. Backdrops only: the
// avatar flow has its own sequencer.
const backdropSlots = createSlotSequencer();
// Sends and removes between their start and their save, per slot.
const inFlight = new Map<string, number>();

/** Whether a send or remove is in flight on the slot, and the generation to hand `deps.backfill`. */
export function backdropSlotState(slotKey: string): { busy: boolean; generation: number } {
  return { busy: (inFlight.get(slotKey) ?? 0) > 0, generation: backdropSlots.current(slotKey) };
}

/**
 * Outrank every send in flight on a dependant's slots (an unpair is under way:
 * an upload that lands after it must discard itself, not save a pointer the
 * phone can no longer use). `slotTargets` as the lookup keys them.
 */
export function supersedeBackdropSends(dependantId: string, slotTargets: readonly string[]): void {
  for (const target of slotTargets) backdropSlots.bump(`${dependantId}:${target}`);
}

async function whileInFlight<T>(slotKey: string, run: () => Promise<T>): Promise<T> {
  inFlight.set(slotKey, (inFlight.get(slotKey) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(slotKey) ?? 1) - 1;
    if (left > 0) inFlight.set(slotKey, left); else inFlight.delete(slotKey);
  }
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

  // A backfill yields to any user action on the slot, started or in flight.
  if (deps.backfill) {
    const state = backdropSlotState(deps.slotKey);
    if (state.busy || state.generation !== deps.backfill.generation) return { ok: false, reason: BACKDROP_COPY.reasons.superseded };
  }
  // A newer send or a remove on this slot, started after this point, outranks
  // this one: it will find the counter moved on and discard what it uploaded.
  const generation = backdropSlots.bump(deps.slotKey);
  return whileInFlight(deps.slotKey, () => uploadAndSave(blob, { ...deps, blossomUrl: deps.blossomUrl as string, encryptionKey: deps.encryptionKey as string }, generation));
}

async function uploadAndSave(
  blob: Blob,
  deps: BackdropSendDeps & { blossomUrl: string; encryptionKey: string },
  generation: number,
): Promise<BackdropSendResult & { deletion?: Promise<unknown> }> {
  let meta: BackdropMetadata;
  let digest: string;
  try {
    digest = await backdropDigest(blob);
    meta = await (deps.upload ?? uploadBackdrop)(blob, deps.blossomUrl, deps.blossomConsent, deps.encryptionKey);
  } catch (err) {
    return { ok: false, reason: reasonFor(err) };
  }

  const startKey = deps.encryptionKey;
  const live = () => {
    const liveKey = deps.getKey ? deps.getKey() : startKey;
    return liveKey !== null && liveKey === startKey;
  };
  // The new blob is an orphan nothing references until the pointer lands.
  // Deleted now while the key is live; otherwise (locked: deleting needs the
  // unlock key, which seals the uploader secret) recorded for the next unlock's
  // sweep (`blob-orphan:` rows).
  const discard = () => {
    void discardUpload({
      domain: BACKDROP_UPLOADER_DOMAIN, hash: meta.hash, server: meta.blossomUrl,
      live: live(), deleteBlob: deps.deleteBlob, recordOrphan: deps.recordOrphan,
    });
  };

  const saved = await backdropSlots.serial(deps.slotKey, async (): Promise<{ ok: true; previous?: { hash: string; server: string } } | { ok: false; reason: string }> => {
    if (backdropSlots.current(deps.slotKey) !== generation) {
      discard();
      return { ok: false, reason: BACKDROP_COPY.reasons.superseded };
    }
    if (!live()) {
      // Locked (or re-unlocked under another key) mid-upload: save nothing.
      discard();
      return { ok: false, reason: BACKDROP_COPY.reasons.locked };
    }
    try {
      const { previous } = await deps.saveSlot(meta, digest, () => backdropSlots.current(deps.slotKey) === generation);
      return { ok: true, previous };
    } catch {
      // A lock during the save's own wait makes it refuse: that is a lock too,
      // and so is an unpair or newer change that ran in that wait.
      const locked = !live();
      const superseded = backdropSlots.current(deps.slotKey) !== generation;
      discard();
      return { ok: false, reason: locked ? BACKDROP_COPY.reasons.locked : superseded ? BACKDROP_COPY.reasons.superseded : BACKDROP_COPY.reasons.failed };
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
  backdropSlots.bump(deps.slotKey);
  const previous = await whileInFlight(deps.slotKey, () => backdropSlots.serial(deps.slotKey, async () => {
    try {
      return (await deps.saveSlot(null)).previous;
    } catch {
      // Still pointed at: leave the blob so the child's copy keeps working.
      return null;
    }
  }));
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
  setSlot: (depId: string, target: string, meta: BackdropMetadata | null, sentDigest?: string, stillCurrent?: () => boolean) => Promise<{ previous?: { hash: string; server: string } }>;
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
 * Whether the publisher sends the slot `target` (key `pubkey`) of `dep` to the
 * paired phone, whether or not a phone is paired: `pairedDeviceAllows` (not
 * removed from the phone, not hidden from it, not soft-deleted), and a
 * real-name slot only while it is active. The inventory publisher's own rule;
 * a slot this says no to never reaches the child, so a backdrop sent for it
 * is cleared (`useDependants`).
 */
export function dependantSlotVisible(
  dep: Pick<DependantSlotsView, 'hiddenOnPairedDeviceKeys' | 'childDevice' | 'naturalPersonActive' | 'naturalPerson' | 'persona'>,
  target: string,
  pubkey: string,
  softDeleted: boolean,
): boolean {
  const allows = pairedDeviceAllows(dep);
  return target === 'natural-person'
    ? isDependantNaturalPersonActive(dep) && allows(pubkey)
    : allows(pubkey, softDeleted);
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
      let target: string | null = null;
      let slot: SlotFields | undefined;
      let softDeleted = false;
            if (dep.persona.publicKey === pubkey) { target = 'persona'; slot = dep.persona; }
      else if (dep.naturalPerson.publicKey === pubkey) {
        target = 'natural-person'; slot = dep.naturalPerson;
      } else {
        const extra = dep.extraPersonas?.find(p => p.publicKey === pubkey);
        if (extra) { target = extra.publicKey; slot = extra; softDeleted = extra.hidden === true; }
      }
      if (target === null || !slot) continue;
      // Only for the matched dependant, so an unrelated record can never throw here.
      const visible = dependantSlotVisible(dep, target, pubkey, softDeleted);
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
        saveSlot: (meta, sentDigest, stillCurrent) => (stillCurrent
          ? env.setSlot(dep.id, t, meta, sentDigest, stillCurrent)
          : env.setSlot(dep.id, t, meta, sentDigest)),
        deleteBlob: env.deleteBlob,
      });
      return {
        name: dep.displayName,
        canSend,
        unlocked: env.getKey() !== null,
        sentDigest: slot.backdropSentDigest,
        sent: !!(slot.backdropHash && slot.backdropKey && slot.backdropBlossomUrl),
        slotKey: `${dep.id}:${t}`,
        pairing: dep.bunkerEndpoint?.authorizedClientPubkey,
        send: (blob, opts) => (canSend
          ? sendBackdropToChild(blob, { ...deps(), backfill: opts?.backfill })
          : Promise.resolve<BackdropSendResult>({ ok: false, reason: BACKDROP_COPY.reasons.failed })),
        remove: () => removeBackdropFromChild(deps()),
      };
    }
    return null;
  };
}
