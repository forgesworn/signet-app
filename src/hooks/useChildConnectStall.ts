/**
 * A direct child's card says "Connecting…" while its Heartwood connection is
 * down; once it has been down for `CHILD_CONNECT_STALL_MS` while unlocked it
 * says the Heartwood cannot be reached (`childSignerKind`'s `stalled`). True
 * only after `down` has held for the whole delay; a lock or the connection
 * coming up (`down` false) clears it and starts the minute again.
 */
import { useEffect, useState } from 'react';
import { CHILD_CONNECT_STALL_MS } from '../lib/child-bunker';

export function useChildConnectStall(down: boolean, ms: number = CHILD_CONNECT_STALL_MS): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!down) return;
    const t = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(t);
  }, [down, ms]);
  return down && stalled;
}
