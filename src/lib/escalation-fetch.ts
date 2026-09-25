/**
 * Escalation-notice consumer (C4).
 *
 * A "notice" here is the kind-31001 NIP-17-gift-wrapped rumor a guardian
 * device publishes when a signing request escalates beyond an automatic
 * grant — either the request is parked pending a same-device approval
 * (`t:approval`), or a paired-child device is petitioning the guardian to
 * make a decision (`t:petition`). Pure helpers only; IO orchestration
 * (the relay subscription, backend wiring) belongs to a future hook —
 * out of scope here.
 *
 * `unwrapEscalationNotice` reuses `unwrapWrappedRumor` from
 * `audit-fetch.ts` with a `UnwrapSpec` scoped to kind 31001 and the
 * `t:approval`/`t:petition` marker — same real-crypto gate sequence
 * (NIP-44 decrypt, BIP-340 seal verification, guardian-authorship check)
 * as the audit log, just addressed at a different rumor shape.
 */

import type { NostrEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';
import { unwrapWrappedRumor, type AuditRumor, type UnwrapSpec } from './audit-fetch';

/** Kind used for the escalation-notice rumor before gift-wrapping. */
export const ESCALATION_EVENT_KIND = 31001;

/**
 * Parsed, UI-ready escalation notice. One row per parked approval or
 * open petition the guardian's device has published.
 */
export interface EscalationNotice {
  /** Verbatim `d` tag — the coalescing key: `<client pubkey>:<method-or-kind key>` */
  id: string;
  kind: 'approval' | 'petition';
  clientPubkey: string;          // `client` tag, lowercased hex64 (required)
  identityPubkey: string;        // `identity` tag, lowercased hex64 (required)
  method: string;                // `method` tag (required, non-empty)
  eventKind?: number;            // `k` tag (sign_event only)
  parkId?: string;               // `park` tag (approval only; 64-hex event id)
  parkTtlSeconds?: number;       // `park-ttl` (approval)
  count?: number;                // `count` (petition)
  createdAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

const ESCALATION_UNWRAP_SPEC: UnwrapSpec = {
  rumorKind: ESCALATION_EVENT_KIND,
  requiredTag: ['t', ['approval', 'petition']],
};

/** Escalation-specific delegate — see `unwrapWrappedRumor` for the gate sequence. */
export async function unwrapEscalationNotice(
  wrap: NostrEvent,
  guardianBackend: DecryptingSigningBackend,
  expectedSignerPubkey: string,
): Promise<AuditRumor | null> {
  return unwrapWrappedRumor(wrap, guardianBackend, expectedSignerPubkey, ESCALATION_UNWRAP_SPEC);
}

/**
 * Turn a validated rumor into an `EscalationNotice`. Returns null if any
 * required tag is missing or malformed.
 */
export function parseEscalationNotice(rumor: AuditRumor): EscalationNotice | null {
  if (!rumor || rumor.kind !== ESCALATION_EVENT_KIND) return null;

  const tagMap = indexTags(rumor.tags);

  // `t` marker discriminates approval vs petition — required.
  const t = tagMap.t;
  if (t !== 'approval' && t !== 'petition') return null;
  const kind: 'approval' | 'petition' = t;

  // `d` is the opaque coalescing id — required non-empty, no parsing.
  const d = tagMap.d;
  if (!d || typeof d !== 'string') return null;

  const client = tagMap.client;
  if (!client || !HEX64.test(client)) return null;

  const identity = tagMap.identity;
  if (!identity || !HEX64.test(identity)) return null;

  const method = tagMap.method;
  if (!method || typeof method !== 'string') return null;

  const notice: EscalationNotice = {
    id: d,
    kind,
    clientPubkey: client.toLowerCase(),
    identityPubkey: identity.toLowerCase(),
    method,
    createdAt: rumor.created_at,
  };

  if (typeof tagMap.k === 'string') {
    const eventKind = Number.parseInt(tagMap.k, 10);
    if (Number.isFinite(eventKind) && eventKind >= 0) notice.eventKind = eventKind;
  }

  if (kind === 'approval') {
    // Approval notices require a valid park (event id) or the whole
    // notice is unusable — there's nothing to approve/reject against.
    const park = tagMap.park;
    if (!park || !HEX64.test(park)) return null;
    notice.parkId = park.toLowerCase();

    if (typeof tagMap['park-ttl'] === 'string') {
      const ttl = Number.parseInt(tagMap['park-ttl'], 10);
      if (Number.isFinite(ttl) && ttl >= 0) notice.parkTtlSeconds = ttl;
    }
  } else {
    // Petitions: `park` is ignored/absent by design — a petition doesn't
    // park a request, it just flags that the paired child wants a
    // decision. `count` is optional and must be a positive integer.
    if (typeof tagMap.count === 'string') {
      const count = Number.parseInt(tagMap.count, 10);
      if (Number.isFinite(count) && count > 0) notice.count = count;
    }
  }

  return notice;
}

/**
 * Latest-wins coalescing by `id`. Duplicate ids (e.g. a re-published
 * notice with updated `park-ttl`) collapse to the entry with the
 * highest `createdAt`; a tie keeps whichever was seen first in the
 * input order. Output is sorted newest-first.
 */
export function coalesceNotices(notices: EscalationNotice[]): EscalationNotice[] {
  const byId = new Map<string, EscalationNotice>();

  for (const n of notices) {
    const existing = byId.get(n.id);
    if (!existing || n.createdAt > existing.createdAt) {
      byId.set(n.id, n);
    }
    // Tie or older: keep the existing (first-seen) entry — no-op.
  }

  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * True when an approval notice's park window has lapsed
 * (`createdAt + ttl < nowSeconds`). Petitions never expire this way —
 * they represent an open ask, not a time-boxed hold.
 */
export function isParkExpired(n: EscalationNotice, nowSeconds: number): boolean {
  if (n.kind !== 'approval') return false;
  if (n.parkTtlSeconds === undefined) return false;
  return n.createdAt + n.parkTtlSeconds < nowSeconds;
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * Build a single-key tag map preferring the FIRST occurrence per key —
 * mirrors `audit-fetch.ts`'s `indexTags` for the same reason: multi-value
 * collisions on a single-valued key would be a malformed rumor, and
 * first-write-wins keeps the parse stable.
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
