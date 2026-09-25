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
  buildPairingAckV2, parsePairingRequestV2, randomHex,
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
