import { useSyncExternalStore } from 'react';
import { isAppInForeground, subscribeAppForeground } from '../lib/app-foreground';

/** True while the app is actually on screen (see lib/app-foreground.ts).
 * Pollers that can wait until the user returns pause while this is false. */
export function useAppForeground(): boolean {
  return useSyncExternalStore(subscribeAppForeground, isAppInForeground, () => true);
}
