import { describe, it, expect } from 'vitest';
import { createLocalBackends } from './signing-backend';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { SignetIdentity, DependantIdentity } from '../types';
import { resolveGuardianBackend, assertSigningIdentity, guardianSigningPubkeys, approvalGuardianPubkeys, approvalDependantSignable, isImportedGuardianPersona } from './guardian-signing';

// Valid 64-char-hex secp256k1 scalars (small, well below the curve order).
const NP_PRIV = '1'.repeat(64);
const PERSONA_PRIV = '2'.repeat(64);
const EXTRA_PRIV = '3'.repeat(64);
const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const pub = (priv: string) => bytesToHex(schnorr.getPublicKey(hexToBytes(priv)));

/** A fully-decrypted identity (private keys present, `encrypted: false`). */
function decryptedIdentity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: pub(NP_PRIV),
    mnemonic: '', // empty → forces the stored-per-slot-key path, not mnemonic derivation
    naturalPerson: { publicKey: pub(NP_PRIV), privateKey: NP_PRIV, displayName: 'Real Name' },
    persona: { publicKey: pub(PERSONA_PRIV), privateKey: PERSONA_PRIV, displayName: 'Anon' },
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: 1_700_000_000,
    encrypted: false,
    ...overrides,
  };
}

const extraPersona = {
  publicKey: pub(EXTRA_PRIV),
  privateKey: EXTRA_PRIV,
  displayName: 'Extra',
  derivationName: 'persona-2',
};

describe('resolveGuardianBackend', () => {
  it('never substitutes the real-name key for a distinct persona whose key is missing', () => {
    const id = decryptedIdentity({ persona: { publicKey: pub(PERSONA_PRIV), privateKey: '', displayName: 'Anon' } });
    expect(resolveGuardianBackend('persona', id)).toBeNull();
  });

  it('refuses stored private material belonging to another public identity', () => {
    const id = decryptedIdentity({ persona: { publicKey: pub(PERSONA_PRIV), privateKey: NP_PRIV, displayName: 'Anon' } });
    expect(resolveGuardianBackend('persona', id)).toBeNull();
  });

  it('returns null when the identity is still in its public-only (encrypted) form', () => {
    // The auto-lock case: the screen still renders from public data, but no
    // private key material is present. Caller must re-unlock + fresh-decrypt.
    const locked = decryptedIdentity({ encrypted: true });
    expect(resolveGuardianBackend('natural-person', locked)).toBeNull();
  });

  it('resolves the natural-person backend from a decrypted stored key', () => {
    const backend = resolveGuardianBackend('natural-person', decryptedIdentity());
    expect(backend).not.toBeNull();
    expect(backend!.activePublicKeyHex).toBe(pub(NP_PRIV));
  });

  it('resolves the built-in persona backend from a decrypted stored key', () => {
    const backend = resolveGuardianBackend('persona', decryptedIdentity());
    expect(backend).not.toBeNull();
    expect(backend!.activePublicKeyHex).toBe(pub(PERSONA_PRIV));
  });

  it('resolves an nsec-imported built-in persona when natural-person is empty', () => {
    const id = decryptedIdentity({
      id: pub(PERSONA_PRIV),
      naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
      persona: { publicKey: pub(PERSONA_PRIV), privateKey: PERSONA_PRIV, displayName: 'Imported' },
      primaryKeypair: 'persona',
    });

    const backend = resolveGuardianBackend('persona', id);
    expect(backend).not.toBeNull();
    expect(backend!.activePublicKeyHex).toBe(pub(PERSONA_PRIV));
  });

  it('prefers a stored built-in persona key over mnemonic re-derivation', () => {
    const id = decryptedIdentity({
      mnemonic: VALID_MNEMONIC,
      persona: { publicKey: pub(PERSONA_PRIV), privateKey: PERSONA_PRIV, displayName: 'Migrated Lite' },
      primaryKeypair: 'persona',
    });

    const backend = resolveGuardianBackend('persona', id);
    expect(backend).not.toBeNull();
    expect(backend!.activePublicKeyHex).toBe(pub(PERSONA_PRIV));
  });

  it('resolves an extra-persona backend by its public key', () => {
    const id = decryptedIdentity({ extraPersonas: [extraPersona] });
    const backend = resolveGuardianBackend(extraPersona.publicKey, id);
    expect(backend).not.toBeNull();
    expect(backend!.activePublicKeyHex).toBe(pub(EXTRA_PRIV));
  });

  it('returns null when the selected extra persona has no valid key', () => {
    const id = decryptedIdentity({
      extraPersonas: [{ ...extraPersona, privateKey: '' }],
    });
    expect(resolveGuardianBackend(extraPersona.publicKey, id)).toBeNull();
  });

  it('returns null when no usable key material is available', () => {
    const id = decryptedIdentity({
      mnemonic: '',
      naturalPerson: { publicKey: 'np', privateKey: 'not-hex', displayName: 'R' },
    });
    expect(resolveGuardianBackend('natural-person', id)).toBeNull();
  });

  it('derives from the mnemonic (canonical path) when present, NP distinct from persona', () => {
    // Stored slot keys are deliberately invalid so only the mnemonic path can
    // succeed — proving derivation, not the stored-key fallback, is used.
    const expected = createLocalBackends(VALID_MNEMONIC);
    const id = decryptedIdentity({
      mnemonic: VALID_MNEMONIC,
      naturalPerson: { publicKey: expected.naturalPerson.activePublicKeyHex, privateKey: 'not-hex', displayName: 'R' },
      persona: { publicKey: expected.persona.activePublicKeyHex, privateKey: 'not-hex', displayName: 'A' },
    });
    expected.naturalPerson.destroy();
    expected.persona.destroy();
    expected.professional.destroy();
    const np = resolveGuardianBackend('natural-person', id);
    const persona = resolveGuardianBackend('persona', id);
    expect(np).not.toBeNull();
    expect(persona).not.toBeNull();
    expect(np!.activePublicKeyHex).not.toBe(persona!.activePublicKeyHex);
  });
});

describe('assertSigningIdentity', () => {
  it('rejects a real-name signer for a persona approval', () => {
    expect(() => assertSigningIdentity({ activePublicKeyHex: pub(NP_PRIV) }, pub(PERSONA_PRIV))).toThrow('does not match');
  });
  it('accepts the selected identity and rejects an unresolved selection', () => {
    expect(() => assertSigningIdentity({ activePublicKeyHex: pub(PERSONA_PRIV) }, pub(PERSONA_PRIV))).not.toThrow();
    expect(() => assertSigningIdentity({ activePublicKeyHex: pub(PERSONA_PRIV) }, null)).toThrow('does not match');
  });
});

describe('guardian signing routes', () => {
  const remote = () => decryptedIdentity({
    naturalPerson: { publicKey: pub(NP_PRIV), privateKey: '', displayName: 'Owner' },
    persona: { publicKey: pub(PERSONA_PRIV), privateKey: '', displayName: 'Persona' },
    extraPersonas: [{ ...extraPersona, imported: true }],
  });

  it('offers routed personas alongside a separately held imported key', () => {
    expect(guardianSigningPubkeys(remote(), { localIdentity: false, routedSigner: true }))
      .toEqual([pub(NP_PRIV), pub(PERSONA_PRIV), pub(EXTRA_PRIV)]);
    expect(isImportedGuardianPersona(remote(), pub(EXTRA_PRIV))).toBe(true);
    expect(isImportedGuardianPersona(remote(), 'persona')).toBe(false);
  });

  it('limits a generic external signer to its own key while retaining local imports', () => {
    expect(guardianSigningPubkeys(remote(), { localIdentity: false, routedSigner: false, externalPubkey: pub(NP_PRIV) }))
      .toEqual([pub(NP_PRIV), pub(EXTRA_PRIV)]);
  });

  it('does not treat an unavailable imported key as a routed device key', () => {
    const id = remote();
    id.extraPersonas![0].privateKey = '';
    expect(guardianSigningPubkeys(id, { localIdentity: false, routedSigner: true }))
      .toEqual([pub(NP_PRIV), pub(PERSONA_PRIV)]);
  });

  it('keeps locked local identities selectable for on-demand unlock and hides hidden personas', () => {
    const id = remote(); id.encrypted = true; id.extraPersonas![0].hidden = true;
    expect(guardianSigningPubkeys(id, { localIdentity: true, routedSigner: false }))
      .toEqual([pub(NP_PRIV), pub(PERSONA_PRIV)]);
  });
});

describe('approvalGuardianPubkeys — device-held slots stay listed while their route is down', () => {
  const TREE = 'd'.repeat(64);
  const IMPORTED = 'e'.repeat(64);
  const locked = () => ({
    ...decryptedIdentity({
      naturalPerson: { publicKey: pub(NP_PRIV), privateKey: '', displayName: 'Owner' },
      persona: { publicKey: pub(PERSONA_PRIV), privateKey: '', displayName: 'Persona' },
      extraPersonas: [
        { publicKey: TREE, privateKey: '', displayName: 'Tree Extra', derivationName: 'persona-1' },
        { publicKey: IMPORTED, privateKey: '', displayName: 'Imported Extra', imported: true },
      ] as never,
    }),
    encrypted: true,
  });
  const base = { signingMode: 'bunker', unlocked: false, routerReady: false, routerUnsupported: false, routeWaitLapsed: false };

  it('locked, router torn down: lists the tree slots as waiting, the imported slot as ready', () => {
    const { listed, waiting } = approvalGuardianPubkeys(locked(), base);
    expect(listed).toEqual(expect.arrayContaining([pub(PERSONA_PRIV), TREE, IMPORTED]));
    expect(waiting).toContain(TREE);
    expect(waiting).not.toContain(IMPORTED);
  });

  it('once unlocked and the route is back, nothing is waiting', () => {
    const { listed, waiting } = approvalGuardianPubkeys(locked(), { ...base, unlocked: true, routerReady: true });
    expect(listed).toContain(TREE);
    expect(waiting).toEqual([]);
  });

  it('a lapsed wait stops marking slots waiting (Approve then ends in the honest error)', () => {
    expect(approvalGuardianPubkeys(locked(), { ...base, unlocked: true, routeWaitLapsed: true }).waiting).toEqual([]);
  });

  it('a signer that cannot route personas keeps the NP-only listing', () => {
    const { listed } = approvalGuardianPubkeys(locked(), { ...base, unlocked: true, routerUnsupported: true, externalPubkey: pub(NP_PRIV) });
    expect(listed).not.toContain(TREE);
    expect(listed).toContain(pub(NP_PRIV));
  });

  it('local mode is unchanged and never waits', () => {
    const { waiting } = approvalGuardianPubkeys(locked(), { ...base, signingMode: 'local' });
    expect(waiting).toEqual([]);
  });
});

describe('approvalDependantSignable — a device-held dependant is offered only through a Heartwood', () => {
  const DEP_P = 'a'.repeat(64);
  const DEP_NP = 'b'.repeat(64);
  const DEP_EXTRA = 'c'.repeat(64);
  const KEY = '4'.repeat(64);
  const dep = (over: Partial<DependantIdentity> = {}): DependantIdentity => ({
    id: 'dep1',
    guardianPubkey: pub(NP_PRIV),
    displayName: 'Ben',
    dateOfBirth: '2015-06-01',
    naturalPerson: { publicKey: DEP_NP, privateKey: '', displayName: 'Ben' },
    persona: { publicKey: DEP_P, privateKey: '', displayName: 'BenGamer' },
    derivationPath: 'dependant-0',
    createdAt: 0,
    autonomyStage: 'full-control',
    primaryKeypair: 'persona',
    ...over,
  } as DependantIdentity);
  const bunker = { signingMode: 'bunker', routerUnsupported: false };

  it('a local key on the acting slot is signable in any mode', () => {
    const d = dep({ persona: { publicKey: DEP_P, privateKey: KEY, displayName: 'BenGamer' } });
    expect(approvalDependantSignable(d, { signingMode: undefined, routerUnsupported: false })).toBe(true);
    expect(approvalDependantSignable(d, { signingMode: 'local', routerUnsupported: true })).toBe(true);
    expect(approvalDependantSignable(d, bunker)).toBe(true);
  });

  it('bunker + keyless + valid pubkey is signable', () => {
    expect(approvalDependantSignable(dep(), bunker)).toBe(true);
  });

  it('bunker with a signer that cannot route personas is not', () => {
    expect(approvalDependantSignable(dep(), { signingMode: 'bunker', routerUnsupported: true })).toBe(false);
  });

  it("keyless under 'local', undefined or 'paired-child' is not", () => {
    for (const signingMode of ['local', undefined, 'paired-child']) {
      expect(approvalDependantSignable(dep(), { signingMode, routerUnsupported: false })).toBe(false);
    }
  });

  it('an encrypted (public-only) record is not, even with a key present', () => {
    expect(approvalDependantSignable(dep({ encrypted: true }), bunker)).toBe(false);
    expect(approvalDependantSignable(dep({ encrypted: true, persona: { publicKey: DEP_P, privateKey: KEY, displayName: 'x' } }), bunker)).toBe(false);
  });

  it('bunker + keyless with an empty or invalid pubkey is not', () => {
    expect(approvalDependantSignable(dep({ persona: { publicKey: '', privateKey: '', displayName: 'x' }, naturalPerson: { publicKey: '', privateKey: '', displayName: 'x' } }), bunker)).toBe(false);
    expect(approvalDependantSignable(dep({ persona: { publicKey: 'not-hex', privateKey: '', displayName: 'x' } }), bunker)).toBe(false);
  });

  it('a view-only or imported dependant is never offered through the Heartwood, even in bunker mode', () => {
    const viewOnly = dep({
      derivationPath: 'imported-view-abcd1234',
      primaryKeypair: 'natural-person',
      naturalPerson: { publicKey: DEP_NP, privateKey: '', displayName: 'Ben' },
      persona: { publicKey: '', privateKey: '', displayName: '' },
    });
    expect(approvalDependantSignable(viewOnly, bunker)).toBe(false);
    expect(approvalDependantSignable(dep({ derivationPath: 'imported-abcd1234' }), bunker)).toBe(false);
  });

  it('a tree-derived dependant (dependant-N) keyless in bunker mode is offered', () => {
    expect(approvalDependantSignable(dep({ derivationPath: 'dependant-12' }), bunker)).toBe(true);
  });

  it('an imported or mirror extra persona on a tree-derived dependant is not offered when it is the acting slot', () => {
    const extra = (derivationName: string, imported?: boolean) =>
      [{ publicKey: DEP_EXTRA, privateKey: '', displayName: 'Extra', derivationName, imported }] as never;
    expect(approvalDependantSignable(dep({ primaryKeypair: DEP_EXTRA, extraPersonas: extra('') }), bunker)).toBe(false);
    expect(approvalDependantSignable(dep({ primaryKeypair: DEP_EXTRA, extraPersonas: extra('', true) }), bunker)).toBe(false);
    expect(approvalDependantSignable(dep({ primaryKeypair: DEP_EXTRA, extraPersonas: extra('dependant-0-persona-1') }), bunker)).toBe(true);
  });

  it('follows the ACTING slot: an extra persona decides, not the keyed persona', () => {
    const keyedPersona = { publicKey: DEP_P, privateKey: KEY, displayName: 'BenGamer' };
    const extra = (privateKey: string, publicKey = DEP_EXTRA) => [{ publicKey, privateKey, displayName: 'Extra' }] as never;
    // Acting slot is the keyless extra: a keyed persona does not make it local.
    expect(approvalDependantSignable(dep({ persona: keyedPersona, primaryKeypair: DEP_EXTRA, extraPersonas: extra('') }), bunker)).toBe(true);
    expect(approvalDependantSignable(dep({ persona: keyedPersona, primaryKeypair: DEP_EXTRA, extraPersonas: extra('') }), { signingMode: 'local', routerUnsupported: false })).toBe(false);
    // Acting slot is a keyed extra: signable locally even when the persona is keyless.
    expect(approvalDependantSignable(dep({ primaryKeypair: DEP_EXTRA, extraPersonas: extra(KEY) }), { signingMode: 'local', routerUnsupported: false })).toBe(true);
  });
});
