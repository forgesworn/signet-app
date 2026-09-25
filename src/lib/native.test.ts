// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isNativeApp } from './native';

declare global {
  interface Window { Capacitor?: { isNativePlatform?: () => boolean } }
}

describe('isNativeApp', () => {
  afterEach(() => { delete (window as { Capacitor?: unknown }).Capacitor; });

  it('is false when window.Capacitor is absent (web build)', () => {
    expect(isNativeApp()).toBe(false);
  });

  it('is false when Capacitor exists but reports web platform', () => {
    window.Capacitor = { isNativePlatform: () => false };
    expect(isNativeApp()).toBe(false);
  });

  it('is true when Capacitor reports a native platform', () => {
    window.Capacitor = { isNativePlatform: () => true };
    expect(isNativeApp()).toBe(true);
  });

  it('is false when window is undefined (node-environment guard)', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(isNativeApp()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
