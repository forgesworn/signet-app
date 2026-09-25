import { useCallback, useEffect, useState } from 'react';
import type { KeypairToken, OriginPolicy } from '../types';
import { ORIGIN_POLICY_HISTORY_CAP } from '../types';
import {
  deleteOriginPolicy,
  getAllOriginPolicies,
  getOriginPolicy,
  normaliseOrigin,
  saveOriginPolicy,
} from '../lib/db';

/**
 * Per-origin identity-selection policy — memory, pinning, and a rolling
 * history of consumer-hint shapes (used for drift detection).
 *
 * Silent writes on sign-in approval; explicit writes when the user pins
 * or clears via the Connections page.
 */
export function useOriginPolicies() {
  const [policies, setPolicies] = useState<OriginPolicy[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const all = await getAllOriginPolicies();
    setPolicies(all.sort((a, b) => b.lastUsed - a.lastUsed));
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  /**
   * Record that the user just signed into `origin` with `keypairUsed`.
   * Preserves `pinned`, appends to `acceptHistory`, caps the buffer.
   */
  const recordSignIn = useCallback(async (
    origin: string,
    keypairUsed: string,
    opts?: { allow?: KeypairToken[]; userOverrode?: boolean },
  ) => {
    const key = normaliseOrigin(origin);
    if (!key) return;
    const now = Math.floor(Date.now() / 1000);
    const existing = await getOriginPolicy(key);
    const history = existing?.acceptHistory ?? [];
    const nextHistory = [
      ...history,
      { at: now, allow: opts?.allow ?? [] },
    ].slice(-ORIGIN_POLICY_HISTORY_CAP);
    const next: OriginPolicy = {
      origin: key,
      lastKeypair: keypairUsed,
      lastUsed: now,
      pinned: existing?.pinned ?? false,
      userOverrode: opts?.userOverrode ?? existing?.userOverrode ?? false,
      acceptHistory: nextHistory,
    };
    await saveOriginPolicy(next);
    await refresh();
  }, [refresh]);

  /** Toggle (or set) a pin on an origin. Pinned origins override consumer hints. */
  const setPinned = useCallback(async (origin: string, pinned: boolean) => {
    const key = normaliseOrigin(origin);
    if (!key) return;
    const existing = await getOriginPolicy(key);
    if (!existing) return;
    await saveOriginPolicy({ ...existing, pinned });
    await refresh();
  }, [refresh]);

  /** Forget an origin entirely — clears memory, pin, and history. */
  const clear = useCallback(async (origin: string) => {
    await deleteOriginPolicy(origin);
    await refresh();
  }, [refresh]);

  return { policies, loading, recordSignIn, setPinned, clear, refresh };
}
