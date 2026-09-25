import { useState, useEffect, useCallback } from 'react';
import { ATTESTATION_KIND, ATTESTATION_TYPES, getTagValue } from 'signet-protocol';
import type { NostrEvent } from 'signet-protocol';
import { getRelayClient, getRelayState, addStateListener } from '../lib/relay-service';
import { verifiedAuthoredEvents } from '../lib/event-verify';
import { safeImageOrLinkUrl } from '../lib/public-profile-publish';

/**
 * Strip control / bidi characters and cap length. Mirrors
 * `sanitiseDisplayName` in dependant-status-sync.ts — pasted relay tag
 * values can include zero-width chars / bidi overrides intended to spoof
 * the verifier identity in trust-display surfaces.
 */
function sanitiseTagText(raw: string | null | undefined, cap: number): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g"), '').slice(0, cap).trim();
  return clean || null;
}

export interface VerifierProfile {
  /** Verifier's display name (from `name` tag) */
  name: string | null;
  /** Professional field (from `profession` tag) */
  profession: string | null;
  /** Year the verifier became active (from `active-since` Unix timestamp tag) */
  activeSinceYear: number | null;
  /** Number of credentials issued (event count on relay) */
  issuanceCount: number;
  /** Professional registry identifier e.g. "SRA #123456" */
  registry: string | null;
  /** URL linking to registry entry */
  registryUrl: string | null;
  /** Domain anchor: the verifier is listed in a `.well-known/signet.json` */
  hasDomainAnchor: boolean;
  /** The domain value from the event tag, if present */
  domain: string | null;
}

interface UseVerifierProfileResult {
  profile: VerifierProfile | null;
  loading: boolean;
  error: string | null;
}

const TRUSTED_DOMAIN_SUFFIXES = ['.sch.uk', '.nhs.uk', '.ac.uk', '.gov.uk'];

/** Extract year from a Unix timestamp tag value, returning null if invalid. */
function parseYear(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const ts = parseInt(raw, 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const year = new Date(ts * 1000).getFullYear();
  // Sanity-check: verifier programmes are relatively recent
  if (year < 2000 || year > new Date().getFullYear()) return null;
  return year;
}

/** Return true if the domain belongs to a high-trust TLD suffix. */
export function isTrustedDomain(domain: string): boolean {
  return TRUSTED_DOMAIN_SUFFIXES.some(suffix => domain.endsWith(suffix));
}

/** Fetch verifier profile data for a given pubkey from the relay. */
export function useVerifierProfile(verifierPubkey: string | undefined): UseVerifierProfileResult {
  const [profile, setProfile] = useState<VerifierProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    if (!verifierPubkey) return;
    if (!/^[0-9a-f]{64}$/i.test(verifierPubkey)) return;
    if (getRelayState() !== 'connected') return;

    setLoading(true);
    setError(null);

    try {
      const client = getRelayClient();

      // Fetch the verifier's kind 31000 `type: verifier` event (authored by the verifier)
      const verifierEvents = await client.fetch([
        {
          kinds: [ATTESTATION_KIND],
          '#t': [ATTESTATION_TYPES.VERIFIER],
          authors: [verifierPubkey],
        } as never,
      ]);

      if (verifierEvents.length === 0) {
        setProfile(null);
        return;
      }

      // Verify-then-pick (audit pass 4): filter the full list BEFORE
      // sorting. A hostile relay can return one forged event with a
      // doctored `created_at = now + N` alongside the legitimate event;
      // if we sorted first and then verified the single candidate, the
      // forged event would mask the legitimate one.
      const verifiedEvents = verifiedAuthoredEvents(
        verifierEvents as unknown as Array<{ pubkey: string; sig: string; id: string }>,
        verifierPubkey,
      ) as unknown as NostrEvent[];
      if (verifiedEvents.length === 0) {
        setProfile(null);
        return;
      }
      const event: NostrEvent = verifiedEvents.reduce((latest, ev) =>
        ev.created_at > latest.created_at ? ev : latest
      );

      // Fetch credentials issued by this verifier to determine issuance count
      const issuedEventsRaw = await client.fetch([
        {
          kinds: [ATTESTATION_KIND],
          '#t': [ATTESTATION_TYPES.CREDENTIAL],
          authors: [verifierPubkey],
        } as never,
      ]);
      // Only verified-by-this-verifier credentials count toward issuance.
      const issuedEvents = verifiedAuthoredEvents(
        issuedEventsRaw as unknown as Array<{ pubkey: string; sig: string; id: string }>,
        verifierPubkey,
      );

      const name = sanitiseTagText(getTagValue(event, 'name'), 64);
      const profession = sanitiseTagText(getTagValue(event, 'profession'), 64);
      const activeSinceRaw = getTagValue(event, 'active-since');
      const activeSinceYear = parseYear(activeSinceRaw);
      const registry = sanitiseTagText(getTagValue(event, 'registry'), 64);
      const registryUrlRaw = getTagValue(event, 'registry-url') ?? null;
      // URL allowlist — drop non-https/non-localhost-http links
      // (data:, javascript:, file:, etc.). If invalid, render plain text.
      const registryUrl = registryUrlRaw ? safeImageOrLinkUrl(registryUrlRaw)?.toString() ?? null : null;
      const domain = sanitiseTagText(getTagValue(event, 'domain'), 253);

      setProfile({
        name,
        profession,
        activeSinceYear,
        issuanceCount: issuedEvents.length,
        registry,
        registryUrl,
        hasDomainAnchor: domain !== null,
        domain,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch verifier profile');
    } finally {
      setLoading(false);
    }
  }, [verifierPubkey]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Re-fetch when relay transitions to connected.
  // M8: fan-out listener, not a direct single-slot registration.
  useEffect(() => {
    if (!verifierPubkey) return;
    const unsubscribe = addStateListener((newState) => {
      if (newState === 'connected') {
        fetchProfile();
      }
    });
    return unsubscribe;
  }, [verifierPubkey, fetchProfile]);

  return { profile, loading, error };
}
