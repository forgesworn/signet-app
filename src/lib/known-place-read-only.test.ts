import { describe, it, expect, vi } from 'vitest';
import { readOnlyPlaceActions } from './known-place-read-only';
import type { KnownPlace } from '../types/known-places';

const place = { id: 'p' } as KnownPlace;

describe('readOnlyPlaceActions (child mode)', () => {
  const real = {
    pin: vi.fn(), setAlias: vi.fn(), setAuto: vi.fn(), open: vi.fn(), forget: vi.fn(), disconnect: vi.fn(),
    revokeOnHeartwood: vi.fn(), forgetHandoffHere: vi.fn(), forgetSignInLinksHere: vi.fn(),
  };
  const ro = readOnlyPlaceActions(real);

  it('Open still reaches the real action', async () => {
    await ro.open(place);
    expect(real.open).toHaveBeenCalledWith(place);
  });

  it('every other action refuses and never reaches the real one', async () => {
    await expect(Promise.resolve().then(() => ro.pin('p', true))).rejects.toThrow(/guardian/i);
    await expect(Promise.resolve().then(() => ro.setAlias('p', 'x'))).rejects.toThrow();
    await expect(Promise.resolve().then(() => ro.setAuto(place, 'always'))).rejects.toThrow();
    await expect(Promise.resolve().then(() => ro.forget(place))).rejects.toThrow();
    await expect(Promise.resolve().then(() => ro.disconnect(place))).rejects.toThrow();
    await expect(Promise.resolve().then(() => ro.revokeOnHeartwood('fp'))).rejects.toThrow();
    expect(ro.forgetHandoffHere).toBeUndefined();
    expect(ro.forgetSignInLinksHere).toBeUndefined();
    for (const [name, fn] of Object.entries(real)) if (name !== 'open') expect(fn, name).not.toHaveBeenCalled();
  });
});
