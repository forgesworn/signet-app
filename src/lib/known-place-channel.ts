// Pure derivation of how a sign-in reached this phone and which signer
// approved it. Display facts only — the launching package is UNTRUSTED
// (the launching app can set it to anything), so nothing here is a trust
// input. It decides a label and whether an "Open" button is offered.

import type { KnownPlaceChannel, KnownPlaceSigner } from '../types';

/** Known Android browser packages; a link opened by one of these came from a web page. */
export const BROWSER_PACKAGES: readonly string[] = [
  'com.android.chrome',
  'org.chromium.chrome',
  'app.vanadium.browser',
  'org.mozilla.firefox',
  'org.mozilla.fenix',
  'com.brave.browser',
  'com.microsoft.emmx',
  'com.opera.browser',
  'com.sec.android.app.sbrowser',
  'com.duckduckgo.mobile.android',
  'org.torproject.torbrowser',
  'com.kiwibrowser.browser',
  'com.vivaldi.browser',
  'com.android.browser',
];

const BROWSER_SET: ReadonlySet<string> = new Set(BROWSER_PACKAGES);

export interface SignInChannelInput {
  /** The request carried a relay (cross-device delivery). */
  isRelayMode: boolean;
  /** The request arrived as a URL on this device (not a QR scan / WebVerify). */
  urlArrived: boolean;
  /** Package that launched the link; untrusted, native only. */
  referrerPackage?: string | null;
  native: boolean;
}

export function deriveSignInChannel(input: SignInChannelInput): KnownPlaceChannel {
  const { isRelayMode, urlArrived, referrerPackage, native } = input;
  // The SDK uses relay delivery even for a same-phone app opened by link, so
  // relay mode alone does not mean another device: a URL arrival is same-phone.
  if (isRelayMode && !urlArrived) return 'other-device';
  if (urlArrived) {
    const pkg = typeof referrerPackage === 'string' ? referrerPackage.trim() : '';
    if (pkg) return BROWSER_SET.has(pkg) ? 'browser' : 'phone-app';
    if (!native) return 'browser';
  }
  return 'unknown';
}

export type SigningBackendType = 'local' | 'bunker' | 'nip07' | string | undefined;

export function deriveSigner(backendType: SigningBackendType, bunkerRouterPresent: boolean): KnownPlaceSigner {
  if (backendType === 'local') return 'local';
  if (backendType === 'bunker') return bunkerRouterPresent ? 'heartwood' : 'remote-signer';
  if (backendType === 'nip07') return 'extension';
  return 'unknown';
}
