/**
 * Audit log consumer.
 *
 * Reads kind-31000 NIP-17-gift-wrapped audit rumors written by `audit.ts`
 * and turns them into UI-friendly entries. Pure helpers here; the
 * IO orchestration lives in `hooks/useAuditLog.ts`.
 *
 * Privacy posture: the publisher (`audit.ts`) emits metadata-only rumors
 * (kind 31000, content `''`, tags = `t,d,k,outcome,p?,origin?`). This
 * consumer treats anything else with the same `t:audit` marker as
 * defensive-skip.
 *
 * Two consumer paths:
 *   - **Guardian** (v1). Each wrap is gift-wrapped to
 *     `guardianPubkey`; decrypt uses the guardian's NIP-44 backend
 *     (`unwrapAuditEvent` with a `DecryptingSigningBackend`).
 *   - **Paired-child** (v2). When audit
 *     visibility resolves to true for the dep (see
 *     `audit-visibility.ts`), the publisher emits a SECOND wrap
 *     addressed to the dep's NIP-46 client pubkey. The child's
 *     paired-child device holds the matching private key and
 *     decrypts via `unwrapAuditEventWithKey`, which doesn't need
 *     a backend object — just the raw recipient privkey.
 */

import type { NostrEvent } from 'signet-protocol';
import { verifyEvent } from 'nostr-tools/pure';
import type { DecryptingSigningBackend } from './signing-backend';
import { AUDIT_EVENT_KIND, type AuditOutcome } from './audit';
import { nip44Decrypt } from './nip46';

/** Inner kind-31000 rumor as it sits inside a NIP-17 seal. */
export interface AuditRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * Parsed, UI-ready audit row. One row per signing decision the guardian
 * has logged. `eventKind` is absent for lifecycle outcomes
 * (`ceremony-complete`) since no event was being signed.
 */
export interface AuditEntry {
  /** Stable identifier — uses the `d` tag verbatim (`<dependantPubkey>:<ms>`). */
  id: string;
  /** Hex pubkey of the dependant whose activity this row records. */
  dependantPubkey: string;
  /** Wall-clock seconds the audit rumor was created at. */
  createdAt: number;
  /** Outcome reported by the guardian phone. */
  outcome: AuditOutcome;
  /** Nostr event kind being signed; absent for lifecycle outcomes. */
  eventKind?: number;
  /** Counterparty pubkey when the scope had one (`p` tag). */
  counterpartyPubkey?: string;
  /** Origin / domain when the scope had one (`origin` tag). */
  origin?: string;
}

/**
 * Parameterises which inner-rumor shape an unwrap call accepts — the ONLY
 * two points where `unwrapAuditEvent` / a future escalation-notice unwrap
 * diverge. `requiredTag` accepts ANY of the listed values for that tag key
 * (e.g. `['t', ['approval', 'petition']]` for escalation notices that use
 * either marker).
 */
export interface UnwrapSpec {
  /** Rumor kind the unwrap accepts (31000 audit, 31001 escalation). */
  rumorKind: number;
  /** Tag key/values accepted for the required marker tag, e.g. ['t', ['audit']] or ['t', ['approval','petition']]. */
  requiredTag: [string, string[]];
}

/**
 * Best-effort wrap → seal → rumor decrypt. Returns null on any of:
 * - the wrap isn't kind 1059
 * - either NIP-44 decrypt step throws (likely an unrelated gift-wrap)
 * - the seal isn't signed by `expectedSignerPubkey` (see `verifySeal`)
 * - the rumor's own `pubkey` doesn't match `expectedSignerPubkey`
 * - the inner rumor doesn't match `spec.rumorKind` / lacks a tag value
 *   from `spec.requiredTag`
 *
 * `expectedSignerPubkey` is the guardian's real signing pubkey — the
 * ONLY identity that legitimately publishes these rumors (see
 * `audit.ts` `buildAuditEventTemplate`). Without this check, anyone
 * could self-sign a seal wrapping a forged rumor and it would render
 * as genuine child activity — the seal's own internal signature only
 * proves self-consistency, not that the claimed signer is the
 * guardian. See 2026-07-02 audit finding C1.
 *
 * The guardian's relay subscription pulls every gift-wrap addressed to
 * them — including legitimate non-audit traffic (DMs, attestations).
 * Returning null on a mismatch lets the caller silently skip those.
 */
export async function unwrapWrappedRumor(
  wrap: NostrEvent,
  guardianBackend: DecryptingSigningBackend,
  expectedSignerPubkey: string,
  spec: UnwrapSpec,
): Promise<AuditRumor | null> {
  if (!wrap || wrap.kind !== 1059) return null;
  if (typeof wrap.pubkey !== 'string' || typeof wrap.content !== 'string') return null;
  if (!HEX64.test(expectedSignerPubkey)) return null;
  const expected = expectedSignerPubkey.toLowerCase();

  let sealJson: string;
  try {
    sealJson = await guardianBackend.nip44Decrypt(wrap.pubkey, wrap.content);
  } catch {
    return null;
  }

  let seal: unknown;
  try {
    seal = JSON.parse(sealJson);
  } catch {
    return null;
  }
  if (!isSeal(seal)) return null;
  // Audit pass 4: verify the seal carries a valid BIP-340 signature
  // from the claimed `pubkey` before trusting any of its fields.
  // C1 fix: also require the claimed pubkey to be the trusted guardian.
  if (!verifySeal(seal, expected)) return null;

  let rumorJson: string;
  try {
    rumorJson = await guardianBackend.nip44Decrypt(seal.pubkey, seal.content);
  } catch {
    return null;
  }

  let rumor: unknown;
  try {
    rumor = JSON.parse(rumorJson);
  } catch {
    return null;
  }
  if (!isRumor(rumor)) return null;
  // The rumor is authored by the guardian too (buildAuditEventTemplate
  // sets `pubkey: guardianPubkey`) — reject a mismatch even though the
  // seal already passed, in case a compromised seal carried a rumor
  // ciphertext for someone else's ID.
  if (rumor.pubkey.toLowerCase() !== expected) return null;

  // Discriminate by both kind and the required marker tag — a stray rumor
  // without the marker isn't ours and shouldn't appear in the log.
  if (rumor.kind !== spec.rumorKind) return null;
  const [tagKey, tagValues] = spec.requiredTag;
  if (!rumor.tags.some((t) => t[0] === tagKey && tagValues.includes(t[1]))) return null;

  return rumor;
}

/**
 * Decrypt-with-key counterpart of `unwrapWrappedRumor`. Same wrap → seal
 * → rumor flow, but parameterised on a raw recipient private key
 * instead of a `DecryptingSigningBackend`. Used by the paired-child
 * audit surface (v2) — the dep's device holds
 * its NIP-46 client privkey directly (it was generated at pair-scan
 * time and stored encrypted-at-rest in `PairedChildRecord`), and
 * spinning up a `LocalSigningBackend` just to call `nip44Decrypt`
 * twice would be more ceremony than the call deserves.
 *
 * `expectedSignerPubkey` is the guardian's real signing pubkey (both
 * audit gift-wraps — guardian-addressed and child-addressed — are
 * sealed with the same guardian key; see `audit.ts`
 * `publishAuditEvent`). See the C1 note on `unwrapWrappedRumor`.
 *
 * Returns null on any of the same conditions as `unwrapWrappedRumor`
 * — wrong kind, decrypt failure, wrong signer, missing required tag.
 */
export async function unwrapWrappedRumorWithKey(
  wrap: NostrEvent,
  recipientPrivkeyHex: string,
  expectedSignerPubkey: string,
  spec: UnwrapSpec,
): Promise<AuditRumor | null> {
  if (!wrap || wrap.kind !== 1059) return null;
  if (typeof wrap.pubkey !== 'string' || typeof wrap.content !== 'string') return null;
  if (!HEX64.test(expectedSignerPubkey)) return null;
  const expected = expectedSignerPubkey.toLowerCase();

  let sealJson: string;
  try {
    sealJson = await nip44Decrypt(recipientPrivkeyHex, wrap.pubkey, wrap.content);
  } catch {
    return null;
  }

  let seal: unknown;
  try {
    seal = JSON.parse(sealJson);
  } catch {
    return null;
  }
  if (!isSeal(seal)) return null;
  // Audit pass 4: verify the seal carries a valid BIP-340 signature
  // from the claimed `pubkey` before trusting any of its fields.
  // C1 fix: also require the claimed pubkey to be the trusted guardian.
  if (!verifySeal(seal, expected)) return null;

  let rumorJson: string;
  try {
    rumorJson = await nip44Decrypt(recipientPrivkeyHex, seal.pubkey, seal.content);
  } catch {
    return null;
  }

  let rumor: unknown;
  try {
    rumor = JSON.parse(rumorJson);
  } catch {
    return null;
  }
  if (!isRumor(rumor)) return null;
  if (rumor.pubkey.toLowerCase() !== expected) return null;

  if (rumor.kind !== spec.rumorKind) return null;
  const [tagKey, tagValues] = spec.requiredTag;
  if (!rumor.tags.some((t) => t[0] === tagKey && tagValues.includes(t[1]))) return null;

  return rumor;
}

const AUDIT_UNWRAP_SPEC: UnwrapSpec = { rumorKind: AUDIT_EVENT_KIND, requiredTag: ['t', ['audit']] };

/** Audit-specific delegate — see `unwrapWrappedRumor` for the gate sequence. */
export async function unwrapAuditEvent(
  wrap: NostrEvent,
  guardianBackend: DecryptingSigningBackend,
  expectedSignerPubkey: string,
): Promise<AuditRumor | null> {
  return unwrapWrappedRumor(wrap, guardianBackend, expectedSignerPubkey, AUDIT_UNWRAP_SPEC);
}

/** Audit-specific delegate — see `unwrapWrappedRumorWithKey` for the gate sequence. */
export async function unwrapAuditEventWithKey(
  wrap: NostrEvent,
  recipientPrivkeyHex: string,
  expectedSignerPubkey: string,
): Promise<AuditRumor | null> {
  return unwrapWrappedRumorWithKey(wrap, recipientPrivkeyHex, expectedSignerPubkey, AUDIT_UNWRAP_SPEC);
}

/**
 * Turn a validated rumor into an `AuditEntry`. Returns null if any
 * required tag is missing or malformed. Mirrors the publisher contract
 * in `audit.ts` — keep the two in lockstep when fields evolve.
 */
export function parseAuditRumor(rumor: AuditRumor): AuditEntry | null {
  if (!rumor || rumor.kind !== AUDIT_EVENT_KIND) return null;

  const tagMap = indexTags(rumor.tags);

  // `t:audit` marker is required — defends against unrelated rumors that
  // happen to share the kind range.
  if (tagMap.t !== 'audit') return null;

  // `d` tag carries `<dependantPubkey>:<ms>`; we use it both as the row
  // id and as the source of `dependantPubkey`.
  const d = tagMap.d;
  if (!d || typeof d !== 'string') return null;
  const colonIx = d.indexOf(':');
  if (colonIx <= 0) return null;
  const dependantPubkey = d.slice(0, colonIx).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dependantPubkey)) return null;

  const outcome = tagMap.outcome;
  if (!isAuditOutcome(outcome)) return null;

  const entry: AuditEntry = {
    id: d,
    dependantPubkey,
    createdAt: rumor.created_at,
    outcome,
  };

  if (typeof tagMap.k === 'string') {
    const kind = Number.parseInt(tagMap.k, 10);
    if (Number.isFinite(kind) && kind >= 0) entry.eventKind = kind;
  }
  if (typeof tagMap.p === 'string' && /^[0-9a-f]{64}$/i.test(tagMap.p)) {
    entry.counterpartyPubkey = tagMap.p.toLowerCase();
  }
  if (typeof tagMap.origin === 'string' && tagMap.origin.length > 0) {
    entry.origin = tagMap.origin;
  }

  return entry;
}

/**
 * One-line human summary for a row. Deliberately avoids exposing
 * counterparty pubkeys verbatim ("to someone" rather than the hex), and
 * avoids enumerating event content (we never had it). Origin is shown
 * only when present — sign-in shows the domain, DMs do not.
 */
export function summariseAudit(entry: AuditEntry, dependantName?: string): string {
  const _name = dependantName; // accepted for API symmetry with the page header
  void _name;

  const baseLabel = baseLabelFor(entry);
  const outcomeSuffix = outcomeSuffixFor(entry.outcome);
  return outcomeSuffix ? `${baseLabel} ${outcomeSuffix}` : baseLabel;
}

/** Returns `[{ dayLabel, entries }]` newest-day first, newest-row first within each day. */
export function groupAuditByDay(
  entries: AuditEntry[],
  now: Date,
): Array<{ dayLabel: string; entries: AuditEntry[] }> {
  if (entries.length === 0) return [];

  const todayKey = dayKey(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = dayKey(yesterday);

  // Group by local-day key, descending recency-preserving.
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);

  const groups: Array<{ dayLabel: string; entries: AuditEntry[] }> = [];
  const indexByLabel = new Map<string, number>();

  for (const e of sorted) {
    const d = new Date(e.createdAt * 1000);
    const k = dayKey(d);
    let label: string;
    if (k === todayKey) label = 'Today';
    else if (k === yesterdayKey) label = 'Yesterday';
    else label = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

    let ix = indexByLabel.get(label);
    if (ix === undefined) {
      ix = groups.length;
      indexByLabel.set(label, ix);
      groups.push({ dayLabel: label, entries: [] });
    }
    groups[ix].entries.push(e);
  }
  return groups;
}

// ── internals ───────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/i;

interface NostrSeal {
  id: string;
  pubkey: string;
  sig: string;
  content: string;
  kind: number;
  created_at: number;
  tags: string[][];
}

function isSeal(v: unknown): v is NostrSeal {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.pubkey !== 'string') return false;
  if (typeof s.content !== 'string') return false;
  if (typeof s.id !== 'string') return false;
  if (typeof s.sig !== 'string') return false;
  if (typeof s.kind !== 'number') return false;
  if (typeof s.created_at !== 'number') return false;
  if (!Array.isArray(s.tags)) return false;
  return true;
}

/**
 * Verify a parsed NIP-17 seal: must be kind-13, carry a valid BIP-340
 * signature by the claimed pubkey, AND be signed by `expectedSignerPubkey`.
 *
 * The BIP-340 check alone (2026-05-18 audit pass 4) only proves the seal
 * is self-consistent — that `pubkey` really did sign this exact seal. It
 * does NOT prove `pubkey` is the guardian: anyone can generate a
 * throwaway keypair, self-sign a seal wrapping a forged audit rumor, and
 * pass that check. The `expectedSignerPubkey` comparison closes that gap
 * — see 2026-07-02 audit finding C1.
 */
function verifySeal(seal: NostrSeal, expectedSignerPubkey: string): boolean {
  if (seal.kind !== 13) return false;
  if (seal.pubkey.toLowerCase() !== expectedSignerPubkey) return false;
  if (!verifyEvent(seal as unknown as NostrEvent)) return false;
  return true;
}

function isRumor(v: unknown): v is AuditRumor {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.kind !== 'number') return false;
  if (typeof r.created_at !== 'number') return false;
  if (typeof r.pubkey !== 'string') return false;
  if (typeof r.content !== 'string') return false;
  if (!Array.isArray(r.tags)) return false;
  if (typeof r.id !== 'string') return false;
  // tags must be string[][]
  for (const t of r.tags) {
    if (!Array.isArray(t)) return false;
    for (const item of t) if (typeof item !== 'string') return false;
  }
  return true;
}

function isAuditOutcome(v: unknown): v is AuditOutcome {
  return v === 'approved' || v === 'denied' || v === 'auto-approved'
    || v === 'auto-denied' || v === 'ceremony-complete' || v === 'clause-blocked';
}

/**
 * Build a single-key tag map preferring the FIRST occurrence per key.
 * We only ever consume single-valued tags here, so multi-value collisions
 * would be a malformed rumor — first-write-wins keeps the parse stable
 * rather than silently picking the last copy.
 */
function indexTags(tags: string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    if (!Array.isArray(t) || t.length < 2) continue;
    const k = t[0];
    const v = t[1];
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function baseLabelFor(entry: AuditEntry): string {
  if (entry.outcome === 'ceremony-complete') {
    return 'Transition to independent identity completed';
  }

  const kind = entry.eventKind;

  // Sign-in / auth response: prefer the consumer-facing language and
  // include the domain (already truncated upstream by `safeOrigin`).
  if (kind === 22242 || kind === 21236) {
    const target = displayOrigin(entry.origin);
    return target ? `Signed in to ${target}` : 'Signed in';
  }

  // Direct messages — never expose the counterparty pubkey, just say "to
  // someone". We don't have the message content (privacy invariant).
  if (kind === 4 || kind === 14 || kind === 1059) {
    return 'Sent a direct message';
  }

  // Credential issuance / vouches.
  if (kind === 30470) return 'Issued a credential';
  if (kind === 31000) return 'Issued a vouch';

  // Reactions / posts (counterparty present sometimes; still keep generic).
  if (kind === 1) return 'Posted publicly';
  if (kind === 7) return 'Reacted to an event';

  // Venue entry / login proof events.
  if (kind === 21235) return 'Showed a venue-entry pass';

  if (typeof kind === 'number') return `Signed a kind-${kind} event`;
  return 'Signed an event';
}

function outcomeSuffixFor(outcome: AuditOutcome): string {
  switch (outcome) {
    case 'approved': return '';
    case 'auto-approved': return '(auto-approved)';
    case 'denied': return '(denied)';
    case 'auto-denied': return '(auto-denied)';
    case 'clause-blocked': return '(blocked by your Charter)';
    case 'ceremony-complete': return '';
  }
}

function displayOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return u.hostname.slice(0, 64);
  } catch {
    return origin.slice(0, 64);
  }
}

/** Local-time day-key, e.g. "2026-05-04". */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
