/**
 * The child's half of "a backdrop the guardian set arrives on this phone".
 *
 * Driven from the STORED identity's slots, not from the inventory event: the
 * guardian republishes only on change and `mergeInventory` drops stale
 * revisions, so a fetch tied to the event would never be retried after a
 * failure. Running it on unlock and after every merge makes "fetch failures
 * are silent and retried on the next apply" true.
 *
 * - A slot naming a backdrop whose hash differs from the stored guardian copy:
 *   fetch (same SSRF guard as inventory avatars), verify the hash, decrypt,
 *   store in `backdrop-guardian:<pubkey>` with the hash.
 * - A slot without one: drop the guardian row.
 * - A pubkey that is no longer a slot at all (the persona left the inventory):
 *   drop its guardian row AND the child's own `backdrop:<pubkey>` row, which
 *   nothing else would ever clean up. A key-range scan, so it is idempotent and
 *   also catches rows a crashed run left. It refuses to run when the identity
 *   names no slot, so an empty or bad inventory can never wipe the child's own
 *   pictures.
 *
 * Plain rows in the preferences store: no unlock key is needed to write them,
 * but the runner only runs while unlocked on a paired-child install.
 */

import { fetchBackdrop as defaultFetchBackdrop } from './backdrop-blob';
import * as db from './db';
import { refreshCardBackdrop } from '../hooks/useCardBackdrop';

export interface BackdropPointer { hash: string; blossomUrl: string; keyHex: string }
export interface SlotView { pubkey: string; pointer: BackdropPointer | null }

interface SlotLike { publicKey: string; backdropHash?: string; backdropBlossomUrl?: string; backdropKey?: string }
export interface IdentityView {
  id: string;
  naturalPerson: SlotLike;
  persona: SlotLike;
  extraPersonas?: readonly SlotLike[];
}

export interface GuardianBackdropDeps {
  fetchBackdrop: (p: BackdropPointer) => Promise<Blob>;
  getGuardianBackdrop: (pubkey: string) => Promise<{ blob: Blob; hash: string } | null>;
  setGuardianBackdrop: (pubkey: string, blob: Blob, hash: string) => Promise<void>;
  deleteGuardianBackdrop: (pubkey: string) => Promise<void>;
  deleteOwnBackdrop: (pubkey: string) => Promise<void>;
  listRowPubkeys: () => Promise<{ own: string[]; guardian: string[] }>;
  /** Re-read both rows for the pubkey and repaint every card of it. */
  refresh: (pubkey: string) => Promise<void>;
  /** False once the run has been cancelled (lock, unmount): nothing more is stored or painted. */
  isLive: () => boolean;
}

export const defaultGuardianBackdropDeps = (isLive: () => boolean): GuardianBackdropDeps => ({
  fetchBackdrop: defaultFetchBackdrop,
  getGuardianBackdrop: db.getGuardianBackdrop,
  setGuardianBackdrop: db.setGuardianBackdrop,
  deleteGuardianBackdrop: db.deleteGuardianBackdrop,
  deleteOwnBackdrop: db.deleteCardBackdrop,
  listRowPubkeys: db.listBackdropRowPubkeys,
  refresh: refreshCardBackdrop,
  isLive,
});

/** Every slot with a key, persona first, and the backdrop it points at (a half-formed pointer counts as none). */
export function slotsOf(identity: IdentityView): SlotView[] {
  const out: SlotView[] = [];
  const add = (slot: SlotLike | undefined) => {
    if (!slot?.publicKey) return;
    const pointer = slot.backdropHash && slot.backdropBlossomUrl && slot.backdropKey
      ? { hash: slot.backdropHash, blossomUrl: slot.backdropBlossomUrl, keyHex: slot.backdropKey }
      : null;
    out.push({ pubkey: slot.publicKey, pointer });
  };
  add(identity.persona);
  add(identity.naturalPerson);
  for (const ep of identity.extraPersonas ?? []) add(ep);
  return out;
}

// Module-level so two overlapping runs (an unlock and a merge landing together)
// never fetch the same picture twice.
const inFlight = new Map<string, Promise<void>>();

async function syncSlot(slot: SlotView, deps: GuardianBackdropDeps): Promise<void> {
  const { pubkey, pointer } = slot;
  const stored = await deps.getGuardianBackdrop(pubkey).catch(() => null);
  if (!pointer) {
    if (!stored) return;
    await deps.deleteGuardianBackdrop(pubkey);
    if (deps.isLive()) await deps.refresh(pubkey);
    return;
  }
  if (stored?.hash === pointer.hash) return;
  const flightKey = `${pubkey}:${pointer.hash}`;
  const running = inFlight.get(flightKey);
  if (running) { await running; return; }
  const run = (async () => {
    const blob = await deps.fetchBackdrop(pointer);
    if (!deps.isLive()) return;
    await deps.setGuardianBackdrop(pubkey, blob, pointer.hash);
    await deps.refresh(pubkey);
  })().finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, run);
  await run;
}

/** Bring the guardian-backdrop rows in line with the stored identity's slots. Never throws. */
export async function syncGuardianBackdrops(identity: IdentityView | null, deps: GuardianBackdropDeps): Promise<void> {
  if (!identity) return;
  const slots = slotsOf(identity);
  // An identity that names no slot says nothing about which personas left.
  if (slots.length === 0) return;

  for (const slot of slots) {
    if (!deps.isLive()) return;
    try {
      await syncSlot(slot, deps);
    } catch {
      // Silent: the next run retries.
    }
  }

  if (!deps.isLive()) return;
  try {
    const keep = new Set([identity.id, ...slots.map(s => s.pubkey)]);
    const rows = await deps.listRowPubkeys();
    const departed = new Set([...rows.own, ...rows.guardian].filter(pk => !keep.has(pk)));
    for (const pubkey of departed) {
      if (!deps.isLive()) return;
      if (rows.guardian.includes(pubkey)) await deps.deleteGuardianBackdrop(pubkey);
      if (rows.own.includes(pubkey)) await deps.deleteOwnBackdrop(pubkey);
      await deps.refresh(pubkey);
    }
  } catch {
    // Silent: an orphan row is invisible, and the next run sweeps again.
  }
}
