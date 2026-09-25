// Native (Capacitor) platform detection + the SignetNative plugin bridge.
//
// isNativeApp() deliberately reads the global injected by the Capacitor
// Android runtime instead of importing @capacitor/core at module scope —
// the web bundle's behaviour must be provably identical with or without
// this module in the graph.
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { NativeNip55Request } from './nip55';

export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

export interface SignetNativePlugin {
  isBiometricAvailable(): Promise<{ available: boolean }>;
  /** Wrap the 64-hex master key with a biometric-gated Keystore key. */
  biometricEnroll(opts: { secret: string }): Promise<{ ok: boolean }>;
  /** BiometricPrompt → unwrap → return the exact same 64-hex string. */
  biometricUnlock(): Promise<{ secret: string }>;
  biometricClear(): Promise<void>;
  startBunkerService(opts: { pubkeysCsv: string; relayUrl: string }): Promise<void>;
  stopBunkerService(): Promise<void>;
  startTemporaryBunkerService(opts: { pubkeysCsv: string; relayUrl: string; durationMs: number }): Promise<void>;
  stopTemporaryBunkerService(): Promise<void>;
  returnToPreviousApp(): Promise<void>;
  /** Liveness ping: JS bunker is serving; also refreshes fallback-poll config. */
  serviceHeartbeat(opts: { pubkeysCsv: string; relayUrl: string }): Promise<void>;
  isBatteryExempt(): Promise<{ exempt: boolean }>;
  requestBatteryExemption(): Promise<void>;
  requestCameraPermission(): Promise<{ granted: boolean }>;
  /**
   * NIP-55: requests from other apps on this phone. The shell raises
   * `nip55Request` for each one while this page is up, and holds the ones
   * that arrived before it was; `nip55Pending` drains those.
   */
  nip55Pending(): Promise<{ requests: NativeNip55Request[] }>;
  /** The answer to one request. `deferred` tells a provider query to make the app ask by intent. */
  nip55Respond(opts: Nip55Response): Promise<void>;
  addListener(eventName: 'nip55Request', listener: (request: NativeNip55Request) => void): Promise<PluginListenerHandle>;
}

export interface Nip55Response {
  id: string;
  status: 'ok' | 'rejected' | 'deferred';
  /** `get_public_key`: the npub. The crypto methods: the ciphertext or plaintext. `sign_event`: the signature. */
  result?: string;
  /** `sign_event`: the whole signed event as JSON. */
  event?: string;
}

export const SignetNative = registerPlugin<SignetNativePlugin>('SignetNative');
