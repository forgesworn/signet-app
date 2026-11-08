import { describe, it, expect } from 'vitest';
import {
  toRecoveryWords,
  toNsecRecoveryWords,
  fromRecoveryWords,
  consumeSecretKeyAsNsec,
  parseNsecOrRecoveryWords,
  recoveryWordsSource,
  recoveryWordsCompactBytes,
  parseRestoreInput,
  recoveryWordRole,
  RESTORE_ERROR_COPY,
} from './recovery-words';
import type { RecoveryFailureReason } from './recovery-words';
import { generateMnemonic, splitSecretToWordsV3, decodeNsec, getPublicKey } from './signet';
import { reconstructWordsV3 } from '@forgesworn/shamir-words';
import { recoveryWordsFromBytes } from 'nsec-tree/recovery';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, nip19 } from 'nostr-tools';

// Frozen vectors from nsec-tree/RECOVERY.md — do not regenerate these.
const MNEMONIC_VECTOR =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECOVERY_VECTOR =
  'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// "Scalar-one nsec, exact identity" — kind 2 (raw-nsec-v1), an imported key.
const KIND2_VECTOR = [
  'edge', 'obtain', 'lizard', 'frost', 'kitten', 'own', 'grit',
  ...Array<string>(23).fill('abandon'),
  'diesel',
].join(' ');
// "Scalar-one nsec, nsec-tree source" — kind 3 (nsec-tree-nsec-v1), refused.
const KIND3_VECTOR = [
  'edge', 'obtain', 'seed', 'afford', 'today', 'police', 'pyramid',
  ...Array<string>(23).fill('abandon'),
  'diesel',
].join(' ');
// The published NIP-06 test key ("leader monkey parrot ring guide accident
// before fence cannon height naive bean"), and the raw-nsec words Sapwood's
// own encoder produced for it. Public test material only.
const NIP06_TEST_KEY = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const NIP06_TEST_PUBKEY = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const SAPWOOD_NIP06_WORDS =
  'edge obtain logic quote enemy riot armed legal zebra aunt caught junior hero ramp city whip digital swap blossom prize pumpkin property window girl end avocado speak business town tuna frog';

describe('toRecoveryWords', () => {
  it('reproduces the frozen RECOVERY.md vector', () => {
    expect(toRecoveryWords(MNEMONIC_VECTOR)).toBe(RECOVERY_VECTOR);
  });

  it('is deterministic', () => {
    expect(toRecoveryWords(MNEMONIC_VECTOR)).toBe(toRecoveryWords(MNEMONIC_VECTOR));
  });

  it('produces 19 words for a 12-word mnemonic', () => {
    expect(toRecoveryWords(MNEMONIC_VECTOR).split(' ')).toHaveLength(19);
  });
});

describe('fromRecoveryWords', () => {
  it('round-trips the frozen vector back to the exact mnemonic', () => {
    const result = fromRecoveryWords(RECOVERY_VECTOR);
    expect(result).toEqual({ ok: true, kind: 'mnemonic', mnemonic: MNEMONIC_VECTOR });
  });

  it('round-trips a freshly generated mnemonic', () => {
    const mnemonic = generateMnemonic();
    const words = toRecoveryWords(mnemonic);
    expect(words.split(' ')).toHaveLength(19);
    expect(fromRecoveryWords(words)).toEqual({ ok: true, kind: 'mnemonic', mnemonic });
  });

  it('normalises case and whitespace', () => {
    const messy = `  ${RECOVERY_VECTOR.toUpperCase().replace(/ /g, '\n  ')}  `;
    expect(fromRecoveryWords(messy)).toEqual({ ok: true, kind: 'mnemonic', mnemonic: MNEMONIC_VECTOR });
  });

  it('rejects a bare BIP-39 phrase as not-recovery-words', () => {
    expect(fromRecoveryWords(MNEMONIC_VECTOR)).toEqual({
      ok: false,
      reason: 'not-recovery-words',
    });
  });

  it('rejects an empty string as not-recovery-words', () => {
    expect(fromRecoveryWords('   ')).toEqual({ ok: false, reason: 'not-recovery-words' });
  });

  it('rejects a flipped payload word as checksum', () => {
    const parts = RECOVERY_VECTOR.split(' ');
    parts[7] = 'ability'; // first payload word, was "abandon"
    expect(fromRecoveryWords(parts.join(' '))).toEqual({ ok: false, reason: 'checksum' });
  });

  it('rejects a flipped header word', () => {
    const parts = RECOVERY_VECTOR.split(' ');
    parts[0] = 'zoo';
    const result = fromRecoveryWords(parts.join(' '));
    expect(result.ok).toBe(false);
  });

});

describe('raw-nsec recovery words (kind 2)', () => {
  const SCALAR_ONE_HEX = '00'.repeat(31) + '01';

  it('reproduces the frozen RECOVERY.md scalar-one vector', () => {
    expect(toNsecRecoveryWords(SCALAR_ONE_HEX)).toBe(KIND2_VECTOR);
    expect(KIND2_VECTOR.split(' ')).toHaveLength(31);
  });

  it('restores the frozen vector to the exact scalar-one key', () => {
    const result = fromRecoveryWords(KIND2_VECTOR);
    expect(result.ok && result.kind).toBe('raw-nsec');
    if (!result.ok || result.kind !== 'raw-nsec') return;
    expect(bytesToHex(result.secretKey)).toBe(SCALAR_ONE_HEX);
    result.secretKey.fill(0);
  });

  it('round-trips a fresh key: create, restore, same pubkey', () => {
    const privateKey = bytesToHex(generateSecretKey());
    const words = toNsecRecoveryWords(privateKey);
    expect(words.split(' ')).toHaveLength(31);
    const result = fromRecoveryWords(words);
    if (!result.ok || result.kind !== 'raw-nsec') throw new Error('expected raw-nsec');
    expect(getPublicKey(bytesToHex(result.secretKey))).toBe(getPublicKey(privateKey));
    result.secretKey.fill(0);
  });

  it('restores a Sapwood-produced sequence to the same npub', () => {
    // Produced by Sapwood's own recovery-words implementation
    // (`createNsecRecoveryWords(bytes, false)`, as `key backup` calls it), not
    // by nsec-tree: an independent encoder agreeing byte-for-byte. The key is
    // the published NIP-06 test vector, never a real one.
    const result = fromRecoveryWords(SAPWOOD_NIP06_WORDS);
    if (!result.ok || result.kind !== 'raw-nsec') throw new Error('expected raw-nsec');
    expect(bytesToHex(result.secretKey)).toBe(NIP06_TEST_KEY);
    expect(getPublicKey(bytesToHex(result.secretKey))).toBe(NIP06_TEST_PUBKEY);
    result.secretKey.fill(0);
    // And this app encodes the same key to the same words.
    expect(toNsecRecoveryWords(NIP06_TEST_KEY)).toBe(SAPWOOD_NIP06_WORDS);
  });

  it('zero-fills the key once consumed as an nsec', () => {
    const result = fromRecoveryWords(SAPWOOD_NIP06_WORDS);
    if (!result.ok || result.kind !== 'raw-nsec') throw new Error('expected raw-nsec');
    const bytes = result.secretKey;
    const nsec = consumeSecretKeyAsNsec(bytes);
    expect(nsec.startsWith('nsec1')).toBe(true);
    expect(getPublicKey(bytesToHex(decodeNsec(nsec)))).toBe(NIP06_TEST_PUBKEY);
    expect(bytes.every(b => b === 0)).toBe(true);
  });

  it('rejects a flipped key word as checksum', () => {
    const parts = KIND2_VECTOR.split(' ');
    parts[10] = 'ability';
    expect(fromRecoveryWords(parts.join(' '))).toEqual({ ok: false, reason: 'checksum' });
  });

  it('refuses a malformed private key rather than encoding it', () => {
    expect(() => toNsecRecoveryWords('')).toThrow();
    expect(() => toNsecRecoveryWords('zz'.repeat(32))).toThrow();
  });
});

describe('tree-root nsec recovery words (kind 3)', () => {
  it('refuses the frozen vector with its own reason', () => {
    expect(KIND3_VECTOR.split(' ')).toHaveLength(31);
    expect(fromRecoveryWords(KIND3_VECTOR)).toEqual({ ok: false, reason: 'tree-root-nsec' });
    expect(parseRestoreInput(KIND3_VECTOR, 'recovery-words')).toEqual({ ok: false, reason: 'tree-root-nsec' });
  });

  it('says plainly what it is', () => {
    expect(RESTORE_ERROR_COPY['tree-root-nsec']).toContain('tree-root nsec');
    expect(RESTORE_ERROR_COPY['tree-root-nsec']).not.toContain('—');
  });
});

describe('parseNsecOrRecoveryWords', () => {
  it('passes an nsec through untouched', () => {
    const nsec = nip19.nsecEncode(hexToBytes(NIP06_TEST_KEY));
    expect(parseNsecOrRecoveryWords(`  ${nsec}\n`)).toEqual({ ok: true, nsec });
  });

  it('turns raw-nsec recovery words into the same nsec', () => {
    const nsec = nip19.nsecEncode(hexToBytes(NIP06_TEST_KEY));
    expect(parseNsecOrRecoveryWords(SAPWOOD_NIP06_WORDS)).toEqual({ ok: true, nsec });
  });

  it('refuses a whole-Signet sequence, a tree-root nsec and bare BIP-39', () => {
    expect(parseNsecOrRecoveryWords(RECOVERY_VECTOR)).toEqual({ ok: false, reason: 'whole-signet' });
    expect(parseNsecOrRecoveryWords(KIND3_VECTOR)).toEqual({ ok: false, reason: 'tree-root-nsec' });
    expect(parseNsecOrRecoveryWords(MNEMONIC_VECTOR)).toEqual({ ok: false, reason: 'not-recovery-words' });
  });

  it('refuses a single token that is not an nsec', () => {
    expect(parseNsecOrRecoveryWords('npub1abc')).toEqual({ ok: false, reason: 'not-nsec' });
  });
});

describe('recoveryWordsSource', () => {
  const empty = { publicKey: '', privateKey: '', displayName: '' };
  const key = { publicKey: 'b'.repeat(64), privateKey: '1'.repeat(64), displayName: 'Me' };
  const base = { mnemonic: '', primaryKeypair: 'persona' as const, isChild: false, naturalPerson: empty, persona: key };

  it('is the mnemonic when there is one', () => {
    expect(recoveryWordsSource({ ...base, mnemonic: MNEMONIC_VECTOR })).toBe('mnemonic');
  });

  it('is the raw key for an identity created from an nsec, in either slot', () => {
    expect(recoveryWordsSource(base)).toBe('raw-nsec');
    expect(recoveryWordsSource({ ...base, primaryKeypair: 'natural-person', naturalPerson: key, persona: empty })).toBe('raw-nsec');
  });

  it('is nothing when the key is not on this device', () => {
    expect(recoveryWordsSource({ ...base, persona: { ...key, privateKey: '' } })).toBeNull();
    expect(recoveryWordsSource({ ...base, isChild: true })).toBeNull();
  });

  it('is nothing for a tree identity that lost its mnemonic but kept derived keys', () => {
    expect(recoveryWordsSource({ ...base, naturalPerson: { ...key, privateKey: '2'.repeat(64) } })).toBeNull();
  });
});

describe('recoveryWordsCompactBytes', () => {
  it('serialises a 19-word sequence into 28 bytes with the word count first', () => {
    const bytes = recoveryWordsCompactBytes(MNEMONIC_VECTOR);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(28);
    expect(bytes[0]).toBe(19);
  });
});

describe('parseRestoreInput', () => {
  it('accepts recovery words in recovery-words mode', () => {
    expect(parseRestoreInput(RECOVERY_VECTOR, 'recovery-words')).toEqual({
      ok: true,
      kind: 'mnemonic',
      mnemonic: MNEMONIC_VECTOR,
    });
  });

  it('accepts raw-nsec recovery words in recovery-words mode', () => {
    const parsed = parseRestoreInput(KIND2_VECTOR, 'recovery-words');
    expect(parsed.ok && parsed.kind).toBe('raw-nsec');
    if (parsed.ok && parsed.kind === 'raw-nsec') parsed.secretKey.fill(0);
  });

  it('refuses raw-nsec recovery words in legacy-bip39 mode', () => {
    expect(parseRestoreInput(KIND2_VECTOR, 'legacy-bip39')).toEqual({ ok: false, reason: 'legacy-invalid' });
  });

  it('refuses a bare BIP-39 phrase in recovery-words mode', () => {
    expect(parseRestoreInput(MNEMONIC_VECTOR, 'recovery-words')).toEqual({
      ok: false,
      reason: 'not-recovery-words',
    });
  });

  it('accepts a bare BIP-39 phrase in legacy-bip39 mode', () => {
    expect(parseRestoreInput(`  ${MNEMONIC_VECTOR.toUpperCase()}  `, 'legacy-bip39')).toEqual({
      ok: true,
      kind: 'mnemonic',
      mnemonic: MNEMONIC_VECTOR,
    });
  });

  it('refuses recovery words in legacy-bip39 mode', () => {
    expect(parseRestoreInput(RECOVERY_VECTOR, 'legacy-bip39')).toEqual({
      ok: false,
      reason: 'legacy-invalid',
    });
  });

  it('refuses a bad-checksum 12-word phrase in legacy-bip39 mode', () => {
    const bad = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    expect(parseRestoreInput(bad, 'legacy-bip39')).toEqual({
      ok: false,
      reason: 'legacy-invalid',
    });
  });
});

describe('RESTORE_ERROR_COPY', () => {
  it('has non-empty copy for every recovery failure reason', () => {
    const reasons: RecoveryFailureReason[] = [
      'not-recovery-words',
      'checksum',
      'fingerprint',
      'unsupported-kind',
      'tree-root-nsec',
    ];
    for (const reason of reasons) {
      expect(RESTORE_ERROR_COPY[reason].length).toBeGreaterThan(0);
    }
  });

  it('points a 12-word holder at the older-backup option', () => {
    expect(RESTORE_ERROR_COPY['not-recovery-words']).toContain('older-backup option');
  });
});

describe('Shamir v3 over the recovery-words envelope', () => {
  it('reconstructs the exact 19-word sequence from any 2 of 3 shares', () => {
    const secret = recoveryWordsCompactBytes(MNEMONIC_VECTOR);
    const shares = splitSecretToWordsV3(secret, 2, 3, {
      payloadKind: 'forgesworn-recovery-words-v1',
    });
    expect(shares).toHaveLength(3);

    for (const pair of [[0, 1], [0, 2], [1, 2]]) {
      const result = reconstructWordsV3([shares[pair[0]]!, shares[pair[1]]!]);
      expect(result.payloadKind).toBe('forgesworn-recovery-words-v1');
      expect(recoveryWordsFromBytes(result.secret)).toBe(RECOVERY_VECTOR);
      result.secret.fill(0);
    }
    secret.fill(0);
  });

  it('round-trips back to the original mnemonic through fromRecoveryWords', () => {
    const secret = recoveryWordsCompactBytes(MNEMONIC_VECTOR);
    const shares = splitSecretToWordsV3(secret, 2, 3, {
      payloadKind: 'forgesworn-recovery-words-v1',
    });
    secret.fill(0);
    const result = reconstructWordsV3([shares[1]!, shares[2]!]);
    const words = recoveryWordsFromBytes(result.secret);
    result.secret.fill(0);
    expect(fromRecoveryWords(words)).toEqual({ ok: true, kind: 'mnemonic', mnemonic: MNEMONIC_VECTOR });
  });

  it('refuses shares mixed across separate split operations', () => {
    const secret = recoveryWordsCompactBytes(MNEMONIC_VECTOR);
    const a = splitSecretToWordsV3(secret, 2, 3, { payloadKind: 'forgesworn-recovery-words-v1' });
    const b = splitSecretToWordsV3(secret, 2, 3, { payloadKind: 'forgesworn-recovery-words-v1' });
    secret.fill(0);
    expect(() => reconstructWordsV3([a[0]!, b[1]!])).toThrow();
  });
});

describe('recoveryWordRole', () => {
  it('splits an envelope into format, header and secret', () => {
    for (const total of [19, 31]) {
      expect(recoveryWordRole(1, total)).toBe('format');
      expect(recoveryWordRole(2, total)).toBe('format');
      expect(recoveryWordRole(3, total)).toBe('header');
      expect(recoveryWordRole(7, total)).toBe('header');
      expect(recoveryWordRole(8, total)).toBe('secret');
      expect(recoveryWordRole(total, total)).toBe('secret');
    }
  });

  it('labels nothing outside the sequence, or for a non-envelope length', () => {
    expect(recoveryWordRole(0, 19)).toBeNull();
    expect(recoveryWordRole(20, 19)).toBeNull();
    expect(recoveryWordRole(1.5, 19)).toBeNull();
    // A bare BIP-39 mnemonic has no header to label.
    expect(recoveryWordRole(1, 12)).toBeNull();
    expect(recoveryWordRole(1, 24)).toBeNull();
  });

  it('the words it calls format really are constant across fresh keys', () => {
    // The caption claims words 1-2 never change. Generate real keys and prove
    // it, so a format change that moves the fingerprint earlier fails here
    // rather than silently turning the copy into a lie.
    const openings = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const words = toRecoveryWords(generateMnemonic()).split(' ');
      const formatWords = words.filter(
        (_, idx) => recoveryWordRole(idx + 1, words.length) === 'format',
      );
      openings.add(formatWords.join(' '));
    }
    expect([...openings]).toEqual(['edge obtain']);
  });

  it('agrees with the frozen vector', () => {
    const words = RECOVERY_VECTOR.split(' ');
    expect(words.filter((_, i) => recoveryWordRole(i + 1, words.length) === 'secret')).toEqual(
      MNEMONIC_VECTOR.split(' '),
    );
  });
});
