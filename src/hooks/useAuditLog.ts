/**
 * One-shot fetch of the audit log for a given dependant.
 *
 * Audit isn't high-frequency — a guardian doesn't need a live websocket
 * for their kid's sign-ins to drip in. We pull on mount + on explicit
 * refresh and unsubscribe immediately.
 *
 * Two modes:
 *   - **guardian** (v1): `recipientPubkey` is the guardian's pubkey,
 *     `decrypt: { kind: 'backend', backend }` uses the guardian's
 *     NIP-44 decrypt path.
 *   - **child** (v2): `recipientPubkey` is the dep's NIP-46 client
 *     pubkey, `decrypt: { kind: 'privkey', hex }` uses the
 *     paired-child device's bunker client privkey directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RelayClient } from 'signet-protocol';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  unwrapAuditEvent,
  unwrapAuditEventWithKey,
  parseAuditRumor,
  type AuditEntry,
  type AuditRumor,
} from '../lib/audit-fetch';
import { isValidRelayUrl } from '../lib/relay-url';
import type { NostrEvent } from 'signet-protocol';

const FETCH_LIMIT = 200;

/**
 * Decrypt strategy for the audit log fetch. The guardian path uses a
 * `DecryptingSigningBackend` because the guardian's privkey may live
 * behind a remote signer (NIP-46 / NIP-07). The child path holds the
 * raw client privkey on-device — passing it directly avoids the
 * ceremony of standing up a `LocalSigningBackend` just for this hook.
 */
export type AuditDecryptStrategy =
  | { kind: 'backend'; backend: DecryptingSigningBackend }
  | { kind: 'privkey'; hex: string };

interface UseAuditLogParams {
  /** The dependant we're showing activity for — primary signing pubkey. */
  dependantId: string;
  /**
   * Pubkey that audit gift-wraps are addressed to. Guardian pubkey
   * for guardian-mode; the dep's NIP-46 client pubkey for child-mode
   * (the second wrap in the dual-address publish).
   */
  recipientPubkey: string;
  /**
   * The guardian's real signing pubkey — the only identity that
   * legitimately authors audit rumors (see `audit.ts`). Every unwrapped
   * seal/rumor is checked against this and rejected on mismatch (C1).
   * Same value for both guardian-mode and child-mode, since both wraps
   * are sealed by the guardian.
   */
  expectedSignerPubkey: string;
  /**
   * Decrypt strategy. Pass `null` while the app is locked / inputs
   * aren't ready — the hook stays idle until something appears.
   */
  decrypt: AuditDecryptStrategy | null;
  /** Relay URL — wss:// or ws://localhost. Must already pass scheme check. */
  relayUrl: string;
}

interface UseAuditLogReturn {
  entries: AuditEntry[];
  loading: boolean;
  error: string | null;
  /** Re-runs the fetch end-to-end. Resolves once entries / error settle. */
  refresh: () => Promise<void>;
}

export function useAuditLog({
  dependantId,
  recipientPubkey,
  expectedSignerPubkey,
  decrypt,
  relayUrl,
}: UseAuditLogParams): UseAuditLogReturn {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the latest fetch generation so a slow earlier fetch can't clobber
  // a fresh one (e.g. user hits Refresh while the first call is still in
  // flight). Without this guard the entries flicker.
  const fetchGen = useRef(0);

  const fetchOnce = useCallback(async () => {
    const myGen = ++fetchGen.current;

    if (!decrypt) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!isValidRelayUrl(relayUrl)) {
      setError('Invalid relay URL');
      setLoading(false);
      return;
    }
    if (!/^[0-9a-f]{64}$/i.test(recipientPubkey)) {
      setError('Invalid recipient pubkey');
      setLoading(false);
      return;
    }
    if (!/^[0-9a-f]{64}$/i.test(dependantId)) {
      setError('Invalid dependant pubkey');
      setLoading(false);
      return;
    }
    if (!/^[0-9a-f]{64}$/i.test(expectedSignerPubkey)) {
      setError('Invalid guardian pubkey');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const relay = new RelayClient(relayUrl);
    try {
      await relay.connect();
      const events = await relay.fetch([{
        kinds: [1059],
        '#p': [recipientPubkey],
        limit: FETCH_LIMIT,
      } as never]);

      // Decrypt + parse in JS. Skip anything that fails decrypt or doesn't
      // look like an audit rumor — gift-wraps to the recipient include
      // legitimate non-audit traffic too (DMs, attestations).
      const parsed: AuditEntry[] = [];
      for (const wrap of events) {
        const rumor: AuditRumor | null = decrypt.kind === 'backend'
          ? await unwrapAuditEvent(wrap as NostrEvent, decrypt.backend, expectedSignerPubkey)
          : await unwrapAuditEventWithKey(wrap as NostrEvent, decrypt.hex, expectedSignerPubkey);
        if (!rumor) continue;
        const entry = parseAuditRumor(rumor);
        if (!entry) continue;
        if (entry.dependantPubkey !== dependantId.toLowerCase()) continue;
        parsed.push(entry);
      }

      // Late-arriving fetch — drop.
      if (myGen !== fetchGen.current) return;

      parsed.sort((a, b) => b.createdAt - a.createdAt);
      setEntries(parsed);
    } catch (err) {
      if (myGen !== fetchGen.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      if (myGen === fetchGen.current) setLoading(false);
      relay.disconnect();
    }
  }, [dependantId, recipientPubkey, expectedSignerPubkey, decrypt, relayUrl]);

  // Fetch on mount and whenever any of the inputs change.
  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  return { entries, loading, error, refresh: fetchOnce };
}
