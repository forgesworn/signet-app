import { describe, expect, it } from 'vitest';
import { canOpenPlace } from './known-place-open';
import type { KnownPlace } from '../types/known-places';

const base: KnownPlace = {
  id: 'x:y', pubkey: 'a'.repeat(64), placeKey: 'x', kind: 'sign-in', name: 'x', channel: 'browser', signer: 'local',
  firstAt: 1, lastAt: 1, uses: 1, shared: {},
};

describe('canOpenPlace', () => {
  it('opens a phone app only on native with a package', () => {
    const app = { ...base, channel: 'phone-app' as const, nativePackage: 'org.x', origin: 'https://x.example' };
    expect(canOpenPlace(app, true)).toBe(true);
    expect(canOpenPlace(app, false)).toBe(false);
    expect(canOpenPlace({ ...app, nativePackage: undefined }, true)).toBe(false);
  });
  it('opens a browser place that has an origin', () => {
    expect(canOpenPlace({ ...base, origin: 'https://x.example' }, false)).toBe(true);
    expect(canOpenPlace({ ...base, origin: undefined }, true)).toBe(false);
  });
  it('opens nothing else', () => {
    for (const channel of ['other-device', 'nip46', 'nip55', 'unknown'] as const) {
      expect(canOpenPlace({ ...base, channel, origin: 'https://x.example', nativePackage: 'org.x' }, true)).toBe(false);
    }
  });
});
