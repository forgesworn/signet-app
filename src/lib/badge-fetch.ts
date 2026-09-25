import { buildBadgeFilters, computeBadge, computeTrustScore, ATTESTATION_TYPES, ATTESTATION_KIND } from 'signet-protocol';
import type { EntityType, TrustScoreBreakdown } from 'signet-protocol';
import { verifiedAuthoredEvents } from './event-verify';
import { isValidRelayUrl } from './relay-url';
import { fetchEvents } from './relay-service';

/** Per-signal-type contribution for display in the IQ breakdown */
export interface IQBreakdownItem {
  label: string;
  points: number;
  max: number;
}

export interface CachedBadge {
  tier: 1 | 2 | 3 | 4;
  tierLabel: string;
  score: number;
  entityType?: EntityType;
  isVerified: boolean;
  credentialCount: number;
  vouchCount: number;
  fetchedAt: number;
  /** Per-signal-type score contributions for the IQ breakdown panel */
  iqBreakdown?: IQBreakdownItem[];
}

/** Build the IQ breakdown display items from a TrustScoreBreakdown */
function buildIQBreakdown(breakdown: TrustScoreBreakdown): IQBreakdownItem[] {
  const sumByType = (type: TrustScoreBreakdown['signals'][number]['type']): number =>
    breakdown.signals
      .filter(s => s.type === type)
      .reduce((acc, s) => acc + s.weight, 0);

  return [
    {
      label: 'Professional verification',
      points: Math.round(sumByType('professional-verification')),
      max: 80,
    },
    {
      label: 'Identity bridge',
      points: Math.round(sumByType('identity-bridge')),
      max: 50,
    },
    {
      label: 'In-person vouches (capped at 3)',
      points: Math.round(sumByType('in-person-vouch')),
      max: 48,
    },
    {
      label: 'Online vouches (capped at 5)',
      points: Math.round(sumByType('online-vouch')),
      max: 20,
    },
    {
      label: 'Account age (capped at 2 years)',
      points: Math.round(sumByType('account-age')),
      max: 20,
    },
  ];
}

/** Build relay filters that include credentials, vouches, AND identity bridges */
function buildFullBadgeFilters(pubkeys: string[]): Array<{ kinds: number[]; '#d': string[] } | { kinds: number[]; authors: string[] }> {
  const credVouchFilter = buildBadgeFilters(pubkeys);
  // Identity bridges are self-authored (bridge.pubkey === subject) with type: identity-bridge
  const bridgeFilter = {
    kinds: [ATTESTATION_KIND],
    authors: pubkeys,
  };
  return [...credVouchFilter, bridgeFilter];
}

/** Fetch badge data for a pubkey from a relay. Returns null if relay is unreachable. */
export async function fetchBadge(
  pubkey: string,
  relayUrl: string,
  timeoutMs = 10000
): Promise<CachedBadge | null> {
  if (!isValidRelayUrl(relayUrl)) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  try {
    const filters = buildFullBadgeFilters([pubkey]);
    // Scope the fetch to the validated relayUrl (the caller's configured
    // relay) rather than the whole enabled+read pool — badge data is
    // meaningful relative to a specific relay, and the pool-wide default
    // in fetchEvents would silently ignore the just-validated relayUrl.
    const rawEvents = await fetchEvents(filters as never, { timeoutMs, relays: [relayUrl] });
    // Defense-in-depth: drop relay-forged events with bad signatures before
    // any consumer sees them (relay's `authors:` filter is untrusted).
    const events = verifiedAuthoredEvents(rawEvents);

    const badge = await computeBadge(pubkey, events, { verifySignatures: true });

    const credentials = events.filter(e =>
      e.kind === ATTESTATION_KIND && e.tags.some(t => t[0] === 'type' && t[1] === ATTESTATION_TYPES.CREDENTIAL)
    );
    const vouches = events.filter(e =>
      e.kind === ATTESTATION_KIND && e.tags.some(t => t[0] === 'type' && t[1] === ATTESTATION_TYPES.VOUCH)
    );
    const bridges = events.filter(e =>
      e.kind === ATTESTATION_KIND && e.tags.some(t => t[0] === 'type' && t[1] === ATTESTATION_TYPES.IDENTITY_BRIDGE)
    );
    const trustBreakdown = computeTrustScore(pubkey, credentials, vouches, undefined, bridges);

    return {
      tier: badge.tier,
      tierLabel: badge.tierLabel,
      score: badge.score,
      entityType: badge.entityType,
      isVerified: badge.isVerified,
      credentialCount: badge.credentialCount,
      vouchCount: badge.vouchCount,
      fetchedAt: Math.floor(Date.now() / 1000),
      iqBreakdown: buildIQBreakdown(trustBreakdown),
    };
  } catch {
    return null;
  }
}

/** Fetch badges for multiple pubkeys in a single relay query. */
export async function fetchBadges(
  pubkeys: string[],
  relayUrl: string,
  timeoutMs = 10000
): Promise<Map<string, CachedBadge>> {
  const results = new Map<string, CachedBadge>();
  if (!isValidRelayUrl(relayUrl)) {
    return results;
  }
  const validPubkeys = pubkeys.filter(p => /^[0-9a-f]{64}$/i.test(p));
  if (validPubkeys.length === 0) return results;

  try {
    const filters = buildFullBadgeFilters(validPubkeys);
    // Scoped to relayUrl — see fetchBadge above.
    const rawEvents = await fetchEvents(filters as never, { timeoutMs, relays: [relayUrl] });
    // Defense-in-depth: drop relay-forged events with bad signatures.
    const events = verifiedAuthoredEvents(rawEvents);

    for (const pubkey of validPubkeys) {
      const badge = await computeBadge(pubkey, events, { verifySignatures: true });

      const credentials = events.filter(e =>
        e.kind === ATTESTATION_KIND && e.tags.some(t => t[0] === 'type' && t[1] === ATTESTATION_TYPES.CREDENTIAL)
      );
      const vouches = events.filter(e =>
        e.kind === ATTESTATION_KIND && e.tags.some(t => t[0] === 'type' && t[1] === ATTESTATION_TYPES.VOUCH)
      );
      const bridges = events.filter(e =>
        e.kind === ATTESTATION_KIND && e.tags.some(t => t[0] === 'type' && t[1] === ATTESTATION_TYPES.IDENTITY_BRIDGE)
      );
      const trustBreakdown = computeTrustScore(pubkey, credentials, vouches, undefined, bridges);

      results.set(pubkey, {
        tier: badge.tier,
        tierLabel: badge.tierLabel,
        score: badge.score,
        entityType: badge.entityType,
        isVerified: badge.isVerified,
        credentialCount: badge.credentialCount,
        vouchCount: badge.vouchCount,
        fetchedAt: Math.floor(Date.now() / 1000),
        iqBreakdown: buildIQBreakdown(trustBreakdown),
      });
    }
  } catch {
    // Relay unreachable — return empty map
  }
  return results;
}
