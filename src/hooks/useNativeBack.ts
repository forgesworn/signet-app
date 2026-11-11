import { useEffect, useRef } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { isNativeApp } from '../lib/native';

/**
 * Android back gesture / button for screens that move between steps in local
 * state rather than through history (onboarding, first-run setup, pairing).
 *
 * Capacitor's default back pops WebView history and does nothing when there
 * is none. These screens push no history, so without this a back swipe from
 * (say) "Connect your remote signer" did nothing at all.
 *
 * Pass the step's back action, or null where Capacitor's default should
 * apply (a root screen). A no-op function swallows the gesture, for a step
 * whose on-screen Back is hidden or disabled. Only the most recently
 * activated handler runs, so a child screen can take over from its host and
 * hand back when it passes null. While any handler is active Capacitor's
 * default is off; once none is, it returns. No-op outside the native app.
 */
const stack: Array<{ current: (() => void) | null }> = [];
let listener: Promise<PluginListenerHandle> | null = null;
// Bumped whenever the listener is dropped, so one whose async removal is
// still pending can't also fire alongside a newer one.
let generation = 0;

function syncListener(): void {
  if (stack.length > 0 && !listener) {
    const mine = ++generation;
    listener = CapacitorApp.addListener('backButton', () => {
      if (mine !== generation) return;
      stack[stack.length - 1]?.current?.();
    });
  } else if (stack.length === 0 && listener) {
    generation++;
    const old = listener;
    listener = null;
    void old.then(h => h.remove()).catch(() => { /* already gone */ });
  }
}

export function useNativeBack(handler: (() => void) | null): void {
  const ref = useRef(handler);
  ref.current = handler;
  const active = handler !== null;
  useEffect(() => {
    if (!active || !isNativeApp()) return;
    stack.push(ref);
    syncListener();
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
      syncListener();
    };
  }, [active]);
}
