import { useEffect } from 'react';
import { defaultGuardianBackdropDeps, slotsOf, syncGuardianBackdrops, type IdentityView } from '../lib/guardian-backdrop-sync';

/**
 * Child's phone only: keep the card backdrops a guardian set in step with the
 * stored identity. Runs on unlock and again whenever a slot's backdrop pointer
 * or the set of slots changes (`onInventoryMerged` reloads the identity), and
 * stops at lock (the caller disables it) and retries on every merge. See `guardian-backdrop-sync.ts`.
 */
export function useGuardianBackdrops({ enabled, identity, mergeCount = 0 }: {
  enabled: boolean;
  identity: IdentityView | null;
  /** Bumped after every inventory merge, so a fetch that failed is retried on the next apply even when no pointer changed. */
  mergeCount?: number;
}): void {
  // A value, not the identity object: the effect re-runs on a pointer or slot change, not every render.
  const fingerprint = identity
    ? JSON.stringify([identity.id, slotsOf(identity).map(s => [s.pubkey, s.pointer?.hash ?? '', s.pointer?.blossomUrl ?? '', s.pointer?.keyHex ?? ''])])
    : '';

  useEffect(() => {
    if (!enabled || !identity) return;
    let live = true;
    void syncGuardianBackdrops(identity, defaultGuardianBackdropDeps(() => live));
    return () => { live = false; };
    // `fingerprint` captures everything the sync reads from `identity`.
  }, [enabled, fingerprint, mergeCount]);
}
