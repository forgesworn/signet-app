import { describe, it, expect } from 'vitest';
import { mergeKnownPlace } from './known-places';
import type { KnownPlace, KnownPlaceInput } from '../types';

const PK = 'a'.repeat(64);

describe('mergeKnownPlace', () => {
  const existing: KnownPlace = {
    id: `https://x.example:${PK}`, placeKey: 'https://x.example', pubkey: PK, kind: 'sign-in',
    name: 'X', origin: 'https://x.example', channel: 'phone-app', nativePackage: 'org.x',
    signer: 'local', shared: { handle: false }, alias: 'Mine', pinned: true,
    firstAt: 10, lastAt: 20, uses: 2,
  } as KnownPlace;

  it('a new channel clears a stale nativePackage and keeps firstAt, alias and pinned', () => {
    const input = {
      placeKey: 'https://x.example', pubkey: PK, kind: 'sign-in', name: 'X',
      origin: 'https://x.example', channel: 'browser', signer: 'local', shared: { handle: false },
    } as KnownPlaceInput;
    const merged = mergeKnownPlace(existing, input, 30);
    expect(merged.nativePackage).toBeUndefined();
    expect('nativePackage' in merged).toBe(false);
    expect(merged.channel).toBe('browser');
    expect(merged).toMatchObject({ firstAt: 10, lastAt: 30, uses: 3, alias: 'Mine', pinned: true });
  });

  it('takes the incoming package and clears an absent origin', () => {
    const input = {
      placeKey: 'https://x.example', pubkey: PK, kind: 'sign-in', name: 'X',
      channel: 'phone-app', nativePackage: 'org.y', signer: 'local', shared: { handle: false },
    } as KnownPlaceInput;
    const merged = mergeKnownPlace(existing, input, 30);
    expect(merged.nativePackage).toBe('org.y');
    expect('origin' in merged).toBe(false);
  });
});
