/**
 * The child-direct ready check (pure). The Heartwood records identity consent
 * per (client key, identity), and a freshly minted child slot holds none, not
 * even for the persona it is bound to. Each such identity asks for one press
 * the first time it is used. The ready check collects every one of those
 * presses during setup, and says plainly, on both phones, when one is still
 * owed.
 *
 *   child phone     one self-probe per persona it may use (bound persona
 *                   first). "Ready" there means the probe came back: the
 *                   child's phone cannot read the device's records.
 *   guardian phone  one self-probe as its own natural person (the C5 audit and
 *                   escalation inbox decrypt as it), then `list_clients`:
 *                   an identity is ready only when the device lists it under
 *                   `client_approvals` for that client key. A probe answer is
 *                   the fallback only when the device does not report them.
 */
import { npubEncode } from 'nostr-tools/nip19';
import type { DependantIdentity } from '../types';
import type { ClientApproval, DeviceClientSlot } from './heartwood-mgmt-types';
import { isSameSlot, replyPersonas } from './child-device-pairing';
import { findOwnSlot } from './heartwood-owner-ops';

export type ReadyState = 'ready' | 'waiting' | 'skipped';

export interface ReadyRow {
  pubkey: string;
  name: string;
  who: 'child' | 'guardian';
  state: ReadyState;
  /**
   * True only when the device itself listed the result. False when it rests
   * on a probe answer, or when the device did not report approvals. Kept in
   * state, never shown.
   */
  verified: boolean;
  /** The last probe was refused or timed out: offer "Try again". */
  failed?: boolean;
  /** A probe for this identity is waiting on the device right now. */
  probing?: boolean;
}

/** The stored ceremony states on the child's phone (`identityApprovals`). */
export type ChildApproval = 'approved' | 'waiting' | 'failed' | 'deferred';

/** State of the guardian's one natural-person probe. `no-route`: the NP route was not available. */
export type NpProbeState = 'none' | 'probing' | 'ok' | 'failed' | 'no-route';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Whether the device lists `identity` for `client` (an explicit grant, or a
 * migrated client's surviving 8-byte legacy tag). `null` = not reported.
 */
export function identityApproved(approvals: readonly ClientApproval[] | undefined, client: string, identity: string): boolean | null {
  if (!approvals) return null;
  const c = client.toLowerCase();
  const id = identity.toLowerCase();
  const entry = approvals.find(a => a.clientPubkey === c);
  if (!entry) return false;
  return entry.approvedIdentities.includes(id) || entry.legacyIdentityTags.includes(id.slice(0, 16));
}

/** A press still owed: anything not ready (waiting or skipped). */
export function owedPresses(rows: readonly ReadyRow[]): number {
  return rows.filter(r => r.state !== 'ready').length;
}

/** The identity line a Heartwood card shows: `npub1` + 8 characters + `..`. */
export function deviceShortNpub(pubkey: string): string {
  try {
    return `${npubEncode(pubkey.toLowerCase()).slice(0, 13)}..`;
  } catch {
    return '';
  }
}

/** The device withdrew a waiting card because a slot's authority changed; the request may be sent again. */
export function isApprovalChanged(err: unknown): boolean {
  const m = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  return /^approval[_ ]changed/i.test(m.trim());
}

/** Child's phone: its ceremony states as checklist rows, in the order given. */
export function childReadyRows(
  personas: readonly { pubkey: string; name: string; approval: ChildApproval }[],
  probing: ReadonlySet<string> = new Set(),
): ReadyRow[] {
  return personas.map(({ pubkey, name, approval }) => {
    const base = { pubkey, name, who: 'child' as const, verified: false };
    if (approval === 'approved') return { ...base, state: 'ready' as const };
    if (approval === 'deferred') return { ...base, state: 'skipped' as const };
    if (approval === 'failed' && !probing.has(pubkey)) return { ...base, state: 'waiting' as const, failed: true };
    return { ...base, state: 'waiting' as const, ...(probing.has(pubkey) ? { probing: true } : {}) };
  });
}

/** The personas the child's phone may use, bound persona first. */
export function expectedChildPersonas(dep: DependantIdentity): { pubkey: string; name: string }[] {
  const bound = (dep.childDevice?.boundPersona ?? '').toLowerCase();
  const list = replyPersonas(dep).map(p => ({ pubkey: p.pubkey.toLowerCase(), name: p.name }));
  const first = list.filter(p => p.pubkey === bound);
  if (first.length === 0 && HEX64.test(bound)) first.push({ pubkey: bound, name: dep.persona?.displayName || dep.displayName });
  return [...first, ...list.filter(p => p.pubkey !== bound)];
}

/**
 * Guardian's phone: rows for the child's personas (from the child's slot) and
 * for the guardian's own natural person (from the guardian's slot). `null`
 * when the child's phone is not on the device (not paired, or the slot is
 * gone): there is nothing to be ready.
 *
 * Child rows the device does not report on count as ready but unverified:
 * the guardian has no probe answer for them and no way to get one.
 */
export function guardianReadyRows(input: {
  dependant: DependantIdentity;
  slots: readonly DeviceClientSlot[];
  guardianClientPubkey: string | null;
  guardianNpPubkey: string;
  npProbe: NpProbeState;
  guardianRowName: string;
}): ReadyRow[] | null {
  const cd = input.dependant.childDevice;
  if (cd?.mode !== 'heartwood-direct') return null;
  const client = cd.clientPubkey.toLowerCase();
  const childSlot = input.slots.find(s => isSameSlot(s, cd)
    && ((s.currentPubkey ?? '').toLowerCase() === client || s.authorizedPubkeys.some(k => k.toLowerCase() === client)));
  if (!childSlot) return null;

  const rows: ReadyRow[] = expectedChildPersonas(input.dependant).map(({ pubkey, name }) => {
    const ok = identityApproved(childSlot.clientApprovals, client, pubkey);
    return ok === false
      ? { pubkey, name, who: 'child' as const, state: 'waiting' as const, verified: true }
      : { pubkey, name, who: 'child' as const, state: 'ready' as const, verified: ok === true };
  });

  const np = input.guardianNpPubkey.toLowerCase();
  if (HEX64.test(np)) {
    const me = (input.guardianClientPubkey ?? '').toLowerCase();
    const own = HEX64.test(me) ? findOwnSlot(input.slots, me) : null;
    const listed = own ? identityApproved(own.clientApprovals, me, np) : null;
    const probe = input.npProbe;
    const base = { pubkey: np, name: input.guardianRowName, who: 'guardian' as const };
    const flags = {
      ...(probe === 'probing' ? { probing: true } : {}),
      ...(probe === 'failed' || probe === 'no-route' ? { failed: true } : {}),
    };
    if (listed === true) rows.push({ ...base, state: 'ready', verified: true });
    else if (listed === false) rows.push({ ...base, state: 'waiting', verified: true, ...flags });
    // Not reported: fall back to the probe answer, and only "ok" counts.
    else if (probe === 'ok') rows.push({ ...base, state: 'ready', verified: false });
    else rows.push({ ...base, state: 'waiting', verified: false, ...flags });
  }
  return rows;
}
