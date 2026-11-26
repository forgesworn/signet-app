/**
 * Backfill: send a guardian's local card backdrops that the child's phone does
 * not have yet. A backdrop picked before a phone was paired (or before sending
 * existed, or on a slot an unpair just cleared) sits device-local with the card
 * reading "Send to <name>'s phone"; this sends those without waiting for a tap.
 *
 * A slot qualifies by the card's own `unsent` rule (`useCardBackdrop`): it is
 * linked and sendable, its own `backdrop:` row exists, and the slot did not
 * record sending that exact picture (`sent && sentDigest === localDigest`).
 *
 * Quiet and safe by construction:
 * - sequential, once per `(slot, paired phone, picture digest)` per unlock (`attempted`, kept
 *   by the caller) while nothing else changes the slot; a failure stays silent
 *   and the card's retry button remains. Each attempt remembers the slot's send
 *   generation as it stood afterwards, so the stale dependants snapshot right
 *   after a send cannot send twice, yet a slot whose sent copy was cleared since
 *   (hidden from the phone, which bumps the generation, then shown again) is
 *   sent again in the same unlock;
 * - a user action always wins. A slot with a send or remove in flight is
 *   skipped, and the send carries the slot generation read BEFORE the stored
 *   rows were looked at, so a set or remove the user starts meanwhile is never
 *   superseded by it (`BackdropSendDeps.backfill`). The other direction needs
 *   nothing: a user action started during the backfill's upload outranks it
 *   and the backfill discards what it uploaded.
 */

import { backdropSlotState } from './backdrop-send';
import type { DependantBackdropLookup } from './backdrop-send-context';

export interface BackfillDeps {
  /** Every dependant slot pubkey (the lookup resolves each; hidden or unpaired ones come back unsendable). */
  slotPubkeys: () => readonly string[];
  /** The latest lookup (rebuilt whenever the dependants change). */
  lookup: () => DependantBackdropLookup;
  /** The device's own `backdrop:` picture for the pubkey, or null. */
  readLocal: (pubkey: string) => Promise<Blob | null>;
  digest: (blob: Blob) => Promise<string>;
  /**
   * `slotKey:pairing:digest` already tried this unlock, each with the slot's
   * send generation right after that attempt; mutated. Tried again only once
   * something else has moved the generation on.
   */
  attempted: Map<string, number>;
  /** False once the run should stop (locked, unmounted, disabled). */
  isLive: () => boolean;
}

/** Resolves with how many sends it started. Never throws. */
export async function runBackdropBackfill(deps: BackfillDeps): Promise<number> {
  let started = 0;
  const seen = new Set<string>();
  for (const pubkey of deps.slotPubkeys()) {
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    if (!deps.isLive()) return started;
    try {
      const link = deps.lookup()(pubkey);
      if (!link || !link.canSend || !link.unlocked) continue;
      const state = backdropSlotState(link.slotKey);
      if (state.busy) continue;
      const blob = await deps.readLocal(pubkey);
      if (!blob) continue;
      const digest = await deps.digest(blob);
      if (link.sent && link.sentDigest === digest) continue;
      // The pairing is part of the key: after an unpair and a re-pair the new phone has nothing yet.
      const memo = `${link.slotKey}:${link.pairing ?? ''}:${digest}`;
      if (deps.attempted.get(memo) === state.generation) continue;
      if (!deps.isLive()) return started;
      // Held at the generation read before the send while it runs, so a pass
      // started meanwhile skips it; replaced by the one after it once it settles.
      deps.attempted.set(memo, state.generation);
      started += 1;
      try {
        await link.send(blob, { backfill: { generation: state.generation } });
      } finally {
        deps.attempted.set(memo, backdropSlotState(link.slotKey).generation);
      }
    } catch {
      // Silent: the card's retry button is still there.
    }
  }
  return started;
}
