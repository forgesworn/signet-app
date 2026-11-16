/**
 * The guardian-side key a paired child reads its guardian → child rails from
 * (persona inventory, dependant status, contact policy, contact directory,
 * contact requests and replies). The guardian authors those rails, and is the
 * NIP-44 peer, with the dependant's `bunkerEndpoint` key.
 *
 * - Legacy phone-served pairing: that key is the remote signer named in the
 *   stored `bunker://<endpoint>?…` URI.
 * - Child-direct Heartwood pairing: `bunkerEndpoint` is the RAIL key, stored
 *   on the record as `railPubkey`. The record's `bunkerUri` there names the
 *   bound persona (the Heartwood slot's identity), which authors none of these
 *   rails, so it is never read for a direct record.
 */
import type { PairedChildRecord } from '../types';
import { extractEndpointPubkey } from './dependant-status-sync';

const STRICT_HEX64 = /^[0-9a-f]{64}$/;

/** Null when the record names no usable key; a direct record never falls back to `bunkerUri`. */
export function guardianRailPubkey(record: Pick<PairedChildRecord, 'mode' | 'railPubkey' | 'bunkerUri'>): string | null {
  if (record.mode === 'heartwood-direct') {
    const rail = record.railPubkey ?? '';
    return STRICT_HEX64.test(rail) ? rail : null;
  }
  return extractEndpointPubkey(record.bunkerUri);
}
