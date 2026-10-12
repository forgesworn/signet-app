import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  nfcStart: vi.fn(), nfcQuiet: vi.fn(), nfcStop: vi.fn(), nfcStatus: vi.fn(), remove: vi.fn(), addListener: vi.fn(),
}));
vi.mock('./native', () => ({ isNativeApp: () => true, SignetNative: native }));

import { classifyTappedCode, startChildPairNfc, writeChildPairCode } from './child-pair-nfc';
import { sessionQR } from './handshake-reveal';

const KEY = 'ab'.repeat(32);
const NOW = 1_800_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  native.addListener.mockResolvedValue({ remove: native.remove });
  native.nfcStop.mockResolvedValue(undefined);
});

describe('child-pair NFC code', () => {
  it('round-trips, fits the 250-byte APDU cap, and expires at most 120 s ahead', () => {
    const code = writeChildPairCode({ publicKey: KEY }, NOW);
    expect(code.startsWith('SCP1:')).toBe(true);
    expect(code.length).toBeLessThanOrEqual(250);
    expect(code).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
    expect(classifyTappedCode(code, NOW)).toEqual({ kind: 'child-pair', sessionPubkey: KEY, expiresAt: NOW + 120 });
    expect(classifyTappedCode(code, NOW + 119).kind).toBe('child-pair');
  });
  it('an expired code is invalid', () => {
    const code = writeChildPairCode({ publicKey: KEY }, NOW);
    expect(classifyTappedCode(code, NOW + 120)).toEqual({ kind: 'invalid' });
    expect(classifyTappedCode(code, NOW + 500)).toEqual({ kind: 'invalid' });
  });
  it('a code that claims to live longer than 120 s, or is malformed, is invalid', () => {
    const code = writeChildPairCode({ publicKey: KEY }, NOW + 1000);
    expect(classifyTappedCode(code, NOW)).toEqual({ kind: 'invalid' });
    const good = writeChildPairCode({ publicKey: KEY }, NOW);
    for (const bad of ['SCP1:', 'SCP1:!!!', good.slice(0, -3), good + 'AAA', 'SCP2:' + good.slice(5), '', 'npub1xyz']) {
      expect(classifyTappedCode(bad, NOW)).toEqual({ kind: 'invalid' });
    }
  });
  it('rejects a bad session key', () => {
    expect(() => writeChildPairCode({ publicKey: 'nope' }, NOW)).toThrow();
  });
  it('a Handshake code seen on the pairing side is a handshake, however it was made', () => {
    const sgh2 = sessionQR({ publicKey: KEY, expiresAt: NOW + 60, relays: ['wss://relay.example.com'] })!;
    expect(classifyTappedCode(sgh2, NOW)).toEqual({ kind: 'handshake' });
  });
  it('start offers the code and hands the raw peer code to the caller unchanged', async () => {
    native.nfcStart.mockResolvedValueOnce({ session: 4 });
    let deliver: (e: { code?: unknown }) => void = () => {};
    native.addListener.mockImplementationOnce(async (_n: string, cb: (e: { code?: unknown }) => void) => { deliver = cb; return { remove: native.remove }; });
    const onPeer = vi.fn();
    const code = writeChildPairCode({ publicKey: KEY }, NOW);
    const handle = await startChildPairNfc(code, onPeer);
    expect(native.nfcStart).toHaveBeenCalledWith({ code });
    deliver({ code: 'SGH2:PEER' });
    expect(onPeer).toHaveBeenCalledWith('SGH2:PEER');
    deliver({ code: 'SCP1:OTHER' });
    expect(onPeer).toHaveBeenLastCalledWith('SCP1:OTHER');
    handle!.stop();
    expect(native.nfcStop).toHaveBeenCalledWith({ session: 4 });
  });
});
