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
 * Two kinds are shown and restored here: `nsec-tree-mnemonic-v1` (a whole
 * Signet, 19 words for a 12-word seed) and `raw-nsec-v1` (one imported Nostr
 * key, 31 words: the 32-byte key as 24 BIP-39 words behind the 7-word header).
 * The third kind, `nsec-tree-nsec-v1`, is a tree-root nsec backup; this app
 * has no tree-root nsec identity to restore it into, so it is refused with its
 * own reason rather than a generic one.
 *
 * Storage is untouched: `SignetIdentity.mnemonic` remains the raw BIP-39
 * string, and an imported key stays a hex `privateKey` on its slot. These
 * functions convert at the app edge, for display, restore and Shamir only.
 *
 * Design: the internal recovery-words-adoption design doc, §3
 * Envelope spec: nsec-tree/RECOVERY.md
 */

import {
  createMnemonicRecoveryWords,
  createNsecRecoveryWords,
  decodeRecoveryWords,
  restoreRecoveryWords,
  recoveryWordsToBytes,
  RECOVERY_HEADER_WORDS,
} from 'nsec-tree/recovery';
import { hexToBytes } from '@noble/hashes/utils.js';
import { nip19 } from 'nostr-tools';
import { validateMnemonic, isValidHexKey } from './signet';
import type { SignetIdentity } from '../types';

export type RecoveryFailureReason =
  /** Too few words, unknown word, or a header that is not a ForgeSworn envelope. */
  | 'not-recovery-words'
  /** BIP-39 payload checksum or envelope checksum did not verify. */
  | 'checksum'
  /** Envelope decoded but the derived public fingerprint did not match. */
  | 'fingerprint'
  /** A ForgeSworn envelope of a kind (or passphrase flag) MySignet does not restore. */
  | 'unsupported-kind'
  /** A valid `nsec-tree-nsec-v1` envelope: a tree-root nsec backup, which MySignet cannot restore. */
  | 'tree-root-nsec';

/**
 * A successful restore is one of two things, and every caller must say which
 * it handles: a whole Signet (the BIP-39 mnemonic the app stores) or one
 * imported Nostr key. The raw key arrives as bytes; the caller owns that
 * buffer and MUST zero-fill it once used (`consumeSecretKeyAsNsec` does both).
 */
export type RecoveryRestoreSuccess =
  | { readonly ok: true; readonly kind: 'mnemonic'; readonly mnemonic: string }
  | { readonly ok: true; readonly kind: 'raw-nsec'; readonly secretKey: Uint8Array };

export type RecoveryRestoreResult =
  | RecoveryRestoreSuccess
  | { readonly ok: false; readonly reason: RecoveryFailureReason };

/** How the restore textarea is being interpreted. Chosen by the user, never sniffed. */
export type RestoreInputMode = 'recovery-words' | 'legacy-bip39';

export type RestoreParseResult =
  | RecoveryRestoreSuccess
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
 * Render an imported Nostr private key (64-char hex, as stored on a slot) as
 * `raw-nsec-v1` recovery words: 7 header words + 24 key words, 31 in all.
 * Byte-identical to what Sapwood `key backup` and Heartwood emit for the same
 * key. Throws on a malformed key; callers guard the keyless case first.
 *
 * The library copies its input and zero-fills its own copy; the bytes decoded
 * here are ours, so they are zero-filled too.
 */
export function toNsecRecoveryWords(privateKeyHex: string): string {
  if (!isValidHexKey(privateKeyHex)) throw new Error('Not a private key');
  const secret = hexToBytes(privateKeyHex);
  try {
    return createNsecRecoveryWords(secret, 'raw');
  } finally {
    secret.fill(0);
  }
}

/**
 * Parse typed recovery words. Returns a discriminated result rather than
 * throwing so the screens map reasons to copy without try/catch.
 *
 * - `nsec-tree-mnemonic-v1` → `{ kind: 'mnemonic', mnemonic }`, the BIP-39
 *   mnemonic the rest of the app stores and derives from.
 * - `raw-nsec-v1` → `{ kind: 'raw-nsec', secretKey }`, the exact key, already
 *   checked against the envelope's fingerprint. The caller owns `secretKey`
 *   and MUST zero-fill it.
 * - `nsec-tree-nsec-v1` → `tree-root-nsec`, refused by name.
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

  if (kind === 'nsec-tree-nsec-v1') return { ok: false, reason: 'tree-root-nsec' };
  if ((kind !== 'nsec-tree-mnemonic-v1' && kind !== 'raw-nsec-v1') || passphraseRequired) {
    return { ok: false, reason: 'unsupported-kind' };
  }

  // Fingerprint check: proves the payload really derives the key the envelope
  // claims, before anything goes downstream. A mnemonic's root is destroyed
  // immediately (we only wanted the verdict); a raw nsec's verified key IS the
  // result, handed to the caller to own and zero-fill.
  let restored: ReturnType<typeof restoreRecoveryWords>;
  try {
    restored = restoreRecoveryWords(canonical);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }

  if (restored.type === 'raw-nsec') {
    if (kind !== 'raw-nsec-v1') {
      restored.privateKey.fill(0);
      return { ok: false, reason: 'unsupported-kind' };
    }
    return { ok: true, kind: 'raw-nsec', secretKey: restored.privateKey };
  }

  restored.root.destroy();
  if (kind !== 'nsec-tree-mnemonic-v1') return { ok: false, reason: 'unsupported-kind' };
  return {
    ok: true,
    kind: 'mnemonic',
    mnemonic: canonical.split(' ').slice(RECOVERY_HEADER_WORDS).join(' '),
  };
}

/**
 * Encode a restored raw key as the `nsec1…` string the existing nsec import
 * paths take, and zero-fill the bytes. The string itself cannot be zeroised
 * (JavaScript strings are immutable); it lives exactly as long as the nsec a
 * user would have pasted into the same path.
 */
export function consumeSecretKeyAsNsec(secretKey: Uint8Array): string {
  try {
    return nip19.nsecEncode(secretKey);
  } finally {
    secretKey.fill(0);
  }
}

/** Which recovery words this identity can show on this device, if any. */
export type RecoveryWordsSource = 'mnemonic' | 'raw-nsec' | null;

/**
 * `mnemonic` for a tree identity holding its BIP-39 mnemonic; `raw-nsec` for
 * an identity created from an nsec (`importFromNsec`: no mnemonic, the primary
 * slot holds the imported key, the other core slot holds no key); otherwise
 * `null`: a paired child, a key held by a signer or browser extension, or keys
 * stripped by a Heartwood connect or migration.
 *
 * The other-slot check stops a tree identity that somehow lost its mnemonic
 * but kept its derived keys from being shown one key's words as though they
 * restored the whole Signet.
 */
export function recoveryWordsSource(
  identity: Pick<SignetIdentity, 'mnemonic' | 'primaryKeypair' | 'naturalPerson' | 'persona' | 'isChild'>,
): RecoveryWordsSource {
  if (identity.mnemonic) return 'mnemonic';
  if (identity.isChild) return null;
  const primary = identity.primaryKeypair === 'natural-person' ? identity.naturalPerson : identity.persona;
  const other = identity.primaryKeypair === 'natural-person' ? identity.persona : identity.naturalPerson;
  if (!isValidHexKey(primary?.privateKey ?? '')) return null;
  if (other?.privateKey) return null;
  return 'raw-nsec';
}

/** What a single recovery word is, for a display that walks or lists them. */
export type RecoveryWordRole = 'format' | 'header' | 'secret';

/**
 * Classify word `index` (1-based) of a `total`-word sequence, or `null` when
 * `total` is not a ForgeSworn envelope length this app shows (7 header words
 * plus a 12- or 24-word BIP-39 payload: 19 for a Signet, 31 for an imported
 * key) or `index` is out of range.
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
 * nothing sniffs word counts. The default box takes either success kind.
 */
export function parseRestoreInput(text: string, mode: RestoreInputMode): RestoreParseResult {
  if (mode === 'legacy-bip39') {
    const mnemonic = normalise(text);
    if (!validateMnemonic(mnemonic)) return { ok: false, reason: 'legacy-invalid' };
    return { ok: true, kind: 'mnemonic', mnemonic };
  }
  return fromRecoveryWords(text);
}

export type NsecInputResult =
  | { readonly ok: true; readonly nsec: string }
  | { readonly ok: false; readonly reason: RecoveryFailureReason | 'not-nsec' | 'whole-signet' };

/**
 * The "import a Nostr account" box takes an `nsec1…` key or that key's 31
 * recovery words. An nsec passes through untouched for the existing path to
 * validate as before; recovery words must be `raw-nsec-v1`. A whole-Signet
 * sequence is refused here (it belongs in the restore box), and a bare BIP-39
 * phrase still fails closed on the envelope's magic: nothing is sniffed.
 */
export function parseNsecOrRecoveryWords(text: string): NsecInputResult {
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith('nsec1')) return { ok: true, nsec: trimmed };
  if (!/\s/.test(trimmed)) return { ok: false, reason: 'not-nsec' };
  const parsed = fromRecoveryWords(trimmed);
  if (!parsed.ok) return parsed;
  if (parsed.kind === 'mnemonic') return { ok: false, reason: 'whole-signet' };
  return { ok: true, nsec: consumeSecretKeyAsNsec(parsed.secretKey) };
}

/** User-facing error copy per recovery reason (spec §5). */
export const RESTORE_ERROR_COPY: Readonly<Record<RecoveryFailureReason, string>> = {
  'not-recovery-words':
    'Recovery words are 19 or 31 words. Got a 12-word backup from before? Use the older-backup option.',
  checksum: 'Some words don’t match. Check each word and the order.',
  fingerprint: 'Some words don’t match. Check each word and the order.',
  'unsupported-kind':
    'These are ForgeSworn recovery words for a different kind of key. MySignet restores from the words it showed you in Settings.',
  'tree-root-nsec':
    'These words back up a tree-root nsec. MySignet can’t restore that kind of backup. Sapwood can restore it onto a Heartwood.',
};

/** Copy for the two reasons only the "import a Nostr account" box can hit. */
export const NSEC_INPUT_ERROR_COPY: Readonly<Record<'not-nsec' | 'whole-signet', string>> = {
  'not-nsec': 'Paste your nsec key (it starts with nsec1) or its 31 recovery words.',
  'whole-signet': 'These recovery words restore a whole Signet, not one Nostr account.',
};
