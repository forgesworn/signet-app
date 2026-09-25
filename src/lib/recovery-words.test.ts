import { describe, it, expect } from 'vitest';
import {
  toRecoveryWords,
  fromRecoveryWords,
  recoveryWordsCompactBytes,
  parseRestoreInput,
  recoveryWordRole,
  RESTORE_ERROR_COPY,
} from './recovery-words';
import type { RecoveryFailureReason } from './recovery-words';
import { generateMnemonic, splitSecretToWordsV3 } from './signet';
import { reconstructWordsV3 } from '@forgesworn/shamir-words';
import { recoveryWordsFromBytes } from 'nsec-tree/recovery';

// Frozen vectors from nsec-tree/RECOVERY.md — do not regenerate these.
const MNEMONIC_VECTOR =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECOVERY_VECTOR =
  'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// "Scalar-one nsec, exact identity" — kind 2 (raw-nsec-v1), which MySignet must refuse.
const KIND2_VECTOR = [
  'edge', 'obtain', 'lizard', 'frost', 'kitten', 'own', 'grit',
  ...Array<string>(23).fill('abandon'),
  'diesel',
].join(' ');

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
    expect(result).toEqual({ ok: true, mnemonic: MNEMONIC_VECTOR });
  });

  it('round-trips a freshly generated mnemonic', () => {
    const mnemonic = generateMnemonic();
    const words = toRecoveryWords(mnemonic);
    expect(words.split(' ')).toHaveLength(19);
    expect(fromRecoveryWords(words)).toEqual({ ok: true, mnemonic });
  });

  it('normalises case and whitespace', () => {
    const messy = `  ${RECOVERY_VECTOR.toUpperCase().replace(/ /g, '\n  ')}  `;
    expect(fromRecoveryWords(messy)).toEqual({ ok: true, mnemonic: MNEMONIC_VECTOR });
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

  it('rejects the kind-2 (raw nsec) frozen vector as unsupported-kind', () => {
    expect(KIND2_VECTOR.split(' ')).toHaveLength(31);
    expect(fromRecoveryWords(KIND2_VECTOR)).toEqual({
      ok: false,
      reason: 'unsupported-kind',
    });
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
      mnemonic: MNEMONIC_VECTOR,
    });
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
    expect(fromRecoveryWords(words)).toEqual({ ok: true, mnemonic: MNEMONIC_VECTOR });
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
