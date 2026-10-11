import type { PluginListenerHandle } from '@capacitor/core';
import { isAppInForeground, subscribeAppForeground } from './app-foreground';
import { isNativeApp, SignetNative } from './native';

/** 'none': no such hardware, or an OS too old for it. Bluetooth 'denied': the Nearby devices permission is missing. */
export type RadioStatus = { nfc: 'on' | 'off' | 'none'; bluetooth: 'on' | 'off' | 'denied' | 'none' };
type Nfc = { supported: boolean; enabled: boolean };
type Nearby = { supported: boolean; enabled: boolean; permitted: boolean };

export function radioStatusFrom(nfc: Nfc, nearby: Nearby): RadioStatus {
  return {
    nfc: !nfc.supported ? 'none' : nfc.enabled ? 'on' : 'off',
    bluetooth: !nearby.supported ? 'none' : !nearby.permitted ? 'denied' : nearby.enabled ? 'on' : 'off',
  };
}

/**
 * What this phone's NFC and Bluetooth can do for a handshake right now. Null in
 * a browser. There are no timers: it re-reads on the system's radio broadcast
 * and when the app comes back to the screen (the only way a permission changed
 * in app settings is seen). Native is queried only while someone is subscribed.
 */
let status: RadioStatus | null = null;
let nfcRaw: Nfc | null = null, nearbyRaw: Nearby | null = null;
let generation = 0;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;
function publish() {
  if (!nfcRaw || !nearbyRaw) return;
  const next = radioStatusFrom(nfcRaw, nearbyRaw);
  if (status && status.nfc === next.nfc && status.bluetooth === next.bluetooth) return;
  status = next;
  for (const listener of [...listeners]) listener();
}
export function refreshRadioStatus(): void {
  if (!isNativeApp() || !detach) return;
  const mine = generation;
  void Promise.all([SignetNative.nfcStatus(), SignetNative.nearbyStatus()]).then(([nfc, nearby]) => {
    if (mine !== generation) return;
    nfcRaw = nfc; nearbyRaw = nearby; publish();
  }).catch(() => {});
}
function attach() {
  generation++;
  const mine = generation;
  let handle: PluginListenerHandle | undefined;
  let stopped = false;
  void SignetNative.addListener('radioState', e => { if (mine === generation) { nfcRaw = e.nfc; nearbyRaw = e.bluetooth; publish(); } })
    .then(h => { if (stopped) void h.remove(); else handle = h; }).catch(() => {});
  const unforeground = subscribeAppForeground(() => { if (isAppInForeground()) refreshRadioStatus(); });
  detach = () => { stopped = true; generation++; unforeground(); void handle?.remove(); };
  refreshRadioStatus();
}
export function subscribeRadioStatus(listener: () => void): () => void {
  if (!isNativeApp()) return () => {};
  listeners.add(listener);
  if (!detach) attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach) { detach(); detach = null; status = null; nfcRaw = nearbyRaw = null; }
  };
}
export function getRadioStatus(): RadioStatus | null { return isNativeApp() ? status : null; }
