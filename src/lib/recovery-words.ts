/**
 * ForgeSworn Recovery Words v1 — the app's only contact point with
 * `nsec-tree/recovery`.
 *
 * A bare BIP-39 phrase does not say what it is: the same words are a valid
 * input to several ForgeSworn derivations, and guessing the wrong one yields a
 * valid but *different* npub rather than an error. Recovery words are a typed,
 * versioned, checksummed envelope (7 header words + the unchanged BIP-39
 * payload) carrying a public-key fingerprint that fails a wrong interpretation
 * before any key is returned.
 *
 * Storage is untouched: `SignetIdentity.mnemonic` remains the raw BIP-39
 * string. These functions convert at the app edge, for display, restore and
 * Shamir only.
 *
 * Design: the internal recovery-words-adoption design doc, §3
 * Envelope spec: nsec-tree/RECOVERY.md
 */

import {
  createMnemonicRecoveryWords,
  decodeRecoveryWords,
  restoreRecoveryWords,
  recoveryWordsToBytes,
  RECOVERY_HEADER_WORDS,
} from 'nsec-tree/recovery';
import { validateMnemonic } from './signet';

export type RecoveryFailureReason =
  /** Too few words, unknown word, or a header that is not a ForgeSworn envelope. */
  | 'not-recovery-words'
  /** BIP-39 payload checksum or envelope checksum did not verify. */
  | 'checksum'
  /** Envelope decoded but the derived public fingerprint did not match. */
  | 'fingerprint'
  /** A ForgeSworn envelope of a kind (or passphrase flag) MySignet does not restore. */
  | 'unsupported-kind';

export type RecoveryRestoreResult =
  | { readonly ok: true; readonly mnemonic: string }
  | { readonly ok: false; readonly reason: RecoveryFailureReason };

/** How the restore textarea is being interpreted. Chosen by the user, never sniffed. */
export type RestoreInputMode = 'recovery-words' | 'legacy-bip39';

export type RestoreParseResult =
  | { readonly ok: true; readonly mnemonic: string }
  | { readonly ok: false; readonly reason: RecoveryFailureReason | 'legacy-invalid' };

/**
 * Error-message → reason table. `nsec-tree` throws `NsecTreeError` with these
 * messages; matching on a substring keeps us decoupled from the exact prose
 * while still distinguishing "not our format" from "wrong words".
 * Order matters only in that earlier entries win; the needles do not overlap.
 */
const REASON_BY_MESSAGE: ReadonlyArray<readonly [string, RecoveryFailureReason]> = [
  // decodeRecoveryWords / decodeHeader — not a ForgeSworn envelope at all
  ['missing typed header or payload', 'not-recovery-words'],
  ['bad magic', 'not-recovery-words'],
  ['Unknown recovery word', 'not-recovery-words'],
  ['recovery header must contain', 'not-recovery-words'],
  // decodeRecoveryWords / validatePayload — envelope shape is right, contents are not
  ['invalid BIP-39 checksum', 'checksum'],
  ['recovery checksum mismatch', 'checksum'],
  ['invalid entropy length', 'checksum'],
  ['must contain 32 bytes', 'checksum'],
  // decodeHeader / restoreRecoveryWords — a ForgeSworn envelope we decline to restore
  ['recovery words version', 'unsupported-kind'],
  ['recovery flags', 'unsupported-kind'],
  ['recovery kind', 'unsupported-kind'],
  ['Passphrase flag is only valid', 'unsupported-kind'],
  ['Recovery passphrase required', 'unsupported-kind'],
  ['do not use a passphrase', 'unsupported-kind'],
  // restoreRecoveryWords — derived key does not match the envelope's fingerprint
  ['fingerprint mismatch', 'fingerprint'],
  ['not a valid nsec', 'fingerprint'],
];

function reasonFor(error: unknown): RecoveryFailureReason {
  const message = error instanceof Error ? error.message : '';
  for (const [needle, reason] of REASON_BY_MESSAGE) {
    if (message.includes(needle)) return reason;
  }
  return 'not-recovery-words';
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Render a stored BIP-39 mnemonic as ForgeSworn recovery words for display or
 * Shamir. No passphrase — MySignet never sets one. Throws if the mnemonic is
 * invalid; every call site passes `identity.mnemonic`, valid by construction,
 * and guards the empty-string (nsec-imported) case before calling.
 */
export function toRecoveryWords(mnemonic: string): string {
  return createMnemonicRecoveryWords(mnemonic);
}

/**
 * Parse typed recovery words back to the BIP-39 mnemonic the rest of the app
 * stores and derives from. Returns a discriminated result rather than throwing
 * so the onboarding screens map reasons to copy without try/catch.
 *
 * Bare BIP-39 is deliberately rejected (`not-recovery-words`) — the legacy path
 * is an explicit user choice, never a fallback.
 *
 * The returned mnemonic is the envelope's normalised payload word slice, which
 * is byte-identical to `entropyToMnemonic(decoded.payload)` because
 * `decodeRecoveryWords` has already proved the slice is a canonical, valid,
 * lowercase English BIP-39 sequence. Taking the slice avoids adding a direct
 * `@scure/bip39` dependency to the app.
 */
export function fromRecoveryWords(text: string): RecoveryRestoreResult {
  const canonical = normalise(text);

  let kind: string;
  let passphraseRequired: boolean;
  try {
    const decoded = decodeRecoveryWords(canonical);
    kind = decoded.kind;
    passphraseRequired = decoded.passphraseRequired;
    decoded.payload.fill(0);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }

  if (kind !== 'nsec-tree-mnemonic-v1' || passphraseRequired) {
    return { ok: false, reason: 'unsupported-kind' };
  }

  // Fingerprint check: proves the payload really derives the key the envelope
  // claims, before we hand the mnemonic downstream. The root is destroyed
  // immediately — we only wanted the verdict.
  try {
    const restored = restoreRecoveryWords(canonical);
    if (restored.type === 'tree-root') restored.root.destroy();
    else restored.privateKey.fill(0);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }

  return {
    ok: true,
    mnemonic: canonical.split(' ').slice(RECOVERY_HEADER_WORDS).join(' '),
  };
}

/** What a single recovery word is, for a display that walks or lists them. */
export type RecoveryWordRole = 'format' | 'header' | 'secret';

/**
 * Classify word `index` (1-based) of a `total`-word sequence, or `null` when
 * `total` is not a ForgeSworn envelope length (7 header words plus a 12- or
 * 24-word BIP-39 payload) or `index` is out of range.
 *
 * The header packs magic, version and kind before it reaches the fingerprint,
 * so words 1-2 are byte-identical on every ForgeSworn recovery sequence ever
 * produced ("edge obtain") and word 3 has only 32 possible values. A list that
 * does not say so teaches its reader that a fresh key looks like the last one
 * — which is exactly how a genuinely repeated key would look too. Mirrors
 * `recovery_word_role` in heartwood-esp32's `common/src/recovery_words.rs`;
 * the two surfaces must caption the same sequence the same way.
 */
export function recoveryWordRole(index: number, total: number): RecoveryWordRole | null {
  if (total !== RECOVERY_HEADER_WORDS + 12 && total !== RECOVERY_HEADER_WORDS + 24) return null;
  if (!Number.isInteger(index) || index < 1 || index > total) return null;
  if (index <= 2) return 'format';
  if (index <= RECOVERY_HEADER_WORDS) return 'header';
  return 'secret';
}

/**
 * The compact 28-byte (19-word) serialisation the Shamir page splits. Byte 0 is
 * the word count; the rest are 11-bit BIP-39 indices. The caller owns the
 * buffer and MUST zero-fill it after use.
 */
export function recoveryWordsCompactBytes(mnemonic: string): Uint8Array {
  return recoveryWordsToBytes(toRecoveryWords(mnemonic));
}

/**
 * Mode-aware restore parse shared by both onboarding screens. The mode is the
 * user's explicit choice (default box vs the "older 12-word backup" toggle);
 * nothing sniffs word counts.
 */
export function parseRestoreInput(text: string, mode: RestoreInputMode): RestoreParseResult {
  if (mode === 'legacy-bip39') {
    const mnemonic = normalise(text);
    if (!validateMnemonic(mnemonic)) return { ok: false, reason: 'legacy-invalid' };
    return { ok: true, mnemonic };
  }
  return fromRecoveryWords(text);
}

/** User-facing error copy per recovery reason (spec §5). */
export const RESTORE_ERROR_COPY: Readonly<Record<RecoveryFailureReason, string>> = {
  'not-recovery-words':
    'Recovery words are 19 or 31 words. Got a 12-word backup from before? Use the older-backup option.',
  checksum: 'Some words don’t match. Check each word and the order.',
  fingerprint: 'Some words don’t match. Check each word and the order.',
  'unsupported-kind':
    'These are ForgeSworn recovery words for a different kind of key. MySignet restores from the words it showed you in Settings.',
};
