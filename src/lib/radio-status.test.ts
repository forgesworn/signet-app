import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isNative: true,
  nfcStatus: vi.fn(), nearbyStatus: vi.fn(), remove: vi.fn(),
  handlers: new Map<string, (e: unknown) => void>(),
  addListener: vi.fn(),
}));
vi.mock('./native', () => ({
  isNativeApp: () => native.isNative,
  SignetNative: { nfcStatus: native.nfcStatus, nearbyStatus: native.nearbyStatus, addListener: native.addListener },
}));
const foreground = vi.hoisted(() => ({ cb: null as null | (() => void), unsub: vi.fn(), visible: true }));
vi.mock('./app-foreground', () => ({
  isAppInForeground: () => foreground.visible,
  subscribeAppForeground: (cb: () => void) => { foreground.cb = cb; return foreground.unsub; },
}));
import { getRadioStatus, radioStatusFrom, refreshRadioStatus, subscribeRadioStatus } from './radio-status';

const flush = () => new Promise(r => setTimeout(r, 0));
beforeEach(() => {
  native.isNative = true; foreground.visible = true; foreground.cb = null;
  native.nfcStatus.mockResolvedValue({ supported: true, enabled: true });
  native.nearbyStatus.mockResolvedValue({ supported: true, enabled: true, permitted: true });
  native.addListener.mockImplementation(async (name: string, fn: (e: unknown) => void) => { native.handlers.set(name, fn); return { remove: native.remove }; });
});
afterEach(() => { vi.clearAllMocks(); native.handlers.clear(); });

describe('radioStatusFrom', () => {
  const on = { supported: true, enabled: true, permitted: true };
  it('maps NFC', () => {
    expect(radioStatusFrom({ supported: false, enabled: false }, on).nfc).toBe('none');
    expect(radioStatusFrom({ supported: true, enabled: false }, on).nfc).toBe('off');
    expect(radioStatusFrom({ supported: true, enabled: true }, on).nfc).toBe('on');
  });
  it('maps Bluetooth, with a missing permission ahead of being off', () => {
    const nfc = { supported: true, enabled: true };
    expect(radioStatusFrom(nfc, { ...on, supported: false }).bluetooth).toBe('none');
    expect(radioStatusFrom(nfc, { ...on, permitted: false, enabled: false }).bluetooth).toBe('denied');
    expect(radioStatusFrom(nfc, { ...on, enabled: false }).bluetooth).toBe('off');
    expect(radioStatusFrom(nfc, on).bluetooth).toBe('on');
  });
});

describe('store', () => {
  it('is null on the web and never calls native', () => {
    native.isNative = false;
    const off = subscribeRadioStatus(() => {});
    expect(getRadioStatus()).toBeNull();
    off();
    expect(native.nfcStatus).not.toHaveBeenCalled();
    expect(native.nearbyStatus).not.toHaveBeenCalled();
    expect(native.addListener).not.toHaveBeenCalled();
  });
  it('reads once, follows radioState and a return to the app, and detaches with the last subscriber', async () => {
    const listener = vi.fn();
    const off = subscribeRadioStatus(listener);
    const off2 = subscribeRadioStatus(() => {});
    await flush();
    expect(native.nfcStatus).toHaveBeenCalledTimes(1);
    expect(native.nearbyStatus).toHaveBeenCalledTimes(1);
    expect(getRadioStatus()).toEqual({ nfc: 'on', bluetooth: 'on' });
    native.handlers.get('radioState')!({ nfc: { supported: true, enabled: false }, bluetooth: { supported: true, enabled: true, permitted: true } });
    expect(getRadioStatus()).toEqual({ nfc: 'off', bluetooth: 'on' });
    native.nearbyStatus.mockResolvedValue({ supported: true, enabled: true, permitted: false });
    foreground.cb!(); await flush();
    expect(getRadioStatus()).toEqual({ nfc: 'on', bluetooth: 'denied' });
    foreground.visible = false; native.nfcStatus.mockClear();
    foreground.cb!(); await flush();
    expect(native.nfcStatus).not.toHaveBeenCalled();
    refreshRadioStatus(); await flush();
    expect(native.nfcStatus).toHaveBeenCalledTimes(1);
    off();
    expect(foreground.unsub).not.toHaveBeenCalled();
    off2();
    expect(foreground.unsub).toHaveBeenCalledTimes(1);
    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(getRadioStatus()).toBeNull();
    native.nfcStatus.mockClear();
    refreshRadioStatus(); await flush();
    expect(native.nfcStatus).not.toHaveBeenCalled();
  });
});
