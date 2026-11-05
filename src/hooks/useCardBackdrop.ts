import { useCallback, useEffect, useState } from 'react';
import { getCardBackdrop, setCardBackdrop, deleteCardBackdrop } from '../lib/db';

/** Largest source file we will try to decode. Anything a phone camera makes fits. */
export const MAX_BACKDROP_SOURCE_BYTES = 40 * 1024 * 1024;
/** Longest edge of the stored backdrop. Enough for a 3x phone card, small to decode on every mount. */
export const BACKDROP_MAX_EDGE_PX = 1280;
const BACKDROP_JPEG_QUALITY = 0.85;
/** Backdrops are stored in clear and painted on the locked card, so say so where one is picked. */
export const BACKDROP_PRIVACY_COPY = 'Only on this device. Not encrypted, and it shows while the app is locked.';

export type BackdropSetResult = { ok: true } | { ok: false; reason: string };

// One object URL per identity for the life of the page. Every card of that
// identity (both carousel screens mid-swipe, the settings row, the edit
// control) reads the same URL, so a freshly mounted card paints its backdrop
// on the first frame instead of after an IndexedDB round trip.
const urls = new Map<string, string | null>();
const loads = new Map<string, Promise<string | null>>();
const listeners = new Set<(pubkey: string) => void>();

function notify(pubkey: string): void {
  for (const listener of listeners) listener(pubkey);
}

function load(pubkey: string): Promise<string | null> {
  const cached = urls.get(pubkey);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = loads.get(pubkey);
  if (running) return running;
  const promise = getCardBackdrop(pubkey)
    .then(blob => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null)
    .then(url => {
      // A write that landed while this read was in flight wins.
      if (!urls.has(pubkey)) urls.set(pubkey, url);
      else if (url) URL.revokeObjectURL(url);
      return urls.get(pubkey) ?? null;
    })
    .finally(() => { loads.delete(pubkey); });
  loads.set(pubkey, promise);
  return promise;
}

function remember(pubkey: string, url: string | null): void {
  const previous = urls.get(pubkey);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  urls.set(pubkey, url);
  notify(pubkey);
}

/** Synchronous read of the cached backdrop URL (null when none, undefined when not loaded yet). */
export function peekCardBackdropUrl(pubkey: string): string | null | undefined {
  return urls.get(pubkey);
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
 * Drop an identity's backdrop for good: delete the stored row and release the
 * cached object URL so every mounted card repaints without it. Best-effort and
 * never throws, so it can sit inside a persona or dependant delete path
 * without being able to block it. A null cache entry means "no backdrop".
 */
export async function forgetCardBackdrop(pubkey: string): Promise<void> {
  try {
    await deleteCardBackdrop(pubkey);
  } catch {
    // Best-effort: an orphan row is harmless and invisible.
  }
  remember(pubkey, null);
}

/** Test seam: forget every cached URL. */
export function resetCardBackdropCacheForTests(): void {
  urls.clear();
  loads.clear();
}

/**
 * Device-local card backdrop for one identity — the card's "wallpaper".
 * Keyed by the identity's pubkey so every persona (and the real identity)
 * can carry its own. Not synced: like a phone wallpaper, it belongs to
 * this install. `url` is null while loading or when none is set.
 */
export function useCardBackdrop(pubkey: string | undefined): {
  url: string | null;
  set: (file: File) => Promise<BackdropSetResult>;
  clear: () => Promise<void>;
} {
  const [url, setUrl] = useState<string | null>(() => (pubkey ? urls.get(pubkey) ?? null : null));

  useEffect(() => {
    if (!pubkey) { setUrl(null); return; }
    let live = true;
    const sync = () => { if (live) setUrl(urls.get(pubkey) ?? null); };
    const listener = (changed: string) => { if (changed === pubkey) sync(); };
    listeners.add(listener);
    sync();
    if (!urls.has(pubkey)) void load(pubkey).then(sync);
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
    remember(pubkey, URL.createObjectURL(stored));
    return { ok: true };
  }, [pubkey]);

  const clear = useCallback(async () => {
    if (!pubkey) return;
    await deleteCardBackdrop(pubkey);
    remember(pubkey, null);
  }, [pubkey]);

  return { url, set, clear };
}
