/**
 * Hook: load, refresh, and publish a Pro-surface role-anchor record.
 *
 * The hook reads the kind-30201 event from the relay for the current pubkey
 * and exposes it as a ProRoleAnchorRecord (parsed from the event tags).
 *
 * Spec: the internal Pro-surface architecture design doc, §4.1, §6.7
 */

import { useState, useEffect, useCallback } from 'react';
import type { ProRoleAnchorRecord, RegistryId, ProfessionKind, Jurisdiction, IdentifierKind } from '../lib/professional/types';
import type { AnchorContext } from '../lib/professional/role-anchor';
import { buildRoleAnchorEvent } from '../lib/professional/role-anchor';
import type { SigningBackend } from '../lib/signing-backend';
import { publishEvent as publishToRelay, fetchEvents, addStateListener, getRelayState } from '../lib/relay-service';
import { PRO_ROLE_ANCHOR } from '../lib/professional/kinds';
import { verifiedAuthoredEvents } from '../lib/event-verify';

export interface UseProRoleAnchorResult {
  anchor: ProRoleAnchorRecord | null;
  isLoading: boolean;
  /** Re-fetch the role-anchor event from the relay. */
  refresh: () => void;
  /**
   * Sign and publish a new kind-30201 role-anchor event.
   * Call after a successful "Check my JSON".
   */
  publish: (
    backend: SigningBackend,
    ctx: AnchorContext,
    opts: { listedInDirectory: boolean }
  ) => Promise<void>;
}

function parseAnchorFromTags(
  tags: string[][],
  pubkey: string,
  eventId: string
): ProRoleAnchorRecord | null {
  const get = (name: string) => tags.find(t => t[0] === name)?.[1] ?? null;
  const professionKind = get('profession') as ProfessionKind | null;
  const jurisdiction = get('jurisdiction') as Jurisdiction | null;
  const registry = get('registry') as RegistryId | null;
  const identifier = get('identifier');
  const identifierKind = (get('identifierKind') ?? 'URN') as IdentifierKind;
  const entityName = get('entity');
  const canonicalDomain = get('domain');

  if (!professionKind || !jurisdiction || !registry || !identifier || !entityName || !canonicalDomain) {
    return null;
  }

  return {
    pubkey,
    professionKind,
    jurisdiction,
    registry,
    identifier,
    identifierKind,
    entityName,
    canonicalDomain,
    anchorEventId: eventId,
    verifiedAt: new Date().toISOString(),
    listedInDirectory: false,
  };
}

export function useProRoleAnchor(
  pubkey: string | null
): UseProRoleAnchorResult {
  const [anchor, setAnchor] = useState<ProRoleAnchorRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  const refresh = useCallback(() => setRefreshCounter(c => c + 1), []);

  const fetchAnchor = useCallback(async () => {
    if (!pubkey) return;
    if (getRelayState() !== 'connected') return;

    setIsLoading(true);
    try {
      const events = await fetchEvents([
        { kinds: [PRO_ROLE_ANCHOR], authors: [pubkey] } as never,
      ]);
      // Verify-then-pick (audit pass 4): filter the full list BEFORE
      // sorting. A hostile relay can ignore the `authors:` filter and
      // return one forged event with a doctored `created_at = now + N`
      // alongside the legitimate event; sorting first then verifying the
      // single candidate would let the forged event mask the legit one.
      const verified = verifiedAuthoredEvents(
        events as unknown as Array<{ pubkey: string; sig: string; id: string; created_at: number; tags: string[][] }>,
        pubkey,
      );
      const sorted = [...verified].sort((a, b) => b.created_at - a.created_at);
      const latest = sorted[0];
      if (latest) {
        const parsed = parseAnchorFromTags(latest.tags, pubkey, latest.id);
        setAnchor(parsed);
      } else {
        setAnchor(null);
      }
    } catch {
      // Non-fatal: leave anchor as-is
    } finally {
      setIsLoading(false);
    }
  }, [pubkey]);

  useEffect(() => {
    fetchAnchor();
  }, [fetchAnchor, refreshCounter]);

  // Re-fetch when relay transitions to connected (handles async connection timing).
  // M8: fan-out listener, not a direct single-slot registration — this hook
  // is mounted at App root and previously lost its refresh whenever another
  // hook (useRelay, useNostrEvents, useVerifierProfile) re-registered.
  useEffect(() => {
    if (!pubkey) return;
    const unsubscribe = addStateListener((newState) => {
      if (newState === 'connected') {
        fetchAnchor();
      }
    });
    return unsubscribe;
  }, [pubkey, fetchAnchor]);

  const publish = useCallback(async (
    backend: SigningBackend,
    ctx: AnchorContext,
    opts: { listedInDirectory: boolean }
  ) => {
    const template = buildRoleAnchorEvent(ctx);
    const unsigned = {
      ...template,
      pubkey: backend.activePublicKeyHex,
    };
    const signed = await backend.signEvent(unsigned);
    await publishToRelay(signed);
    // Optimistically update local state
    setAnchor({
      pubkey: ctx.leadPubkey,
      professionKind: ctx.professionKind,
      jurisdiction: ctx.jurisdiction,
      registry: ctx.registry,
      identifier: ctx.identifier,
      identifierKind: 'URN',
      entityName: ctx.entityName,
      canonicalDomain: ctx.canonicalDomain,
      anchorEventId: signed.id,
      verifiedAt: new Date().toISOString(),
      listedInDirectory: opts.listedInDirectory,
    });
    // Refresh from relay to confirm
    refresh();
  }, [refresh]);

  return { anchor, isLoading, refresh, publish };
}
