// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChildPairNearby } from './useChildPairNearby';
import { writeChildPairCode, classifyTappedCode } from '../lib/child-pair-nfc';
import { createHandshakeSession } from '../lib/handshake-reveal';
import { resetScanThrottleForTests } from '../lib/handshake-nearby';
import { fakeNfcPhone, radio, tapTogether } from '../lib/child-pair-tap-testkit';

const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);
beforeEach(() => resetScanThrottleForTests());
afterEach(() => { vi.useRealTimers(); });

function rig() {
  const air = radio();
  const nfc = fakeNfcPhone(), native = air.phone(), awake = vi.fn();
  const hook = renderHook(() => useChildPairNearby({ nfc, native, nowMs: () => NOW, awake }));
  return { air, nfc, native, awake, hook };
}
const peerCode = (session = createHandshakeSession()) => ({ session, code: writeChildPairCode(session, nowS) });

describe('useChildPairNearby', () => {
  it('begin arms NFC with a fresh SCP1 session code and keeps the screen on', async () => {
    const r = rig();
    expect(r.hook.result.current.available).toBeNull();
    await act(async () => { expect(await r.hook.result.current.begin({ askToEnable: false })).toBe(true); });
    expect(r.hook.result.current).toMatchObject({ phase: 'waiting', available: true, secondPhone: false, wrongScreen: null });
    expect(r.nfc.code?.startsWith('SCP1:')).toBe(true);
    expect(classifyTappedCode(r.nfc.code!, nowS).kind).toBe('child-pair');
    expect(r.awake).toHaveBeenCalledWith(true);
  });

  it('a new attempt uses a new session key; the first is gone', async () => {
    const r = rig();
    await act(async () => { await r.hook.result.current.begin({ askToEnable: false }); });
    const first = r.nfc.code;
    await act(async () => { await r.hook.result.current.begin({ askToEnable: false }); });
    expect(r.nfc.code).not.toBe(first);
    expect(r.nfc.stopped).toBe(1);
  });

  it('reports why the radios cannot be used', async () => {
    const off = rig(); off.nfc.statusValue = { supported: true, enabled: false };
    await act(async () => { expect(await off.hook.result.current.begin({ askToEnable: false })).toBe(false); });
    expect(off.hook.result.current).toMatchObject({ available: false, reason: 'off', phase: 'unavailable' });
    expect(off.awake).toHaveBeenLastCalledWith(false);

    const none = rig(); none.nfc.statusValue = { supported: false, enabled: false };
    await act(async () => { await none.hook.result.current.begin({ askToEnable: false }); });
    expect(none.hook.result.current).toMatchObject({ available: false, reason: 'unsupported' });

    const noBt = rig(); noBt.native.statusValue = { supported: false, enabled: false, permitted: false };
    await act(async () => { await noBt.hook.result.current.begin({ askToEnable: false }); });
    expect(noBt.hook.result.current).toMatchObject({ available: false, reason: 'unsupported' });

    const denied = rig(); denied.native.statusValue = { supported: true, enabled: true, permitted: false };
    denied.native.permission.mockResolvedValue({ granted: false });
    await act(async () => { await denied.hook.result.current.begin({ askToEnable: false }); });
    expect(denied.hook.result.current).toMatchObject({ available: false, reason: 'denied' });

    const btOff = rig(); btOff.native.statusValue = { supported: true, enabled: false, permitted: true };
    await act(async () => { await btOff.hook.result.current.begin({ askToEnable: false }); });
    expect(btOff.hook.result.current).toMatchObject({ available: false, reason: 'off' });
  });

  it('with no native NFC (a browser) it is unsupported', async () => {
    const hook = renderHook(() => useChildPairNearby({ nfc: null, native: null, awake: vi.fn() }));
    await act(async () => { await hook.result.current.probe(); });
    expect(hook.result.current).toMatchObject({ available: false, reason: 'unsupported' });
  });

  it('probe reports availability without starting anything', async () => {
    const r = rig();
    await act(async () => { await r.hook.result.current.probe(); });
    expect(r.hook.result.current).toMatchObject({ available: true, phase: 'idle' });
    expect(r.nfc.code).toBeNull();
    expect(r.awake).not.toHaveBeenCalled();
    r.nfc.statusValue = { supported: true, enabled: false };
    await act(async () => { await r.hook.result.current.probe(); });
    expect(r.hook.result.current).toMatchObject({ available: false, reason: 'off' });
  });

  it('re-arms the code before it expires while waiting for a tap, with the same session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const air = radio(); const nfc = fakeNfcPhone();
    let clock = NOW;
    const hook = renderHook(() => useChildPairNearby({ nfc, native: air.phone(), nowMs: () => clock, awake: vi.fn() }));
    await act(async () => { await hook.result.current.begin({ askToEnable: false }); });
    const first = nfc.code!;
    clock += 91_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(91_000); });
    expect(nfc.codes.length).toBe(2);
    expect(nfc.code).not.toBe(first);
    const a = classifyTappedCode(first, nowS), b = classifyTappedCode(nfc.code!, Math.floor(clock / 1000));
    expect(a.kind === 'child-pair' && b.kind === 'child-pair' && a.sessionPubkey === b.sessionPubkey).toBe(true);
    // The first code would already be near its end; the new one is good for another full life.
    expect(b.kind === 'child-pair' && b.expiresAt).toBeGreaterThan(nowS + 120);
  });

  it('does not re-arm once a peer is taken', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const air = radio(); const nfc = fakeNfcPhone();
    const hook = renderHook(() => useChildPairNearby({ nfc, native: air.phone(), nowMs: () => NOW, awake: vi.fn() }));
    await act(async () => { await hook.result.current.begin({ askToEnable: false }); });
    await act(async () => { nfc.hear(peerCode().code); });
    expect(hook.result.current.phase).not.toBe('waiting');
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
    expect(nfc.codes.length).toBe(1);
    act(() => hook.result.current.end());
  });

  it('a tap from a phone on the Handshake screen is flagged, not linked', async () => {
    const r = rig();
    await act(async () => { await r.hook.result.current.begin({ askToEnable: false }); });
    act(() => r.nfc.hear('SGH2:ABCDEF'));
    expect(r.hook.result.current).toMatchObject({ wrongScreen: 'handshake', phase: 'waiting' });
    // A real pairing tap afterwards clears the flag and proceeds.
    await act(async () => { r.nfc.hear(peerCode().code); });
    expect(r.hook.result.current.wrongScreen).toBeNull();
    expect(r.hook.result.current.phase).not.toBe('waiting');
    act(() => r.hook.result.current.end());
  });

  it('ignores junk and expired codes', async () => {
    const r = rig();
    await act(async () => { await r.hook.result.current.begin({ askToEnable: false }); });
    const old = writeChildPairCode(createHandshakeSession(), nowS - 500);
    act(() => { r.nfc.hear('garbage'); r.nfc.hear(old); r.nfc.hear('SCP1:!!'); });
    expect(r.hook.result.current).toMatchObject({ phase: 'waiting', wrongScreen: null, secondPhone: false });
  });

  it('after one peer is taken a different tapped session is ignored and surfaced', async () => {
    const r = rig();
    await act(async () => { await r.hook.result.current.begin({ askToEnable: false }); });
    const first = peerCode(), second = peerCode();
    await act(async () => { r.nfc.hear(first.code); });
    expect(r.hook.result.current.secondPhone).toBe(false);
    // The same phone touching again is not a second phone.
    act(() => r.nfc.hear(first.code));
    expect(r.hook.result.current.secondPhone).toBe(false);
    act(() => r.nfc.hear(second.code));
    expect(r.hook.result.current.secondPhone).toBe(true);
    act(() => r.hook.result.current.end());
  });

  it('end releases NFC and the screen, and unmount does the same', async () => {
    const r = rig();
    await act(async () => { await r.hook.result.current.begin({ askToEnable: false }); });
    act(() => r.hook.result.current.end());
    expect(r.nfc.stopped).toBe(1);
    expect(r.awake).toHaveBeenLastCalledWith(false);
    expect(r.hook.result.current.phase).toBe('idle');
    expect(r.hook.result.current.tap.attempt).toBe(0);

    const u = rig();
    await act(async () => { await u.hook.result.current.begin({ askToEnable: false }); });
    u.hook.unmount();
    expect(u.nfc.stopped).toBe(1);
    expect(u.awake).toHaveBeenLastCalledWith(false);
  });

  it('two phones tap, link, and carry an offer one way and events both ways', async () => {
    const air = radio();
    const gn = fakeNfcPhone(), cn = fakeNfcPhone();
    const g = renderHook(() => useChildPairNearby({ nfc: gn, native: air.phone(), nowMs: () => NOW, awake: vi.fn() }));
    const c = renderHook(() => useChildPairNearby({ nfc: cn, native: air.phone(), nowMs: () => NOW, awake: vi.fn() }));
    const offers: string[] = [];
    c.result.current.tap.onOffer(u => offers.push(u));
    await act(async () => {
      await g.result.current.begin({ askToEnable: false, offerUri: 'signet-child:?x=1' });
      await c.result.current.begin({ askToEnable: false });
    });
    await act(async () => { tapTogether(gn, cn); });
    await waitFor(() => expect(g.result.current.phase === 'linked' && c.result.current.phase === 'linked').toBe(true), { timeout: 4000 });
    await waitFor(() => expect(offers).toEqual(['signet-child:?x=1']), { timeout: 4000 });
    g.unmount(); c.unmount();
  });
});
