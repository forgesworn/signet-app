/**
 * Venue Entry — re-exports builder from signet-protocol.
 * Signing stays in the app (requires SigningBackend).
 */

import { buildVenueEntryEventTemplate, VENUE_ENTRY_KIND } from 'signet-protocol';
import type { NostrEvent } from 'signet-protocol';
import type { SigningBackend } from './signing-backend';

export { VENUE_ENTRY_KIND };

/**
 * Build a signed venue entry QR payload.
 * Always uses the Natural Person keypair.
 *
 * `expectedNpPubkeyHex` is the caller's known Natural Person pubkey (e.g.
 * `identity.naturalPerson.publicKey`). This function asserts `backend`
 * actually signs for that key before use — venue entry must never leak a
 * different persona's identity to a physical-venue scan. Fails closed
 * (throws) on any mismatch rather than silently signing with whatever
 * backend was handed in.
 *
 * When photoKey is provided, appends a ["photo_key", key] tag so the
 * scanning steward can decrypt the encrypted photo blob on Blossom.
 */
export async function buildVenueEntryPayload(
  backend: SigningBackend,
  expectedNpPubkeyHex: string,
  photoHash?: string,
  blossomUrl?: string,
  photoKey?: string,
): Promise<NostrEvent> {
  if (
    !expectedNpPubkeyHex ||
    backend.activePublicKeyHex.toLowerCase() !== expectedNpPubkeyHex.toLowerCase()
  ) {
    throw new Error('Venue entry must be signed by the Natural Person key');
  }
  const unsigned = buildVenueEntryEventTemplate(backend.activePublicKeyHex, photoHash, blossomUrl);
  if (photoKey && photoHash) {
    unsigned.tags.push(['photo_key', photoKey]);
  }
  return backend.signEvent(unsigned);
}
