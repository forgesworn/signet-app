/**
 * Set or clear a persona's in-app avatar (owner personas and dependant slots)
 * with the same guards as the card-backdrop send (`backdrop-send.ts`): an
 * upload takes seconds, and the app may lock, re-unlock under another key, or
 * see a newer change on the same slot meanwhile. Pure and injectable so the
 * flow is testable outside App.tsx.
 *
 * - The newest set or clear on a slot wins, whatever order uploads land in.
 * - After the upload: superseded → the new blob is discarded; the key no longer
 *   live → nothing is saved and the blob is recorded as an orphan (deleting
 *   needs the key) for the next unlock's sweep; the save refusing (slot gone,
 *   or a lock during the save's own wait) → discarded or recorded likewise.
 * - The replaced avatar is deleted after the save, by a deleter that reads the
 *   key live at that moment (never the key the upload started under).
 */

import { AVATAR_UPLOADER_DOMAIN } from './blossom-uploader';
import { deleteReplacedAvatar, discardUpload, type BlobDeleter } from './blob-deletion';
import { createSlotSequencer } from './slot-sequencer';

export interface AvatarMeta { hash: string; blossomUrl: string; keyHex: string; updatedAt: number }
type Previous = { hash: string; server: string } | undefined;

interface AvatarSlotDeps {
  /** Which slot (owner or dependant, and the target): changes on one slot are ordered by it. */
  slotKey: string;
  /** The unlock key the change started under. */
  encryptionKey: string;
  /** The LIVE unlock key, read again after the upload and after a refused save. */
  getKey: () => string | null;
  /** Deletes under the key live at the time of the call. */
  deleteBlob: BlobDeleter;
  /** Test seam: defaults to the `blob-orphan:` rows. */
  recordOrphan?: (entry: { domain: string; hash: string; url: string }) => Promise<void>;
}

export interface AvatarSetDeps extends AvatarSlotDeps {
  /** Downscale, encrypt and upload; resolves with the stored blob's metadata. Its errors are the caller's to show. */
  upload: () => Promise<AvatarMeta>;
  /** Point the slot at `meta` and persist. Resolves with the avatar it held before. Throws (saving nothing) when the slot is gone or the key went. */
  saveSlot: (meta: AvatarMeta) => Promise<{ previous?: Previous }>;
}

export interface AvatarClearDeps extends AvatarSlotDeps {
  /** Clear the slot's avatar and persist. Resolves with the avatar it held before. */
  clearSlot: () => Promise<{ previous?: Previous }>;
}

export type AvatarChangeResult =
  | { ok: true; meta?: AvatarMeta; deletion: Promise<string | undefined> }
  | { ok: false; reason: 'superseded' | 'locked' | 'failed'; error?: unknown };

// Avatars only: a backdrop send on the same slot has its own sequencer.
const avatarSlots = createSlotSequencer();

function isLive(deps: AvatarSlotDeps): boolean {
  const k = deps.getKey();
  return k !== null && k === deps.encryptionKey;
}

/**
 * Upload a new avatar and point the slot at it. Upload errors throw (the
 * picker shows them); everything after the upload resolves with a result.
 */
export async function setSlotAvatar(deps: AvatarSetDeps): Promise<AvatarChangeResult> {
  // Bumped before anything is awaited: a set or clear started after this
  // point outranks it.
  const generation = avatarSlots.bump(deps.slotKey);
  const meta = await deps.upload();
  const discard = () => discardUpload({
    domain: AVATAR_UPLOADER_DOMAIN, hash: meta.hash, server: meta.blossomUrl,
    live: isLive(deps), deleteBlob: deps.deleteBlob, recordOrphan: deps.recordOrphan,
  });
  return avatarSlots.serial(deps.slotKey, async (): Promise<AvatarChangeResult> => {
    if (avatarSlots.current(deps.slotKey) !== generation) {
      void discard();
      return { ok: false, reason: 'superseded' };
    }
    if (!isLive(deps)) {
      void discard();
      return { ok: false, reason: 'locked' };
    }
    let previous: Previous;
    try {
      ({ previous } = await deps.saveSlot(meta));
    } catch (error) {
      const locked = !isLive(deps);
      void discard();
      return { ok: false, reason: locked ? 'locked' : 'failed', error };
    }
    // R3: the replaced avatar goes now that nothing stored points at it.
    const deletion = deleteReplacedAvatar(previous, meta.hash, deps.deleteBlob).catch(() => undefined);
    return { ok: true, meta, deletion };
  });
}

/** Clear the slot's avatar, then delete the blob it pointed at. Outranks any set still uploading. */
export async function clearSlotAvatar(deps: AvatarClearDeps): Promise<AvatarChangeResult> {
  avatarSlots.bump(deps.slotKey);
  return avatarSlots.serial(deps.slotKey, async (): Promise<AvatarChangeResult> => {
    if (!isLive(deps)) return { ok: false, reason: 'locked' };
    let previous: Previous;
    try {
      ({ previous } = await deps.clearSlot());
    } catch (error) {
      return { ok: false, reason: isLive(deps) ? 'failed' : 'locked', error };
    }
    const deletion = deleteReplacedAvatar(previous, undefined, deps.deleteBlob).catch(() => undefined);
    return { ok: true, deletion };
  });
}

/**
 * What a picker does with a change that did not land: a superseded one says
 * nothing (the newer change owns the picker); a lock or a failed save throws,
 * for the picker to show.
 */
export function avatarChangeOutcome(res: Extract<AvatarChangeResult, { ok: false }>): undefined {
  if (res.reason === 'superseded') return undefined;
  if (res.reason === 'locked') throw new Error('Locked before the picture was saved. Unlock and try again.');
  throw res.error instanceof Error ? res.error : new Error('Could not save the picture.');
}
