// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNativeApp: vi.fn(() => true),
  SignetNative: {
    isBiometricAvailable: vi.fn(async () => ({ available: true })),
    biometricEnroll: vi.fn(async () => ({ ok: true })),
    biometricUnlock: vi.fn(async () => ({ secret: 'a'.repeat(64) })),
    biometricClear: vi.fn(async () => {}),
  },
}));
vi.mock('./native', () => mocks);

import { isBiometricAvailable, setupBiometric, authenticateBiometric } from './auth';

describe('auth native branches', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
  afterEach(() => { localStorage.clear(); });

  it('isBiometricAvailable delegates to the plugin on native', async () => {
    expect(await isBiometricAvailable()).toBe(true);
    expect(mocks.SignetNative.isBiometricAvailable).toHaveBeenCalled();
  });

  it('setupBiometric enrolls via plugin, sets method key, reports prfSupported', async () => {
    const key = 'a'.repeat(64);
    const res = await setupBiometric(key);
    expect(res).toEqual({ ok: true, prfSupported: true });
    expect(mocks.SignetNative.biometricEnroll).toHaveBeenCalledWith({ secret: key });
    expect(localStorage.getItem('signet-auth-method')).toBe('biometric');
    expect(localStorage.getItem('signet-auth-encrypted-key')).toBe(JSON.stringify({ native: true }));
  });

  it('authenticateBiometric returns the exact enrolled secret', async () => {
    await setupBiometric('a'.repeat(64));
    expect(await authenticateBiometric()).toBe('a'.repeat(64));
  });

  it('authenticateBiometric returns null when the prompt is cancelled', async () => {
    await setupBiometric('a'.repeat(64));
    mocks.SignetNative.biometricUnlock.mockRejectedValueOnce(new Error('cancelled'));
    expect(await authenticateBiometric()).toBeNull();
  });

  it('authenticateBiometric returns null when no record is stored (missing)', async () => {
    // No setup ran → no ENCRYPTED_KEY_KEY. Must not call the plugin.
    expect(await authenticateBiometric()).toBeNull();
    expect(mocks.SignetNative.biometricUnlock).not.toHaveBeenCalled();
  });

  it('authenticateBiometric rejects a web-era (WebAuthn) record on native, without decrypting', async () => {
    // A record written by the web PRF path lacks the `native: true` marker.
    localStorage.setItem('signet-auth-method', 'biometric');
    localStorage.setItem('signet-auth-encrypted-key', JSON.stringify({ encrypted: 'x', prf: true }));
    expect(await authenticateBiometric()).toBeNull();
    expect(mocks.SignetNative.biometricUnlock).not.toHaveBeenCalled();
  });

  it('authenticateBiometric returns null when the plugin yields a wrong-length secret', async () => {
    await setupBiometric('a'.repeat(64));
    mocks.SignetNative.biometricUnlock.mockResolvedValueOnce({ secret: 'tooshort' });
    expect(await authenticateBiometric()).toBeNull();
  });
});
