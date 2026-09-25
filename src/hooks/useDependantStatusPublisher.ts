/**
 * Guardian-side dependant-status publisher.
 *
 * Watches each paired dependant for `autonomyStage` changes and
 * publishes a NIP-44-encrypted kind-30078 status event to the child's
 * transport pubkey. Signs with the guardian's per-dependant endpoint
 * keypair — the same cryptographic identity the child already trusts.
 *
 * Publishes happen:
 *   - On first mount, for every dependant with a bound transport
 *     pubkey (`authorizedClientPubkey`) and a known stage. Seeds the
 *     cache on the child device without waiting for a stage edit.
 *   - On every subsequent stage change. The event is replaceable, so
 *     one publish per transition is enough.
 *
 * Debounced at 1s to coalesce rapid toggles in the stage settings UI.
 */

import { useEffect, useRef } from 'react';
import type { DependantIdentity } from '../types';
import { LocalSigningBackend } from '../lib/signing-backend';
import { publishDependantStatus } from '../lib/dependant-status-sync';

const PUBLISH_DEBOUNCE_MS = 1000;

interface Options {
  /** Current dependants list — the hook reacts to changes in stage / endpoint / bound client. */
  dependants: DependantIdentity[];
  relayUrl: string;
  encryptionKey: string | null;
  /**
   * Guardian display name, surfaced in the child's dormant copy so it
   * reads "Ask [Mum] to sign for you" rather than the generic "your
   * guardian". Carried in the payload itself for cheap propagation.
   */
  guardianName?: string;
}

/** Stable hash for publish idempotency — avoids re-publishing identical state. */
function publishHashFor(dep: DependantIdentity, guardianName: string | undefined): string {
  const clientPubkey = dep.bunkerEndpoint?.authorizedClientPubkey ?? '';
  return JSON.stringify({
    id: dep.id,
    stage: dep.autonomyStage,
    client: clientPubkey,
    guardianName: guardianName ?? '',
  });
}

export function useDependantStatusPublisher({ dependants, relayUrl, encryptionKey, guardianName }: Options) {
  // Per-dependant hashes of the last-published state. Keyed by dependant id.
  const lastPublishedRef = useRef<Map<string, string>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!relayUrl || !encryptionKey) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      for (const dep of dependants) {
        const endpoint = dep.bunkerEndpoint;
        if (!endpoint?.privateKey || !endpoint?.authorizedClientPubkey) continue;
        if (!dep.autonomyStage) continue;

        const hash = publishHashFor(dep, guardianName);
        if (lastPublishedRef.current.get(dep.id) === hash) continue;

        let backend: LocalSigningBackend;
        try {
          backend = new LocalSigningBackend(endpoint.privateKey);
        } catch {
          // Invalid privkey — skip this dependant silently. Next render may
          // have better state (e.g. the endpoint was just rotated).
          continue;
        }

        const ok = await publishDependantStatus(
          {
            childTransportPubkey: endpoint.authorizedClientPubkey,
            stage: dep.autonomyStage,
            updatedAt: Math.floor(Date.now() / 1000),
            guardianName,
          },
          backend,
          relayUrl,
        );
        if (ok) lastPublishedRef.current.set(dep.id, hash);
      }
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [dependants, relayUrl, encryptionKey, guardianName]);
}
