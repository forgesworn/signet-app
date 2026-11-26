import { createContext } from 'react';

/** How a backdrop send to a child's phone went. A failure carries a short reason the card can show. */
export type BackdropSendResult = { ok: true } | { ok: false; reason: string };

/**
 * The link from one dependant persona's card to the child's phone, provided by
 * App on a guardian's install only. A card whose pubkey is not a dependant slot
 * of this guardian (or any card on a paired-child install) has no link, so the
 * backdrop stays purely device-local there.
 */
export interface DependantBackdropLink {
  /** The dependant's display name, for copy ("Not sent to <name>'s phone"). */
  name: string;
  /** True when the slot already names an encrypted copy for the child. */
  sent: boolean;
  /** Encrypt, upload and publish the already-saved local picture. Never throws. */
  send(blob: Blob): Promise<BackdropSendResult>;
  /** Clear the slot's pointer, republish and delete the blob. Never throws. */
  remove(): Promise<void>;
}

export type DependantBackdropLookup = (slotPubkey: string) => DependantBackdropLink | null;

export const DependantBackdropContext = createContext<DependantBackdropLookup | null>(null);
