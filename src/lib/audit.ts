/**
 * Metadata-only audit log for dependant signing activity.
 * See the 2026-04-22 child-signing holodeck OQ1:
 *
 *   "Metadata-only. WHO (counterparty pubkey / origin), WHAT KIND
 *    (sign-in, DM, vouch, credential presentation, …), WHEN — never what
 *    was said, what was bought, or what was voted."
 *
 * **Privacy invariant** (enforced here): the audit event MUST NOT carry the
 * signed event's content, payload, or body. Only the minimal metadata tags
 * below. If you find yourself adding more, push back to the holodeck first.
 *
 * Transport: kind 31000, NIP-17 gift-wrapped (kind 1059), encrypted to the
 * guardian's pubkey. When a Heartwood Pi is present it publishes on the
 * phone's behalf; when not (the phone-as-family-bunker case that ships
 * today) the guardian phone publishes directly since it was the signer
 * anyway. See holodeck OQ12 / spec §Resolved Decision 5.
 *
 * This module's gift-wrap is now dual-addressed when audit visibility
 * resolves to true for the dep (v2). See
 * `src/lib/audit-visibility.ts` for the resolver. The two wraps share
 * a single rumor — the seal-and-wrap pair encrypts the same plaintext
 * to the guardian and (when visible) to the dep's NIP-46 client
 * pubkey. The child's paired device decrypts the second wrap with
 * the client privkey it already holds for the bunker pairing.
 *
 * The guardian publish is the canonical audit-of-record; the child
 * publish is best-effort. A failed child publish is recoverable —
 * the guardian still has the log and the worst-case is a hole in the
 * child's local view. The dual publish doubles relay traffic per
 * audit event when the second wrap is emitted; that's acceptable
 * because audit is low-frequency. A v3 may switch to a shared-key
 * derivation if traffic doubling becomes a concern.
 */

import type { UnsignedEvent } from 'signet-protocol';
import type { SigningBackend } from './signing-backend';
import { giftWrap, publishToRelay, isValidRelayUrl } from './relay-publish';

/** Kind used for the audit rumor before gift-wrapping. */
export const AUDIT_EVENT_KIND = 31000;

/**
 * Outcomes a signing request can reach. The holodeck OQ1 consensus listed
 * `approved|denied|auto` as the authoritative set; we split `auto` into
 * approve / deny variants so the timeline can show whether a remembered
 * grant allowed or blocked the request without having to correlate with
 * the signed-event history. `ceremony-complete` is a separate lifecycle
 * entry — the last log-of-record before the guardian relinquishes
 * and the dependant's bunker material is purged.
 */
export type AuditOutcome =
  | 'approved'
  | 'denied'
  | 'auto-approved'
  | 'auto-denied'
  /**
   * Sign refused by a Charter clause. Today
   * only the schedule clause emits this; future clauses (budget,
   * spend, content, comms) will reuse the outcome with a different
   * `clauseReason`. Distinct from `auto-denied` because the parent's
   * timeline UI treats clause-blocks differently — they're a positive
   * signal that policy is working, not a misbehaviour signal.
   */
  | 'clause-blocked'
  | 'ceremony-complete';

export interface AuditEventParams {
  /**
   * The dependant whose activity is being audited — their primary signing
   * pubkey. Used as the `d` tag so the guardian's viewer can filter by
   * dependant.
   */
  dependantPubkey: string;
  /**
   * Nostr event kind of the template the dependant was signing. Required
   * for signing outcomes (approved / denied / auto-*); omit for lifecycle
   * outcomes like `ceremony-complete` where no signed event exists.
   */
  eventKind?: number;
  /**
   * Counterparty pubkey where applicable (`p` tag of a DM, vouch target,
   * Blossom auth subject, etc.). Omit when the scope has no counterparty.
   */
  counterpartyPubkey?: string;
  /**
   * Requesting origin (sign-in domain, app origin, Blossom server URL).
   * Omit when the scope has no origin notion (post-public, venue-entry).
   */
  origin?: string;
  /** Policy / lifecycle outcome — see AuditOutcome. */
  outcome: AuditOutcome;
  /**
   * For `outcome: 'clause-blocked'` — which Charter clause refused
   * (per the Charter schedule contract). v1 ships `'schedule'`;
   * other clause names (`'budget'`, `'spend'`, etc.) are reserved.
   */
  clauseType?: 'schedule';
  /**
   * For `outcome: 'clause-blocked'` — the specific reason within
   * `clauseType`. v1 schedule values: `'outside-allowed-hours'` or
   * `'paused'`.
   */
  clauseReason?: 'outside-allowed-hours' | 'paused';
  /**
   * For schedule-blocked refusals — which schedule contributed.
   * `'per-origin'` means a RememberedGrant.schedule was the binding
   * factor; `'dep-default'` means the dep's defaultSchedule;
   * `'intersection'` when both were set and the intersection refused.
   */
  scheduleSource?: 'per-origin' | 'dep-default' | 'intersection';
  /**
   * Unix seconds — most recent issuedAt of the contributing schedules.
   * Helps the parent correlate "I changed the schedule at 8am, and
   * Tom's first refused-sign was at 8:01am".
   */
  scheduleIssuedAt?: number;
  /**
   * Unix seconds — when the dependant could next legitimately sign,
   * if known within the schedule's horizon. Undefined if the next
   * window is outside the horizon (the dep is blocked indefinitely
   * from the engine's perspective). Useful for the audit-log timeline
   * to render "back at 4pm tomorrow".
   */
  nextAllowedAt?: number;
  /**
   * NIP-46 method name for non-`sign_event` operations that go through
   * the policy gate (e.g. silent NIP-04/NIP-44 encrypt/decrypt). When set,
   * `eventKind` is not required (the request was a transport-level
   * encrypt/decrypt, not a Nostr event template). Emitted as a `method`
   * tag so consumers can distinguish "decrypted a DM" from
   * "signed a kind-X event".
   */
  method?: 'nip04_encrypt' | 'nip04_decrypt' | 'nip44_encrypt' | 'nip44_decrypt';
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Build the unsigned kind-31000 event template that represents a single
 * dependant signing decision.
 *
 * Exported pure so the audit-shape invariant can be verified without
 * standing up a relay or backend in tests.
 */
export function buildAuditEventTemplate(
  params: AuditEventParams,
  guardianPubkey: string,
): UnsignedEvent {
  if (!HEX64.test(guardianPubkey)) {
    throw new Error('guardianPubkey must be 64-char hex');
  }
  if (!HEX64.test(params.dependantPubkey)) {
    throw new Error('dependantPubkey must be 64-char hex');
  }
  if (params.eventKind !== undefined) {
    if (!Number.isInteger(params.eventKind) || params.eventKind < 0) {
      throw new Error('eventKind must be a non-negative integer');
    }
  } else if (params.outcome !== 'ceremony-complete' && !params.method) {
    // Signing outcomes (approved / denied / auto-* / clause-blocked)
    // always have a kind — the template was a Nostr event template.
    // Lifecycle outcomes like ceremony-complete don't. NIP-46 transport
    // methods (NIP-04/NIP-44 encrypt/decrypt) carry `method` instead of
    // `eventKind` because they're not Nostr-event signs. Anything else
    // is a caller bug.
    throw new Error('eventKind is required for signing outcomes');
  }
  if (params.counterpartyPubkey && !HEX64.test(params.counterpartyPubkey)) {
    throw new Error('counterpartyPubkey must be 64-char hex when provided');
  }
  if (params.outcome === 'clause-blocked') {
    if (!params.clauseType) {
      throw new Error('clauseType is required when outcome is clause-blocked');
    }
    if (!params.clauseReason) {
      throw new Error('clauseReason is required when outcome is clause-blocked');
    }
  }

  // Tag order: `t` (event-type marker for subscribers' filter), `d` (the
  // replaceable-event dedup key — we want one row per decision, so include
  // the millisecond timestamp), then the OQ1 metadata tags. No content tag
  // anywhere in the rumor — that's the whole privacy contract.
  const tags: string[][] = [
    ['t', 'audit'],
    ['d', `${params.dependantPubkey}:${Date.now()}`],
  ];
  if (params.eventKind !== undefined) tags.push(['k', String(params.eventKind)]);
  if (params.method) tags.push(['method', params.method]);
  tags.push(['outcome', params.outcome]);
  if (params.counterpartyPubkey) tags.push(['p', params.counterpartyPubkey.toLowerCase()]);
  if (params.origin) tags.push(['origin', params.origin]);
  // Clause-blocked metadata — schedule clause v1.
  // Tag layout matches the Charter schedule contract §Audit:
  // `clause` identifies WHICH clause refused (e.g. "schedule"),
  // `reason` identifies the specific cause within that clause.
  if (params.clauseType) tags.push(['clause', params.clauseType]);
  if (params.clauseReason) tags.push(['reason', params.clauseReason]);
  if (params.scheduleSource) tags.push(['schedule-source', params.scheduleSource]);
  if (params.scheduleIssuedAt !== undefined) tags.push(['schedule-issued', String(params.scheduleIssuedAt)]);
  if (params.nextAllowedAt !== undefined) tags.push(['next-allowed', String(params.nextAllowedAt)]);

  return {
    kind: AUDIT_EVENT_KIND,
    pubkey: guardianPubkey.toLowerCase(),
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * Publish a metadata-only audit record for a dependant signing decision.
 *
 * Returns false on any precondition failure for the GUARDIAN publish
 * (bad relay, bad backend, build throw) so callers can decide whether
 * to log or retry — but never throws, because an audit-publish
 * failure must not block the signing flow that triggered it. Auditing
 * is a secondary duty; signing is primary.
 *
 * When `childClientPubkey` is set (a 64-char hex pubkey), the same
 * rumor is ALSO gift-wrapped to that pubkey and published — the
 * paired-child device's NIP-46 client pubkey, whose private key lives
 * on the dep's own device. Only set this when audit visibility is
 * resolved-true for the dep at this moment (see
 * `audit-visibility.ts`). The child publish is best-effort — a
 * failure there does NOT cause the function to return false. The
 * guardian still has the canonical log; the worst-case is a hole in
 * the child's local view that the next dual-published event will
 * paper over.
 *
 * Doubles relay traffic per audit event when set; that's fine —
 * audit is low-frequency.
 */
export async function publishAuditEvent(
  params: AuditEventParams,
  guardianPubkey: string,
  backend: SigningBackend,
  relayUrl: string,
  childClientPubkey?: string,
): Promise<boolean> {
  if (!relayUrl || !isValidRelayUrl(relayUrl)) return false;
  if (!HEX64.test(guardianPubkey)) return false;
  try {
    // Build the rumor template ONCE — we want both wraps to encrypt
    // the same plaintext so the child's view and the guardian's view
    // are identical (same `d` tag id, same `created_at`, same outcome).
    const template = buildAuditEventTemplate(params, guardianPubkey);

    const guardianWrap = await giftWrap(template, guardianPubkey, backend);
    const guardianPublishOk = await publishToRelay(guardianWrap, relayUrl);

    // Secondary publish — best-effort. We swallow throws (giftWrap can
    // throw on a malformed pubkey; publishToRelay won't, but the
    // websocket can drop) so a child-side problem never bubbles back
    // to the caller as a guardian-side audit failure.
    if (childClientPubkey && HEX64.test(childClientPubkey)) {
      try {
        const childWrap = await giftWrap(template, childClientPubkey, backend);
        await publishToRelay(childWrap, relayUrl);
      } catch {
        // Non-fatal — the guardian's wrap was the audit-of-record.
      }
    }

    return guardianPublishOk;
  } catch {
    return false;
  }
}
