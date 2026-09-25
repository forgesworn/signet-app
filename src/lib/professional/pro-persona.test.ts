// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deriveProfessionalPersona, proModeBlockedReason } from './pro-persona';

// A real 12-word mnemonic used for determinism tests only (no real keys behind it).
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveProfessionalPersona', () => {
  it('returns stable pubkey across multiple calls with the same mnemonic', () => {
    const a = deriveProfessionalPersona(TEST_MNEMONIC);
    const b = deriveProfessionalPersona(TEST_MNEMONIC);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it('pubkey is 64 hex chars', () => {
    const { publicKey } = deriveProfessionalPersona(TEST_MNEMONIC);
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('privkey is 64 hex chars', () => {
    const { privateKey } = deriveProfessionalPersona(TEST_MNEMONIC);
    expect(privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Pro persona pubkey differs from NP pubkey derived from the same mnemonic', async () => {
    // The nsec-tree paths are hardened — sibling pubkeys must not be equal.
    const { deriveKeypair } = await import('../signet');
    const np = deriveKeypair(TEST_MNEMONIC, 'natural-person');
    const pro = deriveProfessionalPersona(TEST_MNEMONIC);
    expect(pro.publicKey).not.toBe(np.publicKey);
  });

  it('Pro persona pubkey differs from anonymous Persona pubkey', async () => {
    const { deriveKeypair } = await import('../signet');
    const anon = deriveKeypair(TEST_MNEMONIC, 'persona');
    const pro = deriveProfessionalPersona(TEST_MNEMONIC);
    expect(pro.publicKey).not.toBe(anon.publicKey);
  });

  it('different mnemonics yield different Pro persona pubkeys', () => {
    const mnemonic2 =
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    const a = deriveProfessionalPersona(TEST_MNEMONIC);
    const b = deriveProfessionalPersona(mnemonic2);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('proModeBlockedReason', () => {
  it('returns null when mnemonic is present (no bunker)', () => {
    expect(proModeBlockedReason({ hasMnemonic: true, bunkerActive: false })).toBeNull();
  });

  it('returns null when mnemonic is present even if bunker is active', () => {
    // Mnemonic present = Pro mode available regardless of bunker state.
    expect(proModeBlockedReason({ hasMnemonic: true, bunkerActive: true })).toBeNull();
  });

  it('returns a non-empty string when bunker is active and mnemonic is absent', () => {
    const reason = proModeBlockedReason({ hasMnemonic: false, bunkerActive: true });
    expect(typeof reason).toBe('string');
    expect((reason as string).length).toBeGreaterThan(0);
  });

  it('returns null when neither mnemonic nor bunker (offline or setup not done)', () => {
    // If no bunker is active, we're not in a Heartwood-blocked state — just incomplete setup.
    expect(proModeBlockedReason({ hasMnemonic: false, bunkerActive: false })).toBeNull();
  });

  it('allows pro mode in bunker mode when the signer serves personas and the pro pubkey is known', () => {
    expect(proModeBlockedReason({ hasMnemonic: false, bunkerActive: true, bunkerServesPersonas: true, proPubkeyKnown: true })).toBeNull();
  });

  it('still blocks in bunker mode when the signer serves personas but no pro pubkey is stored', () => {
    expect(proModeBlockedReason({ hasMnemonic: false, bunkerActive: true, bunkerServesPersonas: true, proPubkeyKnown: false })).not.toBeNull();
  });

  it('still blocks in bunker mode when the signer cannot serve personas', () => {
    expect(proModeBlockedReason({ hasMnemonic: false, bunkerActive: true, bunkerServesPersonas: false, proPubkeyKnown: true })).not.toBeNull();
  });
});
