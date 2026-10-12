import { useCallback, useEffect, useRef, useState } from 'react';
import { ChildPairTap, type ChildPairTapOptions, type ChildPairTapState, type TapBeginOptions } from '../lib/child-pair-tap';

/**
 * React face of `ChildPairTap`, for both phones of a tap-and-Bluetooth child
 * pairing: a fresh session keypair per attempt (secret zeroed when it ends),
 * NFC armed and re-armed, tapped codes classified, the Bluetooth link, the
 * screen kept on, and whether the radios can be used at all (`available` +
 * `reason`, so a screen can lead with the tap or fall back to the QR code).
 *
 * The attempt ends on `end()`, and on unmount. Nothing here decides anything
 * about the pairing; the owner of the ceremony reads `tap` (events, offers).
 */
export interface UseChildPairNearby extends ChildPairTapState {
  /** The underlying object: stable for the life of the component. */
  tap: ChildPairTap;
  /** Check NFC and Bluetooth support without starting anything. Resolves with the resulting state. */
  probe(): Promise<ChildPairTapState>;
  begin(options?: TapBeginOptions): Promise<boolean>;
  end(): void;
}

export function useChildPairNearby(options: ChildPairTapOptions = {}): UseChildPairNearby {
  const optsRef = useRef(options);
  optsRef.current = options;
  const mounted = useRef(true);
  const [state, setState] = useState<ChildPairTapState>({ phase: 'idle', available: null, secondPhone: false, wrongScreen: null });
  const tapRef = useRef<ChildPairTap | null>(null);
  if (!tapRef.current) {
    tapRef.current = new ChildPairTap(() => optsRef.current, s => { if (mounted.current) setState(s); });
  }
  const tap = tapRef.current;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; tap.end(); };
  }, [tap]);

  const probe = useCallback(() => tap.probe(), [tap]);
  const begin = useCallback((o?: TapBeginOptions) => tap.begin(o), [tap]);
  const end = useCallback(() => tap.end(), [tap]);
  return { ...state, tap, probe, begin, end };
}
