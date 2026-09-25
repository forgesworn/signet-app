// Companion data rail — Signet's encryption adapter around Kindred's pure
// producer/consumer wire contract. Parsing, constants and ack bytes are
// canonical in @forgesworn/kenspeckle/companion-rail; this app owns the unlocked
// signing backend used to encrypt the ack.

import {
  ACK_KIND,
  SNAPSHOT_D_TAG,
  buildPairingAck,
  parsePairingAck,
  parsePairingRequest,
} from '@forgesworn/kenspeckle/companion-rail'
import type {
  PairingAck,
  PairingRequest,
  PairingRequestResult,
} from '@forgesworn/kenspeckle/companion-rail'
import type { DecryptingSigningBackend } from './signing-backend'

export { ACK_KIND, parsePairingAck, parsePairingRequest }
export const ACK_D_TAG = SNAPSHOT_D_TAG
export type { PairingAck, PairingRequest, PairingRequestResult }

export async function buildPairingAckContent(
  ack: PairingAck,
  ephemeralBackend: DecryptingSigningBackend,
  appPubkey: string,
): Promise<string> {
  return ephemeralBackend.nip44Encrypt(appPubkey, buildPairingAck(ack))
}
