import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  nfcStart: vi.fn(), nfcQuiet: vi.fn(), nfcStop: vi.fn(), nfcStatus: vi.fn(), remove: vi.fn(), addListener: vi.fn(),
}));
vi.mock('./native', () => ({ isNativeApp: () => true, SignetNative: native }));

import { nativeNfc } from './handshake-nfc';

beforeEach(() => {
  vi.clearAllMocks();
  native.addListener.mockResolvedValue({ remove: native.remove });
  native.nfcQuiet.mockResolvedValue(undefined);
  native.nfcStop.mockResolvedValue(undefined);
});

describe('handshake NFC handle', () => {
  it('carries its own session number on quiet and stop, so a stale handle cannot touch a newer session', async () => {
    native.nfcStart.mockResolvedValueOnce({ session: 1 }).mockResolvedValueOnce({ session: 2 });
    const nfc = nativeNfc()!;
    const old = await nfc.start('SGH2:OLD', () => {});
    const fresh = await nfc.start('SGH2:NEW', () => {});
    // The old screen's late quiet and stop arrive after the new start.
    old.quiet(); old.stop();
    expect(native.nfcQuiet).toHaveBeenCalledWith({ session: 1 });
    expect(native.nfcStop).toHaveBeenCalledWith({ session: 1 });
    expect(native.nfcQuiet).not.toHaveBeenCalledWith({ session: 2 });
    expect(native.nfcStop).not.toHaveBeenCalledWith({ session: 2 });
    fresh.quiet();
    expect(native.nfcQuiet).toHaveBeenLastCalledWith({ session: 2 });
  });
  it('reaches native at most once per call kind, however often it is called', async () => {
    native.nfcStart.mockResolvedValueOnce({ session: 3 });
    const handle = await nativeNfc()!.start('SGH2:ABC', () => {});
    for (let i = 0; i < 20; i++) handle.quiet();
    expect(native.nfcQuiet).toHaveBeenCalledTimes(1);
    handle.stop(); handle.stop();
    expect(native.nfcStop).toHaveBeenCalledTimes(1);
    handle.quiet();
    expect(native.nfcQuiet).toHaveBeenCalledTimes(1);
  });
});

describe('a child-pairing phone touching the Handshake screen', () => {
  it('drops an SCP1 code, reports it, and passes SGH2 codes through unchanged', async () => {
    native.nfcStart.mockResolvedValueOnce({ session: 9 });
    let deliver: (e: { code?: unknown }) => void = () => {};
    native.addListener.mockImplementationOnce(async (_n: string, cb: (e: { code?: unknown }) => void) => { deliver = cb; return { remove: native.remove }; });
    const onPeer = vi.fn(), onPairingPeer = vi.fn();
    await nativeNfc()!.start('SGH2:OWN', onPeer, { onPairingPeer });
    deliver({ code: 'SCP1:ABC' });
    expect(onPeer).not.toHaveBeenCalled();
    expect(onPairingPeer).toHaveBeenCalledTimes(1);
    deliver({ code: 'SGH2:PEER' });
    expect(onPeer).toHaveBeenCalledWith('SGH2:PEER');
    deliver({ code: 42 });
    expect(onPeer).toHaveBeenCalledTimes(1);
    expect(onPairingPeer).toHaveBeenCalledTimes(1);
  });
  it('ignores an SCP1 code gracefully when the screen gave no hook', async () => {
    native.nfcStart.mockResolvedValueOnce({ session: 10 });
    let deliver: (e: { code?: unknown }) => void = () => {};
    native.addListener.mockImplementationOnce(async (_n: string, cb: (e: { code?: unknown }) => void) => { deliver = cb; return { remove: native.remove }; });
    const onPeer = vi.fn();
    await nativeNfc()!.start('SGH2:OWN', onPeer);
    expect(() => deliver({ code: 'SCP1:ABC' })).not.toThrow();
    expect(onPeer).not.toHaveBeenCalled();
  });
});
