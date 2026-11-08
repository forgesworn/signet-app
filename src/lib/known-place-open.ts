import type { KnownPlace } from '../types/known-places';

/**
 * Whether "Open" does anything for a place: an app on this phone (only inside
 * the APK, where the package can be launched) or a site seen in this phone's
 * browser. Everything else (another device, a Nostr Connect or NIP-55 pairing)
 * has nowhere to go. The UI gate and the handler both ask this, so a stale or
 * forged call is a no-op.
 */
export function canOpenPlace(place: KnownPlace, native: boolean): boolean {
  if (place.channel === 'phone-app') return native && !!place.nativePackage;
  if (place.channel === 'browser') return !!place.origin;
  return false;
}
