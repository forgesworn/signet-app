import { describe, it, expect } from 'vitest';
import {
  activationRouteOf, handshakeRouteOf, isPageParamLive, personaAdvancedRouteOf, personaAdvancedTargetExists,
} from './page-params';
import type { SignetIdentity } from '../types/identity';
import type { DependantIdentity } from '../types/dependants';

const identity = {
  naturalPerson: { publicKey: 'np' }, persona: { publicKey: 'p' },
  extraPersonas: [{ publicKey: 'extra-1' }],
} as unknown as SignetIdentity;
const dependants = [
  { id: 'dep-a', extraPersonas: [{ publicKey: 'dep-extra' }] },
] as unknown as DependantIdentity[];
const ctx = { identity, dependants };

describe('page parameter guards', () => {
  it('reads only well-formed parameters back out of history.state', () => {
    expect(personaAdvancedRouteOf({ slotTarget: 'persona', depPubkey: 'dep-a', junk: 1 })).toEqual({ slotTarget: 'persona', depPubkey: 'dep-a' });
    expect(personaAdvancedRouteOf({ slotTarget: '' })).toBeNull();
    expect(personaAdvancedRouteOf({ slotTarget: 'persona', depPubkey: 7 })).toBeNull();
    expect(personaAdvancedRouteOf(undefined)).toBeNull();
    expect(activationRouteOf({ returnTo: null })).toEqual({ returnTo: null });
    expect(activationRouteOf({ returnTo: 'settings', dependantId: 'dep-a' })).toEqual({ returnTo: 'settings', dependantId: 'dep-a' });
    expect(activationRouteOf({ returnTo: 3 })).toBeNull();
    expect(handshakeRouteOf({ persona: 'p', choose: true, info: { name: 'n', hasPhoto: false } }))
      .toEqual({ persona: 'p', choose: true, info: { name: 'n', hasPhoto: false } });
    expect(handshakeRouteOf({ persona: 'p', choose: true })).toBeNull();
  });
});

describe('isPageParamLive', () => {
  it("sends an Advanced entry home when its slot or dependant is gone, or it has no slot", () => {
    expect(isPageParamLive('persona-advanced', { slotTarget: 'extra-1' }, ctx)).toBe(true);
    expect(isPageParamLive('persona-advanced', { slotTarget: 'extra-gone' }, ctx)).toBe(false);
    expect(isPageParamLive('persona-advanced', { slotTarget: 'professional-persona' }, ctx)).toBe(false);
    expect(isPageParamLive('persona-advanced', { slotTarget: 'persona', depPubkey: 'dep-a' }, ctx)).toBe(true);
    expect(isPageParamLive('persona-advanced', { slotTarget: 'dep-extra', depPubkey: 'dep-a' }, ctx)).toBe(true);
    expect(isPageParamLive('persona-advanced', { slotTarget: 'persona', depPubkey: 'dep-gone' }, ctx)).toBe(false);
    expect(isPageParamLive('persona-advanced', undefined, ctx)).toBe(false);
  });

  it("sends a dependant's activation entry home when the dependant is gone", () => {
    expect(isPageParamLive('activate-real-identity', { returnTo: null, dependantId: 'dep-a' }, ctx)).toBe(true);
    expect(isPageParamLive('activate-real-identity', { returnTo: null, dependantId: 'dep-gone' }, ctx)).toBe(false);
    expect(isPageParamLive('activate-real-identity', { returnTo: 'settings-personas' }, ctx)).toBe(true);
  });

  it('needs a persona for a handshake entry, and leaves other pages alone', () => {
    expect(isPageParamLive('contact-handshake', undefined, ctx)).toBe(false);
    expect(isPageParamLive('settings', undefined, ctx)).toBe(true);
  });

  it('cannot judge a slot with no identity loaded, so the entry stands', () => {
    expect(isPageParamLive('persona-advanced', { slotTarget: 'extra-gone' }, { identity: null, dependants: [] })).toBe(true);
    expect(personaAdvancedTargetExists({ slotTarget: 'natural-person' }, identity, [])).toBe(true);
  });
});
