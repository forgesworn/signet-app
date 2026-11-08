import { describe, it, expect } from 'vitest';
import { BROWSER_PACKAGES, deriveSignInChannel, deriveSigner } from './known-place-channel';

describe('BROWSER_PACKAGES', () => {
  it('is a non-empty list of unique package names including the common browsers', () => {
    expect(BROWSER_PACKAGES.length).toBe(14);
    expect(new Set(BROWSER_PACKAGES).size).toBe(BROWSER_PACKAGES.length);
    expect(BROWSER_PACKAGES).toContain('com.android.chrome');
    expect(BROWSER_PACKAGES).toContain('app.vanadium.browser');
  });
});

describe('deriveSignInChannel', () => {
  it('relay without a URL arrival is another device (QR scan / WebVerify)', () => {
    expect(deriveSignInChannel({ isRelayMode: true, urlArrived: false, native: true })).toBe('other-device');
    expect(deriveSignInChannel({ isRelayMode: true, urlArrived: false, native: false })).toBe('other-device');
  });
  it('a URL arrival with relay delivery on the same phone is not another device', () => {
    expect(deriveSignInChannel({ isRelayMode: true, urlArrived: true, referrerPackage: 'com.game.app', native: true })).toBe('phone-app');
  });
  it('an app package referrer is a phone app', () => {
    expect(deriveSignInChannel({ isRelayMode: false, urlArrived: true, referrerPackage: 'com.kithmoot.app', native: true })).toBe('phone-app');
  });
  it('a browser package referrer is a browser', () => {
    expect(deriveSignInChannel({ isRelayMode: false, urlArrived: true, referrerPackage: 'org.mozilla.firefox', native: true })).toBe('browser');
  });
  it('a URL arrival on the web build is a browser', () => {
    expect(deriveSignInChannel({ isRelayMode: false, urlArrived: true, native: false })).toBe('browser');
  });
  it('a native URL arrival with no referrer is unknown', () => {
    expect(deriveSignInChannel({ isRelayMode: false, urlArrived: true, native: true })).toBe('unknown');
    expect(deriveSignInChannel({ isRelayMode: false, urlArrived: true, referrerPackage: '  ', native: true })).toBe('unknown');
  });
  it('a request that neither used a relay nor arrived as a URL is unknown', () => {
    expect(deriveSignInChannel({ isRelayMode: false, urlArrived: false, native: true })).toBe('unknown');
  });
});

describe('deriveSigner', () => {
  it('maps backend types', () => {
    expect(deriveSigner('local', false)).toBe('local');
    expect(deriveSigner('bunker', true)).toBe('heartwood');
    expect(deriveSigner('bunker', false)).toBe('remote-signer');
    expect(deriveSigner('nip07', false)).toBe('extension');
    expect(deriveSigner(undefined, true)).toBe('unknown');
    expect(deriveSigner('other', true)).toBe('unknown');
  });
});
