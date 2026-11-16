/**
 * The child-direct ready check (pure). The Heartwood records identity consent
 * per (client key, identity), and a freshly minted child slot holds none, not
 * even for the persona it is bound to. Each such identity asks for one press
 * the first time it is used. The ready check collects every one of those
 * presses during setup, and says plainly, on both phones, when one is still
 * owed.
 *
 * The rule: never say Ready unless the Heartwood has confirmed it; never ask
 * for a press that cannot be shown to be owed; "unknown" is its own state.
 *
 *   guardian phone  reads `list_clients`. Per identity: `ready` when the device
 *                   lists it under `client_approvals` for that client key,
 *                   `waiting` (owed) when the device reports approvals and it
 *                   is absent, `full` when it is absent and the slot already
 *                   holds as many grants as the firmware can remember,
 *                   `unknown` when the device did not report approvals, the
 *                   reply failed the strict parse, or the read failed.
 *   child phone     cannot read the device. The guardian's reading reaches it
 *                   in the rules payload (`approved`) and wins over the
 *                   child's own saved answers; without one, the child falls
 *                   back to its own probe answers.
 */
import { npubEncode } from 'nostr-tools/nip19';
import type { DependantIdentity } from '../types';
import type { ClientApproval, DeviceClientSlot } from './heartwood-mgmt-types';
import { isSameSlot, replyPersonas } from './child-device-pairing';
import { findOwnSlot } from './heartwood-owner-ops';

/**
 * Per row: `ready` (confirmed by the device), `waiting` / `skipped` (owed),
 * `unknown` (this phone cannot tell), `full` (the device cannot remember it:
 * it asks for a press every time).
 */
export type ReadyState = 'ready' | 'waiting' | 'skipped' | 'unknown' | 'full';

export interface ReadyRow {
  pubkey: string;
  name: string;
  who: 'child' | 'guardian';
  state: ReadyState;
  /** The last probe was refused or timed out: offer "Try again". */
  failed?: boolean;
  /** A probe for this identity is waiting on the device right now. */
  probing?: boolean;
}

/** The stored ceremony states on the child's phone (`identityApprovals`). */
export type ChildApproval = 'approved' | 'waiting' | 'failed' | 'deferred';
/** A ceremony state as shown: `full` only ever comes from the guardian's reading. */
export type ChildEffectiveApproval = ChildApproval | 'full';

/** State of the guardian's one natural-person probe. `no-route`: the NP route was not available. */
export type NpProbeState = 'none' | 'probing' | 'ok' | 'failed' | 'no-route';

/** What the guardian's last check found for its own row (persisted on the guardian's phone). */
export type GuardianReadyOutcome = 'owed' | 'confirmed' | 'unknown' | 'no-route' | 'full';

/**
 * Identities one slot can remember: firmware `MAX_EXPLICIT_GRANTS`
 * (heartwood-esp32 common/src/client_grants.rs:33), checked by
 * `can_record_client_identity` (common/src/policy.rs:527-531) against
 * `grant_count()`, which counts the explicit grants of EVERY client key on
 * the slot (common/src/client_grants/snapshot.rs:146-148). Past it the card
 * reads ONCE AS and nothing is recorded.
 */
export const HEARTWOOD_SLOT_IDENTITY_CAP = 16;

/** The most identities the rules payload carries in `approved` (as `personas`). */
export const MAX_APPROVED_ON_WIRE = 32;

export type ReadySummary =
  | { kind: 'empty' }
  | { kind: 'ready' }
  | { kind: 'paused' }
  | { kind: 'owed'; owed: number }
  | { kind: 'full' }
  | { kind: 'unknown' };

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

/**
 * Grants the slot holds, across every client key (the firmware's count). A
 * migrated slot may also list its legacy binding, which is not a grant, so
 * this can over-count by one there: that errs towards "cannot remember"
 * (no press asked), never towards Ready.
 */
export function slotGrantCount(approvals: readonly ClientApproval[]): number {
  return approvals.reduce((n, a) => n + new Set(a.approvedIdentities).size, 0);
}

/** A press owed: waiting or skipped. Unknown and full rows are not owed presses. */
export function owedPresses(rows: readonly ReadyRow[]): number {
  return rows.filter(r => r.state === 'waiting' || r.state === 'skipped').length;
}

/**
 * The one place a notice is chosen. Ready only when every row is confirmed.
 * Otherwise: paused (no nag), then owed presses, then a full slot, then
 * unknown.
 */
export function readySummary(rows: readonly ReadyRow[], opts: { paused?: boolean } = {}): ReadySummary {
  if (rows.length === 0) return { kind: 'empty' };
  if (rows.every(r => r.state === 'ready')) return { kind: 'ready' };
  if (opts.paused) return { kind: 'paused' };
  const owed = owedPresses(rows);
  if (owed > 0) return { kind: 'owed', owed };
  if (rows.some(r => r.state === 'full')) return { kind: 'full' };
  return { kind: 'unknown' };
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

/**
 * Child's phone: one persona's state as shown. With the guardian's reading
 * (`approved`, from the newest rules payload): listed ⇒ approved; absent and
 * the slot full ⇒ full; absent but this phone's own probe succeeded under
 * that same payload ⇒ approved (the press came after the guardian's reading);
 * otherwise owed, overriding a saved "approved". Without a reading: the saved
 * ceremony state, as before.
 */
export function childEffectiveApproval(input: {
  persona: string;
  saved: ChildApproval | undefined;
  approved: readonly string[] | undefined;
  probedUnderCurrent: boolean;
}): ChildEffectiveApproval {
  const saved = input.saved ?? 'waiting';
  if (!input.approved) return saved;
  if (input.approved.includes(input.persona.toLowerCase())) return 'approved';
  if (input.approved.length >= HEARTWOOD_SLOT_IDENTITY_CAP) return 'full';
  if (input.probedUnderCurrent) return 'approved';
  return saved === 'approved' ? 'waiting' : saved;
}

/** Child's phone: its ceremony states as checklist rows, in the order given. */
export function childReadyRows(
  personas: readonly { pubkey: string; name: string; approval: ChildEffectiveApproval }[],
  probing: ReadonlySet<string> = new Set(),
): ReadyRow[] {
  return personas.map(({ pubkey, name, approval }) => {
    const base = { pubkey, name, who: 'child' as const };
    if (approval === 'approved') return { ...base, state: 'ready' as const };
    if (approval === 'deferred') return { ...base, state: 'skipped' as const };
    if (approval === 'full') return { ...base, state: 'full' as const };
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

/** A usable `list_clients` reading: a non-empty list (an empty one says nothing). */
function usable(slots: readonly DeviceClientSlot[] | null | undefined): readonly DeviceClientSlot[] | null {
  return slots && slots.length > 0 ? slots : null;
}

/** The child's slot in a reading: same index and fingerprint, still holding the child's key. */
export function findChildSlot(dep: DependantIdentity, slots: readonly DeviceClientSlot[]): DeviceClientSlot | null {
  const cd = dep.childDevice;
  if (cd?.mode !== 'heartwood-direct') return null;
  const client = cd.clientPubkey.toLowerCase();
  return slots.find(s => isSameSlot(s, cd)
    && ((s.currentPubkey ?? '').toLowerCase() === client || s.authorizedPubkeys.some(k => k.toLowerCase() === client))) ?? null;
}

/**
 * Guardian's phone: rows for the child's personas (from the child's slot) and
 * for the guardian's own natural person (from the guardian's slot).
 *
 * `slots` is the latest good `list_clients` reading, or null when there is
 * none (not read yet, the read failed, an empty list): every row is then
 * unknown, except the guardian's own row when its last saved outcome was
 * owed, which stays owed (an owed press survives a restart).
 *
 * Returns null only when a good reading shows the child's phone is not on
 * the device (unpaired, or re-paired elsewhere): nothing to be ready.
 */
export function guardianReadyRows(input: {
  dependant: DependantIdentity;
  slots: readonly DeviceClientSlot[] | null;
  guardianClientPubkey: string | null;
  guardianNpPubkey: string;
  npProbe: NpProbeState;
  guardianRowName: string;
  savedGuardian?: GuardianReadyOutcome;
}): ReadyRow[] | null {
  const cd = input.dependant.childDevice;
  if (cd?.mode !== 'heartwood-direct') return null;
  const client = cd.clientPubkey.toLowerCase();
  const reading = usable(input.slots);
  const childSlot = reading ? findChildSlot(input.dependant, reading) : null;
  if (reading && !childSlot) return null;

  const rows: ReadyRow[] = expectedChildPersonas(input.dependant).map(({ pubkey, name }) => {
    const base = { pubkey, name, who: 'child' as const };
    if (!childSlot) return { ...base, state: 'unknown' as const };
    const ok = identityApproved(childSlot.clientApprovals, client, pubkey);
    if (ok === null) return { ...base, state: 'unknown' as const };
    if (ok) return { ...base, state: 'ready' as const };
    return { ...base, state: slotGrantCount(childSlot.clientApprovals!) >= HEARTWOOD_SLOT_IDENTITY_CAP ? 'full' as const : 'waiting' as const };
  });

  const np = input.guardianNpPubkey.toLowerCase();
  if (HEX64.test(np)) {
    const probe = input.npProbe;
    const base = { pubkey: np, name: input.guardianRowName, who: 'guardian' as const };
    const flags = {
      ...(probe === 'probing' ? { probing: true } : {}),
      ...(probe === 'failed' || probe === 'no-route' ? { failed: true } : {}),
    };
    if (reading) {
      const me = (input.guardianClientPubkey ?? '').toLowerCase();
      const own = HEX64.test(me) ? findOwnSlot([...reading], me) : null;
      const listed = own ? identityApproved(own.clientApprovals, me, np) : null;
      if (listed === true) rows.push({ ...base, state: 'ready' });
      else if (listed === false && slotGrantCount(own!.clientApprovals!) >= HEARTWOOD_SLOT_IDENTITY_CAP) rows.push({ ...base, state: 'full' });
      else if (listed === false) rows.push({ ...base, state: 'waiting', ...flags });
      else if (probe === 'probing') rows.push({ ...base, state: 'unknown', probing: true });
      else rows.push({ ...base, state: 'unknown' });
    } else if (probe === 'probing') {
      rows.push({ ...base, state: 'waiting', probing: true });
    } else if (input.savedGuardian === 'owed' || input.savedGuardian === 'no-route') {
      rows.push({ ...base, state: 'waiting', ...flags, ...(input.savedGuardian === 'no-route' ? { failed: true } : {}) });
    } else {
      rows.push({ ...base, state: 'unknown' });
    }
  }
  return rows;
}

/** The guardian row's state as the outcome this phone saves. */
export function guardianOutcomeOf(rows: readonly ReadyRow[] | null, npProbe: NpProbeState): GuardianReadyOutcome | null {
  const row = rows?.find(r => r.who === 'guardian');
  if (!row) return null;
  if (row.state === 'ready') return 'confirmed';
  if (row.state === 'full') return 'full';
  if (row.state === 'unknown') return 'unknown';
  return npProbe === 'no-route' ? 'no-route' : 'owed';
}

/**
 * The guardian's reading for the child (`approved` on the rules payload): the
 * identities the device has recorded for the child's client key, lowercase,
 * sorted, deduplicated, at most `MAX_APPROVED_ON_WIRE`. A persona covered by a
 * legacy 8-byte tag is listed by its full key. Undefined when there is no
 * reading, the child's slot is not in it, or the device did not report
 * approvals: the field is then left off and the child uses its own answers.
 */
export function approvedForChild(dep: DependantIdentity, slots: readonly DeviceClientSlot[] | null): string[] | undefined {
  const reading = usable(slots);
  const cd = dep.childDevice;
  if (!reading || cd?.mode !== 'heartwood-direct') return undefined;
  const childSlot = findChildSlot(dep, reading);
  if (!childSlot?.clientApprovals) return undefined;
  const client = cd.clientPubkey.toLowerCase();
  const out = new Set<string>();
  const entry = childSlot.clientApprovals.find(a => a.clientPubkey === client);
  for (const id of entry?.approvedIdentities ?? []) if (HEX64.test(id)) out.add(id);
  for (const { pubkey } of expectedChildPersonas(dep)) {
    if (identityApproved(childSlot.clientApprovals, client, pubkey)) out.add(pubkey);
  }
  return [...out].sort().slice(0, MAX_APPROVED_ON_WIRE);
}
