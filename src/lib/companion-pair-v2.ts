/**
 * Contacts v2 pairing — Signet's encryption adapter around the SDK's pure wire.
 *
 * Parsing, the ack bytes and the routing tags are canonical in
 * @forgesworn/signet-contacts; this module owns only what needs a key: the
 * ephemeral backend that encrypts the ack, and the fresh random rail keypair.
 *
 * The rail key is RANDOM, not derived. v1's `deriveRailKeypair(mnemonic, app)`
 * cannot work after a Heartwood migration — there is no local mnemonic — and a
 * derived rail cannot truly be retired, only tombstoned. A random per-grant key
 * is generated once, stored encrypted in the grant record, and simply never
 * used again after revocation.
 */
import {
  buildPairingAckV2, buildPairingUriV2, parsePairingRequestV2, randomHex, PAIRING_FRESHNESS_SECONDS,
} from '@forgesworn/signet-contacts/wire';
import type {
  Capability, PairingAckV2, PairingRequestV2, PairingRequestV2Result,
} from '@forgesworn/signet-contacts/wire';
import type { DecryptingSigningBackend } from './signing-backend';
import { LocalSigningBackend, generateBunkerClientSecret } from './signing-backend';

export type { Capability, PairingAckV2, PairingRequestV2, PairingRequestV2Result };

/** Cheap pre-check used by the QR router so a v1 URI is never handed to the v2
 *  parser and vice versa. Matches `v=2` as a whole query parameter only. */
export function isContactsPairingV2(input: string): boolean {
  const qIndex = input.indexOf('?');
  const query = qIndex >= 0 ? input.slice(qIndex + 1) : input;
  try {
    return new URLSearchParams(query).get('v') === '2';
  } catch {
    return false;
  }
}

export function parseContactsPairingRequestV2(
  input: string, opts?: { nowSec?: number },
): PairingRequestV2Result {
  return parsePairingRequestV2(input, opts);
}

/**
 * Rebuild the scannable `signet-grant://pair?v=2&…` URI from an already-parsed
 * request, so a paired-child phone can show it to the guardian's scanner.
 * The directory is forced to 'dependant' (see below), so the round trip is
 * exact for every field except that one. The
 * scanner re-parses it with `parseContactsPairingRequestV2`, so the result is
 * the same request provided the original was still fresh. `null` if the SDK
 * refuses to build it (it validates every field), never a throw.
 */
export function pairingUriForRequestV2(request: PairingRequestV2): string | null {
  try {
    return buildPairingUriV2({
      appPubkey: request.appPubkey,
      appName: request.appName,
      capabilities: request.capabilities,
      // Always 'dependant': on the child's phone "my contacts" means the
      // child's, but the guardian's approve screen reads 'owner' as the
      // GUARDIAN's own directory and would pre-select it — handing the
      // child's app the guardian's whole list on one tap.
      directory: 'dependant',
      relay: request.rendezvousRelay,
      nowSec: request.t,
      challenge: request.challenge,
    });
  } catch {
    return null;
  }
}

/** Unix seconds at which a v2 pairing request stops being accepted by a scanner. */
export function pairingRequestExpiresAtSec(request: PairingRequestV2): number {
  return request.t + PAIRING_FRESHNESS_SECONDS;
}

export async function buildPairingAckV2Content(
  ack: PairingAckV2,
  ephemeralBackend: DecryptingSigningBackend,
  appPubkey: string,
): Promise<string> {
  return ephemeralBackend.nip44Encrypt(appPubkey, buildPairingAckV2(ack));
}

/** 32 hex — 128 bits of grant identity. Never derived from anything. */
export function newGrantId(): string {
  return randomHex(16);
}

/** A fresh random rail keypair. The private key goes straight into the
 *  encrypted grant body; the transient backend is destroyed here so the only
 *  copy that survives this call is the returned hex string. */
export function newRailKeypair(): { publicKey: string; privateKey: string } {
  const privateKey = generateBunkerClientSecret();
  const backend = new LocalSigningBackend(privateKey);
  const publicKey = backend.activePublicKeyHex;
  backend.destroy();
  return { publicKey, privateKey };
}
