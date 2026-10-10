import { useSyncExternalStore } from 'react';
import { getRadioStatus, subscribeRadioStatus, type RadioStatus } from '../lib/radio-status';

/** NFC and Bluetooth state for the handshake, or null in a browser and until first read (see lib/radio-status.ts). */
export function useRadioStatus(): RadioStatus | null {
  return useSyncExternalStore(subscribeRadioStatus, getRadioStatus, () => null);
}
