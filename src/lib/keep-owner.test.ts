import { describe, expect, it } from 'vitest';
import { heartwoodLookupKey, keepLookupGroups } from './keep-owner';
import type { StoredKeep } from './keep-store';

const MASTER = 'c3'.repeat(32), LIVE = 'd4'.repeat(32), P1 = 'a1'.repeat(32), P2 = 'b2'.repeat(32), P3 = 'e5'.repeat(32);

describe('heartwoodLookupKey', () => {
  it('is null unless the install is a bunker one, even if a bunker address is lying around', () => {
    expect(heartwoodLookupKey({ signingMode: 'local', bunkerUri: `bunker://${MASTER}?relay=wss://r`, liveSignerPubkey: LIVE })).toBeNull();
    expect(heartwoodLookupKey({ bunkerUri: `bunker://${MASTER}?relay=wss://r` })).toBeNull();
  });

  it('bunker install: the live signer key, one key only', () => {
    expect(heartwoodLookupKey({
      signingMode: 'bunker', bunkerUri: `bunker://${MASTER}?relay=wss%3A%2F%2Frelay.example`, liveSignerPubkey: LIVE.toUpperCase(),
    })).toBe(LIVE);
  });

  it('bunker install, not yet connected: the key in the stored address; junk gives null', () => {
    expect(heartwoodLookupKey({ signingMode: 'bunker', bunkerUri: `bunker://${MASTER.toUpperCase()}?relay=wss%3A%2F%2Fr` })).toBe(MASTER);
    expect(heartwoodLookupKey({ signingMode: 'bunker', bunkerUri: 'bunker://nope', liveSignerPubkey: '' })).toBeNull();
  });
});

const saved = (claimedBy: string, personas: string[]) => ({ claimedBy, personas } as unknown as StoredKeep);

describe('keepLookupGroups', () => {
  it('is empty with nothing saved and nothing remembered', () => {
    expect(keepLookupGroups([], [])).toEqual([]);
  });

  it('one group per saved Keep with only its own keys, never a union', () => {
    expect(keepLookupGroups([saved(P1, [P1, P2]), saved(P3, [P3])], [])).toEqual([[P1, P2].sort(), [P3]]);
  });

  it('asks once for identical key sets', () => {
    expect(keepLookupGroups([saved(P1, [P1]), saved(P1, [P1])], [])).toEqual([[P1]]);
  });

  it('a remembered key is asked alone, and not again when a saved Keep already covers it', () => {
    expect(keepLookupGroups([saved(P1, [P1])], [MASTER, P1])).toEqual([[P1], [MASTER]]);
    expect(keepLookupGroups([], [MASTER, LIVE])).toEqual([[MASTER], [LIVE]]);
  });
});
