import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SignetIdentity } from '../types';
import { LocalSigningBackend, type BunkerSigningBackend } from './signing-backend';
import { resolveNpBunkerBackend, resolveSlotBunkerBackend, type BunkerBackendRouter } from './bunker-router';
import {
  addDependantRequestAllowed, buildChildDirectRoutes, childDirectWithheldSlots, childSignInBackend, escalationsAvailable, signInBunkerHandoff, gatedSigningBackend, ChildGateRefusedError, isDirectChildInstall, legacyRailIdentity, type ChildRouteGate,
} from './child-bunker';

const NP = 'ef'.repeat(32), PERSONA = 'ab'.repeat(32), EXTRA = '34'.repeat(32);

function identity(over: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: NP, mnemonic: '', naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Alice' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Ally' }, primaryKeypair: 'persona',
    naturalPersonActive: false, isChild: true, createdAt: 1, encrypted: true, backedUp: true, ...over,
  } as SignetIdentity;
}
const direct = { mode: 'heartwood-direct' as const };

describe('isDirectChildInstall', () => {
  it('follows the record, else the stub identity, and is false off paired-child', () => {
    expect(isDirectChildInstall({ signingMode: 'paired-child', record: direct, identity: identity() })).toBe(true);
    expect(isDirectChildInstall({ signingMode: 'paired-child', record: { mode: 'phone' }, identity: identity() })).toBe(false);
    expect(isDirectChildInstall({ signingMode: 'paired-child', record: null, identity: identity() })).toBe(true);
    expect(isDirectChildInstall({ signingMode: 'paired-child', record: null, identity: identity({ primaryKeypair: 'natural-person' }) })).toBe(false);
    expect(isDirectChildInstall({ signingMode: 'bunker', record: direct, identity: identity() })).toBe(false);
  });
});

describe('childDirectWithheldSlots (A26)', () => {
  it('withholds the dormant real identity on a direct install only', () => {
    expect(childDirectWithheldSlots({ signingMode: 'paired-child', record: direct, identity: identity() })).toEqual([NP]);
    expect(childDirectWithheldSlots({ signingMode: 'paired-child', record: direct, identity: identity({ naturalPersonActive: true }) })).toEqual([]);
    expect(childDirectWithheldSlots({ signingMode: 'paired-child', record: { mode: 'phone' }, identity: identity() })).toEqual([]);
    expect(childDirectWithheldSlots({ signingMode: 'bunker', record: null, identity: identity() })).toEqual([]);
  });

  it('no router route is ever requested for the dormant NP on a direct install', () => {
    const backendFor = vi.fn(() => null);
    const router = { backendFor } as unknown as BunkerBackendRouter;
    const primary = { activePublicKeyHex: PERSONA } as unknown as BunkerSigningBackend;
    const withheld = childDirectWithheldSlots({ signingMode: 'paired-child', record: direct, identity: identity() });
    expect(resolveNpBunkerBackend(primary, router, NP, { withheld })).toBeNull();
    expect(resolveSlotBunkerBackend(primary, router, NP.toUpperCase(), { withheld })).toBeNull();
    expect(backendFor).not.toHaveBeenCalled();
    // The persona (the primary) and other personas still resolve.
    expect(resolveSlotBunkerBackend(primary, router, PERSONA, { withheld })).toBe(primary);
    resolveSlotBunkerBackend(primary, router, EXTRA, { withheld });
    expect(backendFor).toHaveBeenCalledWith(EXTRA);
    expect(backendFor).not.toHaveBeenCalledWith(NP);
  });
});

describe('legacyRailIdentity', () => {
  it('is null on every paired-child install and the identity otherwise', () => {
    const id = identity();
    expect(legacyRailIdentity('paired-child', id)).toBeNull();
    expect(legacyRailIdentity('bunker', id)).toBe(id);
    expect(legacyRailIdentity('local', id)).toBe(id);
    expect(legacyRailIdentity(undefined, id)).toBe(id);
  });
});

describe('buildChildDirectRoutes', () => {
  const tk = (sk = generateSecretKey()) => ({ publicKey: getPublicKey(sk), privateKey: bytesToHex(sk) });
  const gate: ChildRouteGate = { authorise: vi.fn() };
  const signing = (pk: string) => ({ activePublicKeyHex: pk } as never);

  it('one gated route per persona on its LOCAL transport key, signing through the persona route', () => {
    const keys = { [PERSONA]: tk(), [EXTRA]: tk() };
    const gates: string[] = [];
    const routes = buildChildDirectRoutes({
      personas: [PERSONA, EXTRA], transportKeys: keys, signingBackendFor: signing,
      gateFor: (p) => { gates.push(p); return gate; },
    }, (priv) => new LocalSigningBackend(priv));
    expect(routes.map(r => r.pubkey)).toEqual([keys[PERSONA].publicKey, keys[EXTRA].publicKey]);
    for (const r of routes) {
      expect(r.pubkey).not.toBe(PERSONA);
      expect(r.pubkey).not.toBe(EXTRA);
      expect(r.backend.activePublicKeyHex).toBe(r.pubkey);
      expect(r.childGate).toBe(gate);
      expect(r.dependantId).toBeUndefined();
    }
    expect(routes[0].signingBackend?.activePublicKeyHex).toBe(PERSONA);
    expect(gates).toEqual([PERSONA, EXTRA]);
  });

  it('skips a persona with no transport key or no Heartwood route, and a transport key equal to the persona', () => {
    const routes = buildChildDirectRoutes({
      personas: [PERSONA, EXTRA, NP], transportKeys: { [PERSONA]: tk(), [NP]: { publicKey: NP, privateKey: '11'.repeat(32) } },
      signingBackendFor: (p) => (p === EXTRA ? null : signing(p)), gateFor: () => gate,
    }, (priv) => new LocalSigningBackend(priv));
    expect(routes).toHaveLength(1);
    expect(routes[0].signingBackend?.activePublicKeyHex).toBe(PERSONA);
  });
});

describe('gatedSigningBackend', () => {
  it('asks the gate first and signs the gate\'s template, stamped', async () => {
    const sk = generateSecretKey();
    const local = new LocalSigningBackend(bytesToHex(sk));
    const stamps: number[] = [];
    const inner = Object.assign(local, { stamped: (c: number) => { stamps.push(c); return local; } });
    const authorise = vi.fn(async (req: { template?: import('signet-protocol').UnsignedEvent }) =>
      ({ ok: true as const, requestCreatedAt: 77, template: { ...req.template!, pubkey: local.activePublicKeyHex } }));
    const gated = gatedSigningBackend(inner, authorise);
    expect(gated.activePublicKeyHex).toBe(getPublicKey(sk));
    const ev = await gated.signEvent({ kind: 21236, created_at: 1, tags: [['origin', 'https://school.example']], content: '', pubkey: '' });
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(authorise).toHaveBeenCalledWith(expect.objectContaining({ method: 'sign_event' }));
    expect(stamps).toEqual([77]);
  });

  it('a refusal throws and never reaches the inner backend', async () => {
    const inner = { type: 'bunker', activePublicKeyHex: PERSONA, signEvent: vi.fn(), nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn() } as never;
    const gated = gatedSigningBackend(inner, async () => ({ ok: false, error: 'denied' }));
    await expect(gated.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: '' })).rejects.toBeInstanceOf(ChildGateRefusedError);
    await expect(gated.nip44Decrypt(EXTRA, 'x')).rejects.toBeInstanceOf(ChildGateRefusedError);
    expect((inner as { signEvent: ReturnType<typeof vi.fn> }).signEvent).not.toHaveBeenCalled();
  });
});

describe('A41: guardian-only surfaces are off on every paired-child install', () => {
  const base = { hasMnemonic: false, bunkerConnected: true, unlocked: true, viewingDependant: false };
  it('escalations (Family asks) are disabled on paired-child, direct or not', () => {
    expect(escalationsAvailable({ ...base, signingMode: 'bunker' })).toBe(true);
    expect(escalationsAvailable({ ...base, signingMode: 'paired-child' })).toBe(false);
    expect(escalationsAvailable({ ...base, signingMode: 'bunker', hasMnemonic: true })).toBe(false);
    expect(escalationsAvailable({ ...base, signingMode: 'bunker', viewingDependant: true })).toBe(false);
    expect(escalationsAvailable({ ...base, signingMode: 'bunker', unlocked: false })).toBe(false);
  });

  it('?action=add-dependant is refused on paired-child', () => {
    expect(addDependantRequestAllowed('paired-child')).toBe(false);
    expect(addDependantRequestAllowed('bunker')).toBe(true);
    expect(addDependantRequestAllowed('local')).toBe(true);
    expect(addDependantRequestAllowed(undefined)).toBe(true);
  });
});

describe('A44: sign-in bunker handoff', () => {
  it('a direct child never hands the site a bunkerUri — nothing serves it', () => {
    expect(signInBunkerHandoff({ childDirect: true, remoteBunkerUri: 'bunker://x', inPageServer: true })).toEqual({ kind: 'none' });
    expect(signInBunkerHandoff({ childDirect: true, inPageServer: true })).toEqual({ kind: 'none' });
  });
  it('elsewhere: the remote bunker first, then the in-page server, else none', () => {
    expect(signInBunkerHandoff({ childDirect: false, remoteBunkerUri: 'bunker://x', inPageServer: true })).toEqual({ kind: 'remote', uri: 'bunker://x' });
    expect(signInBunkerHandoff({ childDirect: false, inPageServer: true })).toEqual({ kind: 'in-page' });
    expect(signInBunkerHandoff({ childDirect: false, inPageServer: false })).toEqual({ kind: 'none' });
  });
});

describe('A45: sign-in on a direct child', () => {
  it('gates as the site and touches the site:<origin> connected-app entry on each forwarded sign', async () => {
    const sk = generateSecretKey();
    const inner = new LocalSigningBackend(bytesToHex(sk));
    const touched: string[] = [];
    const authorise = vi.fn(async (req: { template?: import('signet-protocol').UnsignedEvent }) =>
      ({ ok: true as const, requestCreatedAt: 5, template: { ...req.template!, pubkey: inner.activePublicKeyHex } }));
    const backend = childSignInBackend({
      inner, origin: 'https://school.example', siteLabel: 'School', authorise,
      touch: (appId) => touched.push(appId),
    });
    expect(touched).toEqual(['site:https://school.example']);
    await backend.signEvent({ kind: 21236, created_at: 1, tags: [], content: '', pubkey: '' });
    expect(authorise).toHaveBeenCalledWith(expect.objectContaining({ siteOrigin: 'https://school.example', appLabel: 'School', persona: inner.activePublicKeyHex }));
    expect(touched).toEqual(['site:https://school.example', 'site:https://school.example']);
    const refused = childSignInBackend({ inner, origin: 'https://x.example', siteLabel: 'X', authorise: async () => ({ ok: false, error: 'denied' }), touch: (a) => touched.push(a) });
    await expect(refused.signEvent({ kind: 21236, created_at: 1, tags: [], content: '', pubkey: '' })).rejects.toBeInstanceOf(ChildGateRefusedError);
    expect(touched.filter(a => a === 'site:https://x.example')).toHaveLength(1);
  });
});
