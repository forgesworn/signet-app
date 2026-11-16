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
import type { DependantChildDevice, PairedChildRecord } from '../types';
import { extractEndpointPubkey } from './dependant-status-sync';
import { isValidRelayUrl } from './relay-url';

const STRICT_HEX64 = /^[0-9a-f]{64}$/;

/** Null when the record names no usable key; a direct record never falls back to `bunkerUri`. */
export function guardianRailPubkey(record: Pick<PairedChildRecord, 'mode' | 'railPubkey' | 'bunkerUri'>): string | null {
  if (record.mode === 'heartwood-direct') {
    const rail = record.railPubkey ?? '';
    return STRICT_HEX64.test(rail) ? rail : null;
  }
  return extractEndpointPubkey(record.bunkerUri);
}

/**
 * Guardian side, A56: the relay a direct child reads every guardian → child
 * rail on — the pairing's rail relay, which the child set as its own relay
 * at pairing. Null for a legacy dependant, and for an older direct record
 * without one (that child reads the guardian's relay, already in each
 * publisher's list).
 */
export function childRailRelay(dep: { childDevice?: Pick<DependantChildDevice, 'mode' | 'railRelay'> }): string | null {
  const relay = dep.childDevice?.mode === 'heartwood-direct' ? dep.childDevice.railRelay : undefined;
  return relay && isValidRelayUrl(relay) ? relay : null;
}

/**
 * The relays a guardian → child publication for `dep` goes to: `base` — what
 * the publisher used before, unchanged for a legacy dependant — plus a direct
 * child's rail relay, so a guardian who later changes relay still reaches it.
 */
export function guardianToChildRelays(dep: { childDevice?: Pick<DependantChildDevice, 'mode' | 'railRelay'> }, base: readonly string[]): string[] {
  return withChildRailRelay(base, childRailRelay(dep));
}

/** `base` plus a rail relay already resolved by `childRailRelay` (null = `base`). */
export function withChildRailRelay(base: readonly string[], rail: string | null | undefined): string[] {
  return rail && !base.includes(rail) ? [...base, rail] : [...base];
}

/**
 * Publishers that hold one connection per relay (contact policy, contact
 * directory): the relays beyond `base` — every direct child's distinct rail
 * relay.
 */
export function childRailExtraRelays(deps: ReadonlyArray<{ childDevice?: Pick<DependantChildDevice, 'mode' | 'railRelay'> }>, base: string): string[] {
  return [...new Set(deps.map(childRailRelay).filter((r): r is string => !!r && r !== base))].sort();
}

/** Whether `dep`'s guardian → child publication belongs on `relay`: every
 *  dependant's goes to `base` (as before); only a direct child's to its rail relay. */
export function publishesToChildOn(dep: { childDevice?: Pick<DependantChildDevice, 'mode' | 'railRelay'> }, relay: string, base: string): boolean {
  return relay === base || guardianToChildRelays(dep, [base]).includes(relay);
}
