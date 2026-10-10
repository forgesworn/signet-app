import { describe, expect, it } from 'vitest';
import { fromMnemonic, derive } from 'nsec-tree';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveDependantIdentity, deriveKeypair, importFromLiteMnemonic } from './signet';
import { createNewIdentity, importFromMnemonic, importFromNsec } from './signet';
import { nip19 } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { signAuthChallenge } from './signet';
import { LocalSigningBackend } from './signing-backend';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_NSEC = nip19.nsecEncode(new Uint8Array(32).fill(1));

describe('signAuthChallenge', () => {
  it('cryptographically binds the requested app name with the challenge and origin', async () => {
    const backend = new LocalSigningBackend('1'.repeat(64));
    try {
      const { authEvent } = await signAuthChallenge(backend, 'a'.repeat(64), 'https://consumer.example', undefined, 'Consumer App');
      expect(authEvent.tags).toEqual([['challenge', 'a'.repeat(64)], ['origin', 'https://consumer.example'], ['app', 'Consumer App']]);
      expect(verifyEvent(authEvent)).toBe(true);
      const tampered = JSON.parse(JSON.stringify(authEvent));
      tampered.tags = authEvent.tags.map(t => t[0] === 'app' ? ['app', 'Another app'] : t);
      expect(verifyEvent(tampered)).toBe(false);
    } finally { backend.destroy(); }
  });

  it('keeps unnamed requests compatible', async () => {
    const backend = new LocalSigningBackend('1'.repeat(64));
    try {
      const { authEvent } = await signAuthChallenge(backend, 'a'.repeat(64), 'https://consumer.example');
      expect(authEvent.tags.some(t => t[0] === 'app')).toBe(false);
      expect(verifyEvent(authEvent)).toBe(true);
    } finally { backend.destroy(); }
  });
});

function litePubkey(mnemonic: string, name: string): string {
  const root = fromMnemonic(mnemonic);
  try {
    return bytesToHex(derive(root, name, 0).publicKey);
  } finally {
    root.destroy();
  }
}

describe('importFromLiteMnemonic', () => {
  it('imports the named Lite identity as the primary Persona', () => {
    const identity = importFromLiteMnemonic(MNEMONIC, 'default', 'DarkWolf99');
    const expectedLitePubkey = litePubkey(MNEMONIC, 'default');

    expect(identity.id).toBe(expectedLitePubkey);
    expect(identity.primaryKeypair).toBe('persona');
    expect(identity.persona.publicKey).toBe(expectedLitePubkey);
    expect(identity.persona.displayName).toBe('DarkWolf99');
    expect(identity.backedUp).toBe(true);
  });

  it('also derives a dormant MySignet natural-person key from the same words', () => {
    const identity = importFromLiteMnemonic(MNEMONIC, 'default', 'DarkWolf99');
    const np = deriveKeypair(MNEMONIC, 'natural-person');
    const standardPersona = deriveKeypair(MNEMONIC, 'persona');

    expect(identity.naturalPerson.publicKey).toBe(np.publicKey);
    expect(identity.naturalPerson.displayName).toBe('');
    expect(identity.persona.publicKey).not.toBe(standardPersona.publicKey);
  });

  it('rejects invalid words and empty Lite identity names', () => {
    expect(() => importFromLiteMnemonic('not valid words', 'default', 'Name')).toThrow(/invalid backup words/i);
    expect(() => importFromLiteMnemonic(MNEMONIC, '   ', 'Name')).toThrow(/identity name/i);
  });
});

describe('canonical dependant derivation', () => {
  it('reproduces the frozen signet-protocol dependant-0 vector', () => {
    const dependant = deriveDependantIdentity(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
      'dependant-0',
    );
    expect(dependant.naturalPerson.publicKey).toBe('2353d09c8668dfb41e80b5191bcac280bc42ee679f487f310958a88c5202b75a');
    expect(dependant.persona.publicKey).toBe('0cbbe50a249f6c047580a735a8944c8b50fd82c9533f8c831923b049df951e5f');
  });

  it('rejects a non-canonical dependant path', () => {
    expect(() => deriveDependantIdentity(MNEMONIC, 'dependant-N')).toThrow(/derivation path/i);
  });
});

describe('naturalPersonActive on creation and import', () => {
  it('a persona-primary mnemonic identity is created with the real identity dormant', () => {
    const identity = importFromMnemonic(MNEMONIC, 'Shade', 'persona', false);
    expect(identity.naturalPersonActive).toBe(false);
    expect(identity.naturalPerson.displayName).toBe('');
    expect(identity.naturalPerson.publicKey).not.toBe('');
  });

  it('a natural-person-primary mnemonic identity is created active', () => {
    const identity = importFromMnemonic(MNEMONIC, 'Real Name', 'natural-person', false);
    expect(identity.naturalPersonActive).toBe(true);
    expect(identity.naturalPerson.displayName).toBe('Real Name');
  });

  it('createNewIdentity carries the same rule', () => {
    expect(createNewIdentity('Shade', 'persona', false).naturalPersonActive).toBe(false);
    expect(createNewIdentity('Real Name', 'natural-person', false).naturalPersonActive).toBe(true);
  });

  it('a Lite import lands dormant and is marked as a Lite import', () => {
    const identity = importFromLiteMnemonic(MNEMONIC, 'default', 'DarkWolf99');
    expect(identity.naturalPersonActive).toBe(false);
    expect(identity.liteImported).toBe(true);
    expect(identity.backedUp).toBe(true);
  });

  it('an nsec import into the persona slot lands dormant and is not a Lite import', () => {
    const identity = importFromNsec(TEST_NSEC, 'FromNostr', 'persona');
    expect(identity.naturalPersonActive).toBe(false);
    expect(identity.naturalPerson.publicKey).toBe('');
    expect(identity.liteImported).toBeUndefined();
  });
});
