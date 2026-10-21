/**
 * A8: "the mark is gone" is sticky for the unlock.
 *
 * `heartwood_owner_status` answers `false` once, and a later read can fail
 * (`null`: "couldn't tell", never "off"). A failed refresh must not turn the
 * mark back into "unknown", or the backups held for the owner's approve-again
 * answer would be released, and the banner and the Settings button offering it
 * would vanish, with nobody having answered. So once `false` has been seen,
 * `null` reads as `false` until the device says `true`, or `active` goes false
 * (a lock, or no style on file). A decline is the caller's own `dismissed`.
 */
import { useEffect, useState } from 'react';

export function useStickyOwnerStatus(statusOwner: boolean | null, active: boolean): boolean | null {
  const [seenOff, setSeenOff] = useState(false);
  useEffect(() => {
    if (!active || statusOwner === true) setSeenOff(false);
    else if (statusOwner === false) setSeenOff(true);
  }, [statusOwner, active]);
  if (!active) return statusOwner;
  return statusOwner ?? (seenOff ? false : null);
}
