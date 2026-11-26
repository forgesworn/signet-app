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

export interface BackdropSendDeps {
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
   */
  saveSlot: (meta: BackdropMetadata | null) => Promise<{ previous?: { hash: string; server: string } }>;
  deleteBlob: (domain: string, hash: string, server: string) => Promise<DeleteOutcome>;
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

  let meta: BackdropMetadata;
  try {
    meta = await (deps.upload ?? uploadBackdrop)(blob, deps.blossomUrl, deps.blossomConsent, deps.encryptionKey);
  } catch (err) {
    return { ok: false, reason: reasonFor(err) };
  }

  // The new blob is an orphan nothing references until the pointer lands.
  const discard = () => { void deps.deleteBlob(BACKDROP_UPLOADER_DOMAIN, meta.hash, meta.blossomUrl).catch(() => undefined); };

  const liveKey = deps.getKey ? deps.getKey() : deps.encryptionKey;
  if (liveKey === null || liveKey !== deps.encryptionKey) {
    // Locked mid-upload. Deleting needs the unlock key (the uploader secret is
    // sealed under it), so while locked this attempt is a silent no-op and the
    // blob stays on the server as an unreferenced, encrypted orphan.
    discard();
    return { ok: false, reason: BACKDROP_COPY.reasons.locked };
  }

  let previous: { hash: string; server: string } | undefined;
  try {
    ({ previous } = await deps.saveSlot(meta));
  } catch {
    discard();
    return { ok: false, reason: BACKDROP_COPY.reasons.failed };
  }

  // Replaced: the old blob goes now that nothing stored points at it.
  const deletion = deleteReplacedBackdrop(previous, meta.hash, deps.deleteBlob).catch(() => undefined);
  return { ok: true, deletion };
}

/** Clear the slot's pointer (the publisher republishes without it), then delete the blob. Never throws. */
export async function removeBackdropFromChild(deps: Pick<BackdropSendDeps, 'saveSlot' | 'deleteBlob'>): Promise<void> {
  let previous: { hash: string; server: string } | undefined;
  try {
    ({ previous } = await deps.saveSlot(null));
  } catch {
    // Still pointed at: leave the blob so the child's copy keeps working.
    return;
  }
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
  setSlot: (depId: string, target: string, meta: BackdropMetadata | null) => Promise<{ previous?: { hash: string; server: string } }>;
  deleteBlob: BackdropSendDeps['deleteBlob'];
  upload?: BackdropSendDeps['upload'];
}

/** The part of a dependant the lookup reads. */
export interface DependantSlotsView {
  id: string;
  displayName: string;
  /** A phone is paired when `authorizedClientPubkey` is set (phone-paired and child-direct both write it): the publisher's own gate. */
  bunkerEndpoint?: { authorizedClientPubkey?: string };
  naturalPerson: { publicKey: string; backdropHash?: string; backdropKey?: string; backdropBlossomUrl?: string };
  persona: { publicKey: string; backdropHash?: string; backdropKey?: string; backdropBlossomUrl?: string };
  extraPersonas?: ReadonlyArray<{ publicKey: string; backdropHash?: string; backdropKey?: string; backdropBlossomUrl?: string }>;
}

/**
 * Which card pubkeys are a guardian's dependant slots, and how to send a
 * backdrop for each. Resolves by slot pubkey across every dependant (not by
 * carousel row type), so a dependant card on the guardian's home ring and the
 * same dependant's persona cards in child mode on the guardian's phone both
 * link. Persona is matched before the real-name slot, so a key shared by both
 * (an imported persona) is the persona. A card that is not a dependant slot
 * gets null, as does a dependant with no phone paired yet and everything on a
 * paired-child install.
 */
export function buildDependantBackdropLookup(env: BackdropLinkEnv): (pubkey: string) => import('./backdrop-send-context').DependantBackdropLink | null {
  if (env.isPairedChild) return () => null;
  return (pubkey: string) => {
    if (!pubkey) return null;
    for (const dep of env.dependants) {
      // No phone paired: the inventory goes to nobody, so there is nothing to
      // send to and the backdrop stays device-local ("Only on this device").
      if (!dep.bunkerEndpoint?.authorizedClientPubkey) continue;
      let target: string | null = null;
      let slot: { backdropHash?: string; backdropKey?: string; backdropBlossomUrl?: string } | undefined;
      if (dep.persona.publicKey === pubkey) { target = 'persona'; slot = dep.persona; }
      else if (dep.naturalPerson.publicKey === pubkey) { target = 'natural-person'; slot = dep.naturalPerson; }
      else {
        const extra = dep.extraPersonas?.find(p => p.publicKey === pubkey);
        if (extra) { target = extra.publicKey; slot = extra; }
      }
      if (target === null || !slot) continue;
      const t = target;
      const deps = (): BackdropSendDeps => ({
        encryptionKey: env.getKey(),
        getKey: env.getKey,
        blossomUrl: env.blossomUrl,
        blossomConsent: env.blossomConsent,
        upload: env.upload,
        saveSlot: meta => env.setSlot(dep.id, t, meta),
        deleteBlob: env.deleteBlob,
      });
      return {
        name: dep.displayName,
        sent: !!(slot.backdropHash && slot.backdropKey && slot.backdropBlossomUrl),
        send: blob => sendBackdropToChild(blob, deps()),
        remove: () => removeBackdropFromChild(deps()),
      };
    }
    return null;
  };
}
