import { createContext } from 'react';

/** How a backdrop send to a child's phone went. A failure carries a short reason the card can show. */
export type BackdropSendResult = { ok: true } | { ok: false; reason: string };

/**
 * The link from one dependant persona's card to the child's phone, provided by
 * App on a guardian's install only. A card whose pubkey is not a dependant slot
 * of this guardian (or any card on a paired-child install) has no link, so the
 * backdrop stays purely device-local there.
 *
 * A dependant's slot always has a link so that Remove can clear a pointer the
 * slot still holds; `canSend` says whether the publisher actually sends it.
 */
export interface DependantBackdropLink {
  /** The dependant's display name, for copy ("Not sent to <name>'s phone"). */
  name: string;
  /**
   * True when a phone is paired and the inventory publisher sends this slot
   * (the same visibility rule: real identity active, not hidden from or removed
   * from the paired device). When false the backdrop is device-local only.
   */
  canSend: boolean;
  /** False while the unlock key is gone: the dependant record cannot be written, so Remove is not offered. */
  unlocked: boolean;
  /** True when the slot already names an encrypted copy for the child. */
  sent: boolean;
  /** sha256 of the local picture that copy was made from; compared with the current local picture to tell if it is the one sent. */
  sentDigest?: string;
  /** The slot's sequencing key (`backdropSlotState` reads it); the same slot always has the same key. */
  slotKey: string;
  /** The paired phone's client key; a re-pair changes it, which makes an already-sent picture worth sending again. */
  pairing?: string;
  /**
   * Encrypt, upload and publish the already-saved local picture. Never throws.
   * `opts.backfill` marks an automatic resend that yields to any user action on
   * the slot (see `BackdropSendDeps.backfill`).
   */
  send(blob: Blob, opts?: { backfill?: { generation: number } }): Promise<BackdropSendResult>;
  /** Clear the slot's pointer, republish and delete the blob. Never throws. */
  remove(): Promise<void>;
}

export type DependantBackdropLookup = (slotPubkey: string) => DependantBackdropLink | null;

export const DependantBackdropContext = createContext<DependantBackdropLookup | null>(null);
