import { describe, it, expect } from 'vitest';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { appPermissionNeedsRealIdentityConfirm, appPermissionRequestKey, classifyAppPermissionSearch, classifyAppPermissionFailure, routeAppPermission, type AppPermissionRouteInput } from './app-permission-flow';
import { ChildGateRefusedError } from './child-bunker';
import { APP_PERMISSION_COPY } from './app-permission-copy';

const NOW = 1_790_000_000;
const PERSONA = getPublicKey(generateSecretKey());
const INSTALL = getPublicKey(generateSecretKey());
const SESSION = getPublicKey(generateSecretKey());
const tags = [['d', 'twang'], ['p', INSTALL], ['valid_from', String(NOW)], ['valid_until', String(NOW + 86400)], ['v', '1'], ['role', 'player'], ['expiration', String(NOW + 86400)]];
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
function search(over: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    action: 'app-permission', permission: 'online-play', origin: 'https://twang.example', name: 'Twang Thang',
    reason: 'To play online.', template: b64url({ kind: 30420, pubkey: PERSONA, content: '', tags }),
    relay: 'wss://relay.example', sessionPubkey: SESSION, challenge: 'ab'.repeat(32), t: String(NOW), callback: 'https://twang.example/back',
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) p.set(k, v);
  return `?${p}`;
}

describe('classifyAppPermissionSearch', () => {
  it('a good link is a request', () => {
    const r = classifyAppPermissionSearch(search(), NOW);
    expect(r.kind).toBe('request');
    if (r.kind === 'request') expect(r.request).toMatchObject({ name: 'Twang Thang', origin: 'https://twang.example', relay: 'wss://relay.example' });
  });
  it('other carriers are not ours (so the caller falls through to the next one)', () => {
    expect(classifyAppPermissionSearch('', NOW).kind).toBe('not-ours');
    expect(classifyAppPermissionSearch('?action=add-dependant&x=1', NOW).kind).toBe('not-ours');
    expect(classifyAppPermissionSearch('?nostrconnect=1', NOW).kind).toBe('not-ours');
    expect(classifyAppPermissionSearch('?auth=1&challenge=' + 'a'.repeat(64), NOW).kind).toBe('not-ours');
  });
  it('an app-permission link that does not parse is consumed with a reason, never a request', () => {
    expect(classifyAppPermissionSearch(search({ permission: 'post-as-me' }), NOW)).toEqual({ kind: 'refused', reason: 'permission' });
    expect(classifyAppPermissionSearch(search({ relay: null }), NOW)).toEqual({ kind: 'refused', reason: 'relay' });
    expect(classifyAppPermissionSearch(search({ t: String(NOW - 4000) }), NOW)).toEqual({ kind: 'refused', reason: 't' });
    expect(classifyAppPermissionSearch(search({ template: b64url({ kind: 1, pubkey: PERSONA, content: '', tags: [] }) }), NOW)).toEqual({ kind: 'refused', reason: 'template' });
  });
});

describe('routeAppPermission (D9)', () => {
  const base: AppPermissionRouteInput = {
    persona: PERSONA, signingMode: 'local', childDirect: false,
    ownerPersonas: [PERSONA], dependantPersonas: [], childPersonas: [],
  };
  it('an adult signs as an owner persona', () => {
    expect(routeAppPermission(base)).toEqual({ mode: 'adult', persona: PERSONA });
    expect(routeAppPermission({ ...base, signingMode: 'bunker' })).toEqual({ mode: 'adult', persona: PERSONA });
  });
  it('a key that is not an owner persona is not on the device', () => {
    expect(routeAppPermission({ ...base, ownerPersonas: [] })).toEqual({ mode: 'refused', reason: 'persona-not-on-device' });
  });
  it('a dependant\'s key held on the guardian\'s phone is refused', () => {
    expect(routeAppPermission({ ...base, ownerPersonas: [], dependantPersonas: [PERSONA] })).toEqual({ mode: 'refused', reason: 'dependant-on-guardian' });
  });
  it('a guardian who has handed the phone to a child does not offer their own keys', () => {
    expect(routeAppPermission({ ...base, guardianActingAsChild: true })).toEqual({ mode: 'refused', reason: 'child-mode' });
  });
  it('a direct-paired child asks its guardian, for its own persona only', () => {
    const child = { ...base, signingMode: 'paired-child', childDirect: true, ownerPersonas: [], childPersonas: [PERSONA] };
    expect(routeAppPermission(child)).toEqual({ mode: 'child-direct', persona: PERSONA });
    expect(routeAppPermission({ ...child, childPersonas: [] })).toEqual({ mode: 'refused', reason: 'persona-not-on-device' });
  });
  it('a legacy phone-paired child is refused whatever the key (owner personas never reach it)', () => {
    expect(routeAppPermission({ ...base, signingMode: 'paired-child', childDirect: false, childPersonas: [PERSONA] })).toEqual({ mode: 'refused', reason: 'legacy-paired-child' });
  });
  it('compares case-insensitively', () => {
    expect(routeAppPermission({ ...base, persona: PERSONA.toUpperCase() }).mode).toBe('adult');
  });
});

describe('classifyAppPermissionFailure (I1)', () => {
  it('only the guardian\'s own No answers the app', () => {
    expect(classifyAppPermissionFailure(new ChildGateRefusedError('denied'))).toEqual({ kind: 'guardian-denied' });
  });

  it('local failures are a plain retry on the page, and send nothing', () => {
    for (const code of ['unsent', 'rate-limited', 'expired', 'unpaired'] as const) {
      expect(classifyAppPermissionFailure(new ChildGateRefusedError(code))).toEqual({ kind: 'retry', message: APP_PERMISSION_COPY.guardianUnreachable });
    }
    expect(classifyAppPermissionFailure(new ChildGateRefusedError('device-unreachable'))).toEqual({ kind: 'retry', message: APP_PERMISSION_COPY.deviceUnreachable });
  });

  it('the person\'s own Cancel (withdrawn) is already answered', () => {
    expect(classifyAppPermissionFailure(new ChildGateRefusedError('withdrawn'))).toEqual({ kind: 'withdrawn' });
  });

  it('anything else keeps its own message (blocked, busy, a signer error)', () => {
    expect(classifyAppPermissionFailure(new ChildGateRefusedError('blocked'))).toEqual({ kind: 'other' });
    expect(classifyAppPermissionFailure(new ChildGateRefusedError('busy'))).toEqual({ kind: 'other' });
    expect(classifyAppPermissionFailure(new Error('timeout'))).toEqual({ kind: 'other' });
  });
});

describe('appPermissionRequestKey (M4)', () => {
  it('differs between two requests, so a swapped page never reuses state', () => {
    const a = classifyAppPermissionSearch(search(), NOW);
    const b = classifyAppPermissionSearch(search({ challenge: 'cd'.repeat(32) }), NOW);
    if (a.kind !== 'request' || b.kind !== 'request') throw new Error('fixture');
    expect(appPermissionRequestKey(a.request)).not.toBe(appPermissionRequestKey(b.request));
    expect(appPermissionRequestKey(a.request)).toBe(appPermissionRequestKey({ ...a.request }));
  });
});

describe('appPermissionNeedsRealIdentityConfirm (M5)', () => {
  const NP = getPublicKey(generateSecretKey());
  const identity = { naturalPerson: { publicKey: NP } };
  it('only the adult real-name identity, only with the guardrail on', () => {
    expect(appPermissionNeedsRealIdentityConfirm({ mode: 'adult', persona: NP }, identity, true)).toBe(true);
    expect(appPermissionNeedsRealIdentityConfirm({ mode: 'adult', persona: NP }, identity, false)).toBe(false);
    expect(appPermissionNeedsRealIdentityConfirm({ mode: 'adult', persona: PERSONA }, identity, true)).toBe(false);
    expect(appPermissionNeedsRealIdentityConfirm({ mode: 'child-direct', persona: NP }, identity, true)).toBe(false);
    expect(appPermissionNeedsRealIdentityConfirm({ mode: 'refused', reason: 'persona-not-on-device' }, identity, true)).toBe(false);
  });
});

