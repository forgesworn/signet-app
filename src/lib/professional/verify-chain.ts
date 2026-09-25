/**
 * End-to-end pro trust-chain verifier. Spec §7.1.
 *
 * Verifies that a credential signed by a sub-role member is backed by the full
 * five-layer chain: registry lookup → signet.json → identifier match →
 * roster → signer in roster → signature valid.
 *
 * Cache layer: reads the `professionalRegistry` and `professionalSignetJson`
 * IndexedDB stores (24h TTL). No network calls when both caches are warm.
 */

import type { NostrEvent } from 'signet-protocol';
import { verifyEvent } from 'signet-protocol';
import type { ProfessionKind, Jurisdiction, RegulatedEntityRecord } from './types';
import type { ProSignetJson } from './signet-json';
import { fetchProSignetJson } from './signet-json';
import { resolveIdentifier } from './resolver';
import {
  getProRegistryRecord,
  setProRegistryRecord,
  getProSignetJson,
  setProSignetJson,
  invalidateProRegistryRecord,
  invalidateProSignetJson,
} from '../db';
import { maybePassiveDirectoryPublish } from './directory-cache';
import { CACHE_TTL_MS } from './constants';
import { fetchEvents } from '../relay-service';
import { PRO_REVOCATION, PRO_DIRECTORY_ADD } from './kinds';

const TTL_MS = CACHE_TTL_MS;

// ── Result types ──────────────────────────────────────────────────────────────

export type VerifyChainOk = {
  ok: true;
  firmName: string;
  role: string | null;
  profession: ProfessionKind;
  jurisdiction: Jurisdiction;
};

export type VerifyChainFail = {
  ok: false;
  reason:
    | 'registry-not-found'
    | 'status-inactive'
    | 'domain-mismatch'
    | 'signet-json-mismatch'
    | 'signer-not-in-roster'
    | 'signature-invalid'
    | 'chain-error'
    | 'revoked';
  detail?: string;
};

export type VerifyChainResult = VerifyChainOk | VerifyChainFail;

// ── Domain normalisation — spec §12 Q1 ───────────────────────────────────────

function normaliseHost(raw: string): string {
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return url.host.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.replace(/^www\./, '').toLowerCase();
  }
}

/**
 * Sub-domain rejection: the JSON-fetch host must exactly match the registry
 * website host (after www. strip and lowercasing). Sub-domains are rejected.
 * Sub-paths are accepted when the registry URL itself contains a path (spec Q1).
 */
function hostsMatch(registryWebsite: string, fetchedFromHost: string): boolean {
  const a = normaliseHost(registryWebsite);
  const b = normaliseHost(fetchedFromHost);
  if (a === b) return true;
  // Sub-path rule: if the registry URL includes a path component, a prefix match is acceptable.
  if (a.includes('/') && b.startsWith(a)) return true;
  return false;
}

// ── Authority union ───────────────────────────────────────────────────────────

export interface AuthorityUnionInput {
  /** All lead pubkeys declared in signet.json (hex, normalised). */
  leadPubkeys: string[];
  /**
   * Latest kind-30202 roster event for each lead — one per lead, or empty
   * for leads that have not yet published a roster.
   */
  latestRosters: Array<{ pubkey: string; created_at: number; tags: string[][] }>;
}

export interface AuthorityUnion {
  leads: string[];
  delegates: string[];
  /** leads ∪ delegates — the complete set that may sign roster updates. */
  allAuthorised: string[];
}

/**
 * Assemble the authority union from signet.json leads and all current delegate
 * tags across the latest roster from each lead.
 *
 * Spec §3.5.1:
 *   authority_union = {p : p ∈ headPubkeys(signet.json)}
 *                   ∪ {p : ['delegate', p] ∈ current_roster.tags}
 *
 * Concurrent-roster union rule (spec §3.5.6):
 *   If lead-A's latest roster removes delegate D but lead-B's latest roster
 *   still includes D, D remains in the authority union. Both leads must
 *   publish a roster without D before D loses authority.
 *   The strict-removal option (['revoke', '<pubkey>'] tag) is deferred to a
 *   future phase and is NOT checked here.
 *
 * Note on §3 step (d) summary: the spec's §3 trust-chain summary says
 * "lead pubkey from signet.json signed the roster event." That statement
 * under-states the model as of §3.5 (locked in 2026-04-25). The authority
 * union — not only the lead pubkey — may sign valid roster events.
 * See §3.5.1 for the canonical definition.
 *
 * Note on §7.1 step 5: the verification narrative says "headPubkey is the
 * signer of the most recent kind-30XXX roster event." As of §3.5, any pubkey
 * in the authority union (leads ∪ delegates) may sign a valid roster.
 * Spec §3.5 is authoritative; §7.1 step 5 is a simplified summary.
 */
export function getCurrentAuthorityUnion(input: AuthorityUnionInput): AuthorityUnion {
  const leads = [...input.leadPubkeys];

  // Collect delegate pubkeys from ['delegate', '<pubkey>'] tags across ALL
  // latest rosters. Union semantics: a delegate in ANY lead's latest roster
  // is authorised (spec §3.5.6 concurrent-roster default).
  const delegates: string[] = [];
  for (const roster of input.latestRosters) {
    for (const tag of roster.tags) {
      if (tag[0] === 'delegate' && typeof tag[1] === 'string' && tag[1].length > 0) {
        if (!delegates.includes(tag[1])) {
          delegates.push(tag[1]);
        }
      }
    }
  }

  const allAuthorised = Array.from(new Set([...leads, ...delegates]));
  return { leads, delegates, allAuthorised };
}

// ── Tag helpers ───────────────────────────────────────────────────────────────

function extractIdentifier(cred: NostrEvent): string | null {
  const tag = cred.tags?.find(t => t[0] === 'identifier');
  return tag?.[1] ?? null;
}

function extractRoleFromRoster(rosterEvent: NostrEvent, memberPubkey: string): string | null {
  const tag = rosterEvent.tags?.find(t => t[0] === 'p' && t[1] === memberPubkey);
  return tag?.[2] ?? null;
}

// ── Cache-aware fetchers ──────────────────────────────────────────────────────

async function getCachedOrFetchRegistry(
  identifier: string,
  professionKind: ProfessionKind,
  jurisdiction: Jurisdiction,
) {
  // M5: professionKind is part of the cache key — two registries can assign
  // colliding identifiers of the same shape (e.g. GIAS URNs vs SRA firm
  // numbers), so a kind-less lookup could return the wrong registry's
  // cached record. See 2026-07-02 audit finding M5.
  const cached = await getProRegistryRecord(identifier, professionKind);
  if (cached && Date.now() - cached.cachedAt < TTL_MS) return cached.record;
  const fresh = await resolveIdentifier(identifier, professionKind, jurisdiction);
  if (fresh) await setProRegistryRecord(identifier, fresh);
  return fresh ?? null;
}

async function getCachedOrFetchSignetJson(domain: string): Promise<ProSignetJson | null> {
  const cached = await getProSignetJson(domain);
  if (cached && Date.now() - cached.cachedAt < TTL_MS) {
    return cached.json as ProSignetJson;
  }
  const fresh = await fetchProSignetJson(domain);
  if (fresh) await setProSignetJson(domain, fresh as unknown as Record<string, unknown>);
  return fresh;
}

/** Matches role-anchor.ts's private `dTag()` — `<registry>:<identifier>`. */
function proDTag(registry: string, identifier: string): string {
  return `${registry}:${identifier}`;
}

/**
 * Check for an applicable kind-30204 revocation for this firm/member.
 * Two event shapes, both built by `role-anchor.ts` and both signed by a
 * lead pubkey:
 *   - Full role-anchor revocation (`buildRoleAnchorRevocationEvent`) — no
 *     `p` tag. Applies to every credential under this firm's d-tag.
 *   - Fast sub-role revocation (`buildRevocationEvent`) — carries
 *     `['p', revokedPubkey]`. Applies only to that specific member.
 *
 * Kind 30204 is addressable (30000-39999 range) — at most one live event
 * per (lead pubkey, d-tag) pair, since a fresh publish replaces the
 * previous one at the relay. We still fetch across all current leads,
 * since any one of them may have published a revocation.
 *
 * No caching: a stale cached "not revoked" would defeat the whole point
 * of this check, and revocation checks aren't on a hot path. On fetch
 * failure this fails CLOSED (returns 'unreachable'), matching the rest of
 * the chain's fail-closed posture on registry/signet.json fetch failure
 * (see 2026-07-02 audit finding C3).
 */
async function checkRevocation(
  registry: string,
  identifier: string,
  leadPubkeys: string[],
  memberPubkey: string,
): Promise<{ revoked: true; detail: string } | { revoked: false } | { revoked: 'unreachable' }> {
  if (leadPubkeys.length === 0) return { revoked: false };
  const dTagValue = proDTag(registry, identifier);

  let events: NostrEvent[];
  try {
    events = await fetchEvents([{
      kinds: [PRO_REVOCATION],
      authors: leadPubkeys,
      '#d': [dTagValue],
    } as never]) as unknown as NostrEvent[];
  } catch {
    return { revoked: 'unreachable' };
  }

  for (const ev of events) {
    // Defence-in-depth: the `authors` filter is a hint, not a guarantee —
    // a hostile relay could return an event with the wrong pubkey.
    if (!leadPubkeys.includes(ev.pubkey)) continue;
    if (!(await verifyEvent(ev))) continue;
    const dTagOnEvent = ev.tags?.find(t => t[0] === 'd')?.[1];
    if (dTagOnEvent !== dTagValue) continue;

    const revokedMemberTag = ev.tags?.find(t => t[0] === 'p')?.[1];
    if (revokedMemberTag === undefined) {
      return { revoked: true, detail: 'professional role revoked' };
    }
    if (revokedMemberTag === memberPubkey) {
      return { revoked: true, detail: 'sub-role member revoked' };
    }
  }
  return { revoked: false };
}

/**
 * Resolve whether a firm has opted into the public Signet directory, per
 * its own kind-30203 (`PRO_DIRECTORY_ADD`) event (`buildDirectoryAddEventSigned`,
 * `['listed', 'true'|'false']` tag). Defaults to `false` (opt-out) on any
 * ambiguity — no event found, fetch failure, invalid signature, wrong
 * d-tag, or a missing/malformed `listed` tag — matching directory-cache.ts's
 * documented "false = opt-out; skip" contract.
 *
 * Fixes M4 (2026-07-02 audit): `verifyProChain` previously hardcoded
 * `listedFlag: true` for every successful verify, publishing a passive
 * directory entry for firms regardless of whether they'd actually
 * consented to be listed.
 */
export async function resolveListedFlag(
  registry: string,
  identifier: string,
  leadPubkeys: string[],
): Promise<boolean> {
  if (leadPubkeys.length === 0) return false;
  const dTagValue = proDTag(registry, identifier);

  let events: NostrEvent[];
  try {
    events = await fetchEvents([{
      kinds: [PRO_DIRECTORY_ADD],
      authors: leadPubkeys,
      '#d': [dTagValue],
    } as never]) as unknown as NostrEvent[];
  } catch {
    return false;
  }

  let latest: NostrEvent | null = null;
  for (const ev of events) {
    if (!leadPubkeys.includes(ev.pubkey)) continue;
    if (!(await verifyEvent(ev))) continue;
    const dTagOnEvent = ev.tags?.find(t => t[0] === 'd')?.[1];
    if (dTagOnEvent !== dTagValue) continue;
    if (!latest || ev.created_at > latest.created_at) latest = ev;
  }
  if (!latest) return false;
  const listedTag = latest.tags?.find(t => t[0] === 'listed')?.[1];
  return listedTag === 'true';
}

// ── Main verifier ─────────────────────────────────────────────────────────────

/**
 * Verify the full pro trust chain for a credential signed by a sub-role member.
 * Steps follow spec §7.1.
 *
 * @param credential   Signed credential event produced by the sub-role member.
 * @param rosterEvent  Lead's signed kind-30202 roster event (caller fetches from relay).
 * @param professionKind  Declared profession from the credential or calling context.
 * @param jurisdiction    Declared jurisdiction from credential or signet.json.
 * @param verifierPrivkeyHex  Optional. When provided, a one-shot passive kind-30203 directory
 *   entry is published on first successful verify (fire-and-forget; never throws).
 */
export async function verifyProChain(
  credential: NostrEvent,
  rosterEvent: NostrEvent,
  professionKind: ProfessionKind,
  jurisdiction: Jurisdiction,
  verifierPrivkeyHex?: string,
): Promise<VerifyChainResult> {
  const identifier = extractIdentifier(credential);
  if (!identifier) {
    return { ok: false, reason: 'chain-error', detail: 'no identifier tag on credential' };
  }

  // Step (a): registry lookup → status = active.
  const record = await getCachedOrFetchRegistry(identifier, professionKind, jurisdiction);
  if (!record) return { ok: false, reason: 'registry-not-found' };
  if (record.status !== 'Active') return { ok: false, reason: 'status-inactive' };

  if (!record.website) {
    return { ok: false, reason: 'chain-error', detail: 'registry record has no website' };
  }

  // Step (b): fetch signet.json from registry's canonical website.
  const signetJson = await getCachedOrFetchSignetJson(record.website);
  if (!signetJson) {
    return { ok: false, reason: 'chain-error', detail: 'signet.json not reachable' };
  }

  // Domain-mismatch guard: the host we fetched from must match the registry website (spec §12 Q1, Q6).
  const fetchedHost = signetJson._fetchedFromHost ?? record.website;
  if (!hostsMatch(record.website, fetchedHost)) {
    await invalidateProRegistryRecord(identifier, professionKind);
    await invalidateProSignetJson(record.website);
    return { ok: false, reason: 'domain-mismatch' };
  }

  // Step (c): signet.json identifier matches registry record.
  // Spec §12 Q5: if `entities[]` array is present, check each entry.
  let identifierMatched: boolean;
  if (signetJson.entities && signetJson.entities.length > 0) {
    identifierMatched = signetJson.entities.some(e => e.value === identifier);
  } else {
    identifierMatched = signetJson.identifier.value === identifier;
  }

  if (!identifierMatched) {
    await invalidateProSignetJson(record.website);
    return { ok: false, reason: 'signet-json-mismatch' };
  }

  // Step (d): the roster event was signed by a pubkey in the authority union.
  // Spec §3.5.1: authority_union = leads ∪ current delegates.
  // Spec §7.1 step 5 — multi-lead: check authority union, not single headPubkey.
  //
  // Known limitation (2026-07-02 audit, verified minor): role-anchor.ts
  // documents a 90-day lead-key-rotation grace window — during rotation,
  // roster events signed by either the current OR the previous head pubkey
  // should verify (`buildLeadKeyRotationEvent`, prev-head tag). That grace
  // window is NOT implemented here; `leadPubkeys` below comes solely from
  // the freshly-fetched signet.json, so a roster signed by a just-rotated-
  // away head fails closed (availability bug, not a security hole) until
  // the new head republishes.
  //
  // Not implemented because it needs a design decision this verifier can't
  // make safely on its own: `verifyProChain` never fetches kind-30201
  // role-anchor/rotation events at all (only HTTP signet.json + the
  // caller-supplied roster + kind-30204 revocations), and
  // `buildLeadKeyRotationEvent`'s `d` tag (`${identifier.kind}:${identifier.value}`)
  // doesn't match the `dTag(registry, identifier)` scheme every other
  // pro-surface event builder uses (incl. the roster/revocation events this
  // file already fetches). Wiring the grace window in means either
  // reconciling that d-tag mismatch or introducing a new fetch+cache path —
  // out of scope for a verified-minor fix. Fail-closed is the safe default
  // in the meantime; do not silently widen the authority union without
  // resolving the d-tag scheme first.
  const leadPubkeys = signetJson.leadPubkeys ?? [signetJson.leadPubkey];
  const authorityUnion = getCurrentAuthorityUnion({
    leadPubkeys,
    latestRosters: [rosterEvent as unknown as { pubkey: string; created_at: number; tags: string[][] }],
  });
  if (!authorityUnion.allAuthorised.includes(rosterEvent.pubkey)) {
    await invalidateProSignetJson(record.website);
    return {
      ok: false,
      reason: 'signet-json-mismatch',
      detail: 'roster not signed by any pubkey in the authority union (leads ∪ delegates)',
    };
  }

  const memberPubkey = credential.pubkey;

  // Step (d.5): kind-30204 revocation check. Must run even though the
  // credential otherwise chains cleanly — a lead can revoke the whole
  // role-anchor or a single sub-role member without waiting for a fresh
  // roster republish. See `checkRevocation` for the two event shapes and
  // 2026-07-02 audit finding C3.
  const revocation = await checkRevocation(record.registry, record.identifier, leadPubkeys, memberPubkey);
  if (revocation.revoked === 'unreachable') {
    return { ok: false, reason: 'chain-error', detail: 'revocation check unreachable' };
  }
  if (revocation.revoked) {
    return { ok: false, reason: 'revoked', detail: revocation.detail };
  }

  // Step (e): sub-role member's pubkey appears in ANY of the latest rosters.
  // Members may be distributed across rosters from different leads.
  const inRoster = rosterEvent.tags?.some(t => t[0] === 'p' && t[1] === memberPubkey);
  if (!inRoster) return { ok: false, reason: 'signer-not-in-roster' };

  // Step (f): the act is signed by the sub-role member's key.
  if (!await verifyEvent(credential)) return { ok: false, reason: 'signature-invalid' };

  const role = extractRoleFromRoster(rosterEvent, memberPubkey);

  // Passive directory discovery — fire-and-forget; never throws. M4:
  // listedFlag is resolved from the firm's own kind-30203 opt-out record
  // rather than assumed true — see `resolveListedFlag`.
  if (verifierPrivkeyHex) {
    void (async () => {
      const listedFlag = await resolveListedFlag(record.registry, record.identifier, leadPubkeys);
      await maybePassiveDirectoryPublish({
        leadPubkey: signetJson.leadPubkey,
        firmName: record.name,
        identifier: { kind: record.identifierKind, value: record.identifier },
        canonicalUrl: record.website ?? '',
        professionKind,
        listedFlag,
        verifierPrivkeyHex,
      });
    })().catch(() => {
      // Passive publish failures are non-fatal. Silently swallow.
    });
  }

  return {
    ok: true,
    firmName: record.name,
    role,
    profession: professionKind,
    jurisdiction,
  };
}

// ── Registry drift detection ──────────────────────────────────────────────────

export type DriftResult =
  | { drifted: false }
  | { drifted: true; reason: string };

/**
 * Compare a freshly-resolved registry record against the locally-cached one.
 * Returns { drifted: true, reason } if any load-bearing field changed.
 */
export function detectRegistryDrift(
  live: RegulatedEntityRecord,
  cached: RegulatedEntityRecord,
): DriftResult {
  if (live.name !== cached.name) {
    return { drifted: true, reason: `Organisation name changed: "${cached.name}" → "${live.name}"` };
  }
  const liveWebsite = normaliseHost(live.website ?? live.inferredCandidateWebsite ?? '');
  const cachedWebsite = normaliseHost(cached.website ?? cached.inferredCandidateWebsite ?? '');
  if (liveWebsite !== cachedWebsite) {
    return { drifted: true, reason: `Registered website changed: "${cachedWebsite}" → "${liveWebsite}"` };
  }
  if (live.status !== cached.status) {
    return { drifted: true, reason: `Registry status changed: "${cached.status}" → "${live.status}"` };
  }
  return { drifted: false };
}
