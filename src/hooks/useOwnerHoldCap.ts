/**
 * A8: the cap on "backups wait for the Heartwood's owner-status answer".
 *
 * `raw` is the hold as `ownerOfferState` computes it (it is already false when
 * the app is locked). The cap clock starts only once the Heartwood is
 * connected, so it bounds the probe and the status wait, not the time spent on
 * the lock screen or typing the PIN. When `raw` turns false (a lock, or the
 * answer arriving) the lapse is forgotten, so the next unlock holds again for
 * a full cap from connect.
 *
 * `untilAnswered` is the A8 hold that waits for the OWNER (the mark is gone and
 * the re-approve prompt is open). The cap never releases it: it ends only when
 * the caller stops passing it (the hold worked, the prompt was declined, or a
 * lock). It is part of `raw`, and is simply kept out of the cap's clock.
 */
import { useEffect, useState } from 'react';

export function useOwnerHoldCap(raw: boolean, connected: boolean, capMs: number, untilAnswered = false): boolean {
  const [lapsed, setLapsed] = useState(false);
  const capped = raw && !untilAnswered;
  useEffect(() => {
    if (!capped) { setLapsed(false); return; }
    if (!connected) return;
    const timer = setTimeout(() => setLapsed(true), capMs);
    return () => clearTimeout(timer);
  }, [capped, connected, capMs]);
  return raw && (untilAnswered || !lapsed);
}
