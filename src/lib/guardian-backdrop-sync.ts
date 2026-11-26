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
  /**
   * Every pubkey that may legitimately own a backdrop row on this device: the
   * slots (and id) of EVERY paired-child account it holds, not just the active
   * one, so switching account never loses the others' pictures. Null when it
   * cannot be proved, which skips the sweep.
   */
  loadDeviceKeepSet: () => Promise<Set<string> | null>;
  /** Re-read both rows for the pubkey and repaint every card of it. */
  refresh: (pubkey: string) => Promise<void>;
  /** False once the run has been cancelled (lock, unmount): nothing more is stored or painted. */
  isLive: () => boolean;
}

async function deviceKeepSet(encryptionKey: string): Promise<Set<string> | null> {
  try {
    const keep = new Set<string>();
    for (const meta of await db.listPairedChildMetas()) {
      keep.add(meta.dependantPubkey);
      const stored = await db.loadIdentityDecrypted(meta.dependantPubkey, encryptionKey);
      if (stored) for (const slot of slotsOf(stored)) keep.add(slot.pubkey);
    }
    return keep;
  } catch {
    return null;
  }
}

export const defaultGuardianBackdropDeps = (isLive: () => boolean, encryptionKey: string): GuardianBackdropDeps => ({
  fetchBackdrop: defaultFetchBackdrop,
  getGuardianBackdrop: db.getGuardianBackdrop,
  setGuardianBackdrop: db.setGuardianBackdrop,
  deleteGuardianBackdrop: db.deleteGuardianBackdrop,
  deleteOwnBackdrop: db.deleteCardBackdrop,
  listRowPubkeys: db.listBackdropRowPubkeys,
  loadDeviceKeepSet: () => deviceKeepSet(encryptionKey),
  refresh: refreshCardBackdrop,
  isLive,
});

/**
 * Every slot with a key, persona first, and the backdrop it points at (a
 * half-formed pointer counts as none). One entry per pubkey: a key shared by two
 * slots (an imported persona aliasing the real-name slot) is one picture, and a
 * pointer on either slot wins over none, so a run never stores the row and then
 * deletes it.
 */
export function slotsOf(identity: IdentityView): SlotView[] {
  const out: SlotView[] = [];
  const add = (slot: SlotLike | undefined) => {
    if (!slot?.publicKey) return;
    const pointer = slot.backdropHash && slot.backdropBlossomUrl && slot.backdropKey
      ? { hash: slot.backdropHash, blossomUrl: slot.backdropBlossomUrl, keyHex: slot.backdropKey }
      : null;
    const seen = out.find(s => s.pubkey === slot.publicKey);
    if (seen) { if (!seen.pointer) seen.pointer = pointer; return; }
    out.push({ pubkey: slot.publicKey, pointer });
  };
  add(identity.persona);
  add(identity.naturalPerson);
  for (const ep of identity.extraPersonas ?? []) add(ep);
  return out;
}

// Module-level so two overlapping runs (an unlock and a merge landing together)
// never fetch the same picture twice. Only the FETCH is shared: each run does
// its own liveness check, store and repaint, so a run that joins a cancelled
// run's fetch still stores the picture.
const fetches = new Map<string, Promise<Blob>>();

function sharedFetch(key: string, start: () => Promise<Blob>): Promise<Blob> {
  const running = fetches.get(key);
  if (running) return running;
  const p = start().finally(() => { fetches.delete(key); });
  fetches.set(key, p);
  return p;
}

// Bumped by every drop (the pairing ended). A run holds the value it started
// under and writes a guardian row only while it is unchanged, so a pass that was
// already fetching when the pairing ended cannot put a picture back after the
// drop deleted them all. Rows being written at that moment are awaited by the drop.
let dropEpoch = 0;
const rowWrites = new Set<Promise<unknown>>();

async function writeGuardianRow(epoch: number, deps: GuardianBackdropDeps, pubkey: string, blob: Blob, hash: string): Promise<boolean> {
  if (epoch !== dropEpoch || !deps.isLive()) return false;
  const write = Promise.resolve(deps.setGuardianBackdrop(pubkey, blob, hash));
  const tracked = write.catch(() => undefined);
  rowWrites.add(tracked);
  try { await write; } finally { rowWrites.delete(tracked); }
  return true;
}

async function syncSlot(slot: SlotView, deps: GuardianBackdropDeps, epoch: number): Promise<void> {
  const { pubkey, pointer } = slot;
  const stored = await deps.getGuardianBackdrop(pubkey).catch(() => null);
  if (!pointer) {
    if (!stored) return;
    await deps.deleteGuardianBackdrop(pubkey);
    if (deps.isLive()) await deps.refresh(pubkey);
    return;
  }
  if (stored?.hash === pointer.hash) return;
  const blob = await sharedFetch(`${pubkey}:${pointer.hash}`, () => deps.fetchBackdrop(pointer));
  if (!await writeGuardianRow(epoch, deps, pubkey, blob, pointer.hash)) return;
  await deps.refresh(pubkey);
}

/** Bring the guardian-backdrop rows in line with the stored identity's slots. Never throws. */
export async function syncGuardianBackdrops(identity: IdentityView | null, deps: GuardianBackdropDeps): Promise<void> {
  if (!identity) return;
  const slots = slotsOf(identity);
  // An identity that names no slot says nothing about which personas left.
  if (slots.length === 0) return;
  const epoch = dropEpoch;

  for (const slot of slots) {
    if (!deps.isLive()) return;
    try {
      await syncSlot(slot, deps, epoch);
    } catch {
      // Silent: the next run retries.
    }
  }

  if (!deps.isLive()) return;
  try {
    const everyone = await deps.loadDeviceKeepSet();
    // Cannot prove which pubkeys belong to the device's other accounts: sweep nothing.
    if (!everyone) return;
    const keep = new Set([identity.id, ...slots.map(s => s.pubkey), ...everyone]);
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

/**
 * The pairing ended: drop every picture a guardian sent (`backdrop-guardian:`
 * rows) and repaint, so each card falls back to the child's own pick or none.
 * The child's own `backdrop:` picks stay. Best effort per row, never throws.
 */
export async function dropGuardianBackdrops(deps: Pick<GuardianBackdropDeps, 'deleteGuardianBackdrop' | 'listRowPubkeys' | 'refresh'>): Promise<void> {
  // Passes already running may not start another row write; the ones mid-write
  // finish before the rows are listed, so the drop sees (and deletes) them.
  dropEpoch++;
  await Promise.all([...rowWrites]);
  let pubkeys: string[];
  try { pubkeys = (await deps.listRowPubkeys()).guardian; } catch { return; }
  for (const pubkey of pubkeys) {
    try {
      await deps.deleteGuardianBackdrop(pubkey);
      await deps.refresh(pubkey);
    } catch { /* the next run of the sweep retries */ }
  }
}

export const defaultDropGuardianBackdropDeps = (): Pick<GuardianBackdropDeps, 'deleteGuardianBackdrop' | 'listRowPubkeys' | 'refresh'> => ({
  deleteGuardianBackdrop: db.deleteGuardianBackdrop,
  listRowPubkeys: db.listBackdropRowPubkeys,
  refresh: refreshCardBackdrop,
});
