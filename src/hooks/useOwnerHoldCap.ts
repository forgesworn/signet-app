/**
 * A8: the cap on "backups wait for the Heartwood's owner-status answer".
 *
 * `raw` is the hold as `ownerOfferState` computes it (it is already false when
 * the app is locked). The cap clock starts only once the Heartwood is
 * connected, so it bounds the probe and the status wait, not the time spent on
 * the lock screen or typing the PIN. When `raw` turns false (a lock, or the
 * answer arriving) the lapse is forgotten, so the next unlock holds again for
 * a full cap from connect.
 */
import { useEffect, useState } from 'react';

export function useOwnerHoldCap(raw: boolean, connected: boolean, capMs: number): boolean {
  const [lapsed, setLapsed] = useState(false);
  useEffect(() => {
    if (!raw) { setLapsed(false); return; }
    if (!connected) return;
    const timer = setTimeout(() => setLapsed(true), capMs);
    return () => clearTimeout(timer);
  }, [raw, connected, capMs]);
  return raw && !lapsed;
}
