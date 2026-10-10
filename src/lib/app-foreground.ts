import { isNativeApp, SignetNative } from './native';

/**
 * Whether the app is actually on screen, for hooks and plain callbacks alike.
 *
 * The page's own visibility is not enough on the APK: the always-on bunker
 * briefly marks a backgrounded page visible every 30 s (MainActivity) so that
 * Chromium does not freeze it. So it is combined with the native shell's
 * start/stop, read once at start-up (an event sent before anyone listened is
 * not replayed) and then followed. In a browser it is just the visibility.
 */
let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
let shown = true, started = false, heardEvent = false;
const listeners = new Set<() => void>();
function set(nextVisible: boolean, nextShown: boolean) {
  if (nextVisible === visible && nextShown === shown) return;
  visible = nextVisible; shown = nextShown;
  for (const listener of [...listeners]) listener();
}
function start() {
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', () => set(document.visibilityState !== 'hidden', shown));
  if (!isNativeApp()) return;
  void SignetNative.addListener('nearbyLifecycle', e => { heardEvent = true; set(visible, e.state !== 'background'); }).catch(() => {});
  void SignetNative.lifecycleState().then(r => { if (!heardEvent) set(visible, r.state !== 'background'); }).catch(() => {});
}
export function isAppInForeground(): boolean { start(); return visible && shown; }
export function subscribeAppForeground(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Tests only: forget everything, as on a fresh page. */
export function resetAppForegroundForTests(): void {
  visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  shown = true; started = false; heardEvent = false; listeners.clear();
}
