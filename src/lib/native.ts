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
  handshakeAwake(opts: { active: boolean }): Promise<void>;
  handshakeHaptic(opts: { beat: 'tick' | 'double' | 'thud' }): Promise<void>;
  /**
   * Handshake Bluetooth carrier (Android 12+, LE L2CAP CoC, no pairing). A
   * byte pipe only: JS authenticates the link and the contact SDK verifies
   * every message. `supported` is false below Android 12 or without LE
   * peripheral support; `permitted` is the Nearby devices permission.
   */
  nearbyStatus(): Promise<{ supported: boolean; enabled: boolean; permitted: boolean }>;
  nearbyPermission(): Promise<{ granted: boolean }>;
  /** The system "turn on Bluetooth" request. */
  nearbyEnable(): Promise<{ enabled: boolean }>;
  /** Listen on a fresh L2CAP channel and advertise `token` (8 bytes, base64) with its PSM. */
  nearbyAdvertise(opts: { token: string }): Promise<{ psm: number }>;
  /** Scan for `token`, then connect to the PSM it advertises. Resolves once connected. */
  nearbyConnect(opts: { token: string; timeoutMs: number }): Promise<{ link: string }>;
  nearbySend(opts: { link: string; data: string }): Promise<void>;
  /** The link authenticated: lift the frame cap from the handshake size to an event's. */
  nearbyTrust(opts: { link: string }): Promise<void>;
  /** `avoid`: the far end failed to authenticate; rescans skip that device. */
  nearbyClose(opts: { link: string; avoid?: boolean }): Promise<void>;
  /** Stop advertising and accepting; existing links carry on. */
  nearbyQuiet(): Promise<void>;
  /** Handshake NFC tap: host card emulation plus reader mode, alternating. */
  nfcStatus(): Promise<{ supported: boolean; enabled: boolean }>;
  /** Whether the activity is on screen right now (see app-foreground.ts). */
  lifecycleState(): Promise<{ state: 'background' | 'foreground' }>;
  /** Offer `code` (this screen's session code) to a phone held against this one, and read theirs. */
  nfcStart(opts: { code: string }): Promise<void>;
  nfcStop(): Promise<void>;
  addListener(eventName: 'nfcPeer', listener: (event: { code: string }) => void): Promise<PluginListenerHandle>;
  /** Stop advertising and scanning, close the channel and every link. */
  nearbyStop(): Promise<void>;
  addListener(eventName: 'nearbyLink', listener: (event: { link: string; direction: 'in' | 'out' }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'nearbyFrame', listener: (event: { link: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'nearbyClosed', listener: (event: { link: string }) => void): Promise<PluginListenerHandle>;
  /** The activity left or returned to the screen. On `background` the shell has already stopped the radio. */
  addListener(eventName: 'nearbyLifecycle', listener: (event: { state: 'background' | 'foreground' }) => void): Promise<PluginListenerHandle>;
  isBiometricAvailable(): Promise<{ available: boolean }>;
  /** Wrap the 64-hex master key with a biometric-gated Keystore key. */
  biometricEnroll(opts: { secret: string }): Promise<{ ok: boolean }>;
  /** BiometricPrompt → unwrap → return the exact same 64-hex string. */
  biometricUnlock(): Promise<{ secret: string }>;
  biometricClear(): Promise<void>;
  /** Whether the stored key also opens with the phone's own PIN, pattern or password. */
  biometricDeviceCredential(): Promise<{ allowed: boolean }>;
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
   * Contact pictures (APK): one https GET, no redirects/cookies/cache, body
   * capped at `maxBytes` while reading, answered by `timeoutMs` (+1 s) at the
   * latest. At most four run at once, off the plugin thread.
   */
  fetchImageCapped(opts: { url: string; maxBytes: number; timeoutMs: number }): Promise<NativeImageFetchResult>;
  /**
   * NIP-55: requests from other apps on this phone. The shell raises
   * `nip55Request` for each one while this page is up, and holds the ones
   * that arrived before it was; `nip55Pending` drains those.
   */
  nip55Pending(): Promise<{ requests: NativeNip55Request[] }>;
  /** The answer to one request. `deferred` tells a provider query to make the app ask by intent. */
  nip55Respond(opts: Nip55Response): Promise<void>;
  /** The page is frozen (Page Lifecycle `freeze`) or running again (`resume`): a frozen page cannot answer a provider query. */
  nip55PageFrozen(opts: { frozen: boolean }): Promise<void>;
  addListener(eventName: 'nip55Request', listener: (request: NativeNip55Request) => void): Promise<PluginListenerHandle>;
  /** A request's caller went away (task swiped, or the shell's own timeout fired); drop it unanswered. */
  addListener(eventName: 'nip55Withdrawn', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>;
}

export interface NativeImageFetchResult {
  ok: boolean;
  status?: number;
  /** The body, base64 (`ok` only). */
  base64?: string;
  /** Why it failed: 'status' | 'too-large' | 'timeout' | 'network' | 'not-https' | 'bad-url' | 'no-body' | 'error'. */
  reason?: string;
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
