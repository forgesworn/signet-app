import type { KnownPlaceActions } from '../components/KnownPlaceRow';

const REFUSED = 'This needs the guardian. Exit child mode with the guardian\'s PIN first.';

/**
 * The places actions as the child gets them: Open only. The row hides the other
 * buttons already; this is the second lock, so a stale or forged call reaches
 * no standing grant, no guardian-wide store and not the Heartwood operator key.
 */
export function readOnlyPlaceActions(actions: KnownPlaceActions): KnownPlaceActions {
  const refuse = async (): Promise<void> => { throw new Error(REFUSED); };
  return {
    pin: refuse, setAlias: refuse, setAuto: refuse, forget: refuse, disconnect: refuse, revokeOnHeartwood: refuse,
    open: actions.open,
  };
}
