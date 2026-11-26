import { useCallback, useContext, useEffect, useState } from 'react';
import {
  getCardBackdrop, setCardBackdrop, deleteCardBackdrop, getGuardianBackdrop, deleteGuardianBackdrop,
} from '../lib/db';
import { DependantBackdropContext, type BackdropSendResult, type DependantBackdropLink } from '../lib/backdrop-send-context';

/** Largest source file we will try to decode. Anything a phone camera makes fits. */
export const MAX_BACKDROP_SOURCE_BYTES = 40 * 1024 * 1024;
/** Longest edge of the stored backdrop. Enough for a 3x phone card, small to decode on every mount. */
export const BACKDROP_MAX_EDGE_PX = 1280;
const BACKDROP_JPEG_QUALITY = 0.85;
/** Backdrops are stored in clear and painted on the locked card, so say so where one is picked. */
export const BACKDROP_PRIVACY_COPY = 'Only on this device. Not encrypted, and it shows while the app is locked.';

/**
 * `send` is present only on a guardian's dependant card: how the copy for the
 * child's phone went. A failed send leaves the local picture in place.
 */
export type BackdropSetResult = { ok: true; send?: BackdropSendResult } | { ok: false; reason: string };

/** Whose picture is showing: this device's own pick, or the one a guardian sent (child's phone only). */
export type BackdropSource = 'own' | 'guardian';

interface Resolved { url: string | null; source: BackdropSource | null }
const NONE: Resolved = { url: null, source: null };

// One object URL per identity for the life of the page. Every card of that
// identity (both carousel screens mid-swipe, the settings row, the edit
// control) reads the same URL, so a freshly mounted card paints its backdrop
// on the first frame instead of after an IndexedDB round trip.
//
// Two rows can feed it: the device's own `backdrop:<pubkey>` pick, which always
// wins, and `backdrop-guardian:<pubkey>`, the picture a guardian sent to a
// paired child. The cache holds whichever one resolves.
const resolved = new Map<string, Resolved>();
const loads = new Map<string, Promise<Resolved>>();
const listeners = new Set<(pubkey: string) => void>();

function notify(pubkey: string): void {
  for (const listener of listeners) listener(pubkey);
}

async function readRows(pubkey: string): Promise<Resolved> {
  try {
    const own = await getCardBackdrop(pubkey);
    if (own) return { url: URL.createObjectURL(own), source: 'own' };
  } catch { /* fall through to the guardian's copy */ }
  try {
    const guardian = await getGuardianBackdrop(pubkey);
    if (guardian) return { url: URL.createObjectURL(guardian.blob), source: 'guardian' };
  } catch { /* none */ }
  return NONE;
}

function load(pubkey: string): Promise<Resolved> {
  const cached = resolved.get(pubkey);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = loads.get(pubkey);
  if (running) return running;
  const promise = readRows(pubkey)
    .then(entry => {
      // A write that landed while this read was in flight wins.
      if (!resolved.has(pubkey)) resolved.set(pubkey, entry);
      else if (entry.url) URL.revokeObjectURL(entry.url);
      return resolved.get(pubkey) ?? NONE;
    })
    .finally(() => { loads.delete(pubkey); });
  loads.set(pubkey, promise);
  return promise;
}

function remember(pubkey: string, entry: Resolved): void {
  const previous = resolved.get(pubkey);
  if (previous?.url && previous.url !== entry.url) URL.revokeObjectURL(previous.url);
  resolved.set(pubkey, entry);
  notify(pubkey);
}

/**
 * Re-read both rows for an identity and repaint every card of it. Called after
 * anything that changes which row should show: the child's fetch of the
 * guardian's picture landing or being dropped, and the child removing its own.
 */
export async function refreshCardBackdrop(pubkey: string): Promise<void> {
  remember(pubkey, await readRows(pubkey));
}

/** Synchronous read of the cached backdrop URL (null when none, undefined when not loaded yet). */
export function peekCardBackdropUrl(pubkey: string): string | null | undefined {
  return resolved.get(pubkey)?.url;
}

/**
 * Re-encode a picked image as a JPEG no larger than BACKDROP_MAX_EDGE_PX on
 * its long edge. Phone photos are 3 to 12 MB and several thousand pixels
 * across; the card needs neither, and decoding the original on every swipe
 * would stall the slide.
 */
export async function downscaleBackdrop(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, BACKDROP_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', BACKDROP_JPEG_QUALITY));
    if (!out) throw new Error('encode failed');
    return out;
  } finally {
    bitmap.close();
  }
}

/**
 * Drop an identity's backdrop for good: delete BOTH stored rows (its own pick
 * and any guardian-sent copy) and release the cached object URL so every
 * mounted card repaints without it. Best-effort and never throws, so it can sit
 * inside a persona or dependant delete path without being able to block it. A
 * null cache entry means "no backdrop".
 */
export async function forgetCardBackdrop(pubkey: string): Promise<void> {
  try {
    await deleteCardBackdrop(pubkey);
  } catch {
    // Best-effort: an orphan row is harmless and invisible.
  }
  try {
    await deleteGuardianBackdrop(pubkey);
  } catch {
    // Same: best-effort.
  }
  remember(pubkey, NONE);
}

/** Test seam: forget every cached URL. */
export function resetCardBackdropCacheForTests(): void {
  resolved.clear();
  loads.clear();
}

/**
 * Card backdrop for one identity — the card's "wallpaper". Keyed by the
 * identity's pubkey so every persona (and the real identity) can carry its
 * own. The device's own pick is local to this install, like a phone wallpaper.
 * On a guardian's phone, a dependant's backdrop is also sent, encrypted, to the
 * child's phone (`send` on the result; see `DependantBackdropContext`). On a
 * child's phone a picture the guardian sent shows when the child has not picked
 * their own (`source: 'guardian'`). `url` is null while loading or when none is set.
 */
export function useCardBackdrop(pubkey: string | undefined): {
  url: string | null;
  source: BackdropSource | null;
  /** The dependant link on a guardian's dependant card; null everywhere else. */
  link: DependantBackdropLink | null;
  set: (file: File) => Promise<BackdropSetResult>;
  clear: () => Promise<void>;
} {
  const [entry, setEntry] = useState<Resolved>(() => (pubkey ? resolved.get(pubkey) ?? NONE : NONE));
  const lookup = useContext(DependantBackdropContext);
  const link = pubkey && lookup ? lookup(pubkey) : null;

  useEffect(() => {
    if (!pubkey) { setEntry(NONE); return; }
    let live = true;
    const sync = () => { if (live) setEntry(resolved.get(pubkey) ?? NONE); };
    const listener = (changed: string) => { if (changed === pubkey) sync(); };
    listeners.add(listener);
    sync();
    if (!resolved.has(pubkey)) void load(pubkey).then(sync);
    return () => { live = false; listeners.delete(listener); };
  }, [pubkey]);

  const set = useCallback(async (file: File): Promise<BackdropSetResult> => {
    if (!pubkey) return { ok: false, reason: 'No identity selected.' };
    if (!file.type.startsWith('image/')) return { ok: false, reason: 'Choose an image file.' };
    if (file.size > MAX_BACKDROP_SOURCE_BYTES) return { ok: false, reason: 'That image is over 40 MB. Choose a smaller one.' };
    let stored: Blob;
    try {
      stored = await downscaleBackdrop(file);
    } catch {
      return { ok: false, reason: "That image type can't be read here. Try a JPEG or PNG." };
    }
    try {
      await setCardBackdrop(pubkey, stored);
    } catch {
      return { ok: false, reason: 'Could not save the backdrop. Try again.' };
    }
    remember(pubkey, { url: URL.createObjectURL(stored), source: 'own' });
    // Saved locally first, exactly as always. A guardian's dependant card then
    // also sends it to the child; a failed send never undoes the local pick.
    if (!link) return { ok: true };
    return { ok: true, send: await link.send(stored) };
  }, [pubkey, link]);

  const clear = useCallback(async () => {
    if (!pubkey) return;
    await deleteCardBackdrop(pubkey);
    // Re-resolve rather than blank: on a child's phone the guardian's picture
    // takes over again once the child's own is gone.
    await refreshCardBackdrop(pubkey);
    if (link) await link.remove();
  }, [pubkey, link]);

  return { url: entry.url, source: entry.source, link, set, clear };
}
