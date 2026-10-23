// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStickyOwnerStatus } from './useStickyOwnerStatus';
import { ownerOfferState } from '../lib/heartwood-one-hold';

type P = { s: boolean | null; active: boolean };
const mount = (init: P) => renderHook((p: P) => useStickyOwnerStatus(p.s, p.active), { initialProps: init });

describe('useStickyOwnerStatus (A8: lost is sticky for the unlock)', () => {
  it('owner:false then a failed read keeps reading false', () => {
    const h = mount({ s: false, active: true });
    expect(h.result.current).toBe(false);
    h.rerender({ s: null, active: true });
    expect(h.result.current).toBe(false);
  });
  it('a null that was never preceded by false stays unknown', () => {
    const h = mount({ s: null, active: true });
    expect(h.result.current).toBeNull();
  });
  it('owner:true ends it, and a later null is unknown again', () => {
    const h = mount({ s: false, active: true });
    h.rerender({ s: true, active: true });
    expect(h.result.current).toBe(true);
    h.rerender({ s: null, active: true });
    expect(h.result.current).toBeNull();
  });
  it('a lock, or no style on file (inactive), forgets it', () => {
    const h = mount({ s: false, active: true });
    h.rerender({ s: null, active: false });
    expect(h.result.current).toBeNull();
    h.rerender({ s: null, active: true });
    expect(h.result.current).toBeNull();
  });
  it('owner:false then a null refresh keeps the backups hold and the approve-again offer', () => {
    const base = {
      bunkerMode: true, routerSettled: true, supported: true, everHadFullAccess: true,
      awaitingFirstStatus: false, vaultNeedsApproval: false, dismissed: false,
    };
    const h = mount({ s: false, active: true });
    expect(ownerOfferState({ ...base, statusOwner: h.result.current })).toMatchObject({ lost: true, offer: true, holdBackups: true, holdUntilAnswered: true });
    h.rerender({ s: null, active: true });
    expect(ownerOfferState({ ...base, statusOwner: h.result.current })).toMatchObject({ lost: true, offer: true, holdBackups: true, holdUntilAnswered: true });
    // A decline still releases it.
    expect(ownerOfferState({ ...base, statusOwner: h.result.current, dismissed: true })).toMatchObject({ offer: false, holdBackups: false });
  });
});
