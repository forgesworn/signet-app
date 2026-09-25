import { describe, it, expect } from 'vitest';
import { createLocalBackends } from './signing-backend';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { SignetIdentity } from '../types';
import { resolveGuardianBackend, assertSigningIdentity, guardianSigningPubkeys, approvalGuardianPubkeys, isImportedGuardianPersona } from './guardian-signing';

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
