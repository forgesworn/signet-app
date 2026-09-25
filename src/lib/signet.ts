// Simplified protocol library wrapper for MySignet (v2)

import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic as _validateMnemonic,
  BIP39_WORDLIST,
  createSignetIdentity as _createSignetIdentity,
  decodeNsec,
  decodeNpub,
  getPublicKey,
  computeSharedSecret,
  createQRPayload,
  serializeQRPayload,
  parseQRPayload,
  getSignetDisplay,
  verifySignetWords,
  encodeNpub,
  createVouch,
  buildVouchEvent,
  computeBadge,
  buildBadgeFilters,
  splitSecret,
  shareToWords,
  mnemonicToEntropy,
  createTwoCredentialCeremony,
  destroyIdentity as _destroyIdentity,
  deriveAdditionalPersona as _deriveAdditionalPersona,
  deriveDependantIdentity as _deriveDependantIdentity,
  buildCredentialEvent,
  signEvent,
} from 'signet-protocol';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { fromMnemonic as liteRootFromMnemonic, derive as deriveLiteIdentity } from 'nsec-tree';
// Shamir v3 typed envelope. New backups must use it (nsec-tree/RECOVERY.md
// §Shamir shares); the unversioned splitSecret/shareToWords above stay put so
// existing paper shares keep decoding.
import { splitSecretToWordsV3 } from '@forgesworn/shamir-words';
import type { WordSharePayloadKind } from '@forgesworn/shamir-words';
import type { SignetIdentity } from '../types';
import type { SigningBackend } from './signing-backend';

// Wrap @scure/bip39 functions that require a wordlist parameter
export function generateMnemonic(): string {
  return _generateMnemonic(BIP39_WORDLIST);
}

export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, BIP39_WORDLIST);
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Validate that a string is a 64-char lowercase hex key */
export function isValidHexKey(value: string): boolean {
  return HEX64_RE.test(value);
}

/** Convert a hex pubkey to a truncated npub for display, e.g. "npub1a2b3c…x7y8z9" */
export function shortNpub(hexPubkey: string): string {
  if (!isValidHexKey(hexPubkey)) {
    return hexPubkey ? hexPubkey.slice(0, 8) + '\u2026' : '(no key)';
  }
  const npub = encodeNpub(hexToBytes(hexPubkey));
  return npub.slice(0, 12) + '\u2026' + npub.slice(-8);
}

export {
  computeSharedSecret,
  createQRPayload,
  serializeQRPayload,
  parseQRPayload,
  getSignetDisplay,
  verifySignetWords,
  encodeNpub,
  decodeNpub,
  createVouch,
  buildVouchEvent,
  computeBadge,
  buildBadgeFilters,
  splitSecret,
  shareToWords,
  splitSecretToWordsV3,
  mnemonicToEntropy,
  createTwoCredentialCeremony,
  decodeNsec,
  getPublicKey,
  BIP39_WORDLIST,
  hexToBytes,
  bytesToHex,
};
export type { WordSharePayloadKind };

/**
 * Derive a keypair (NP or persona) from a mnemonic.
 * Token 'natural-person' returns the NP keypair; 'persona' returns the anonymous
 * persona keypair. For other tokens use `deriveExtraPersona` directly.
 */
export function deriveKeypair(
  mnemonic: string,
  kind: 'natural-person' | 'persona',
): { publicKey: string; privateKey: string } {
  const tree = _createSignetIdentity(mnemonic);
  const branch = kind === 'natural-person' ? tree.naturalPerson : tree.persona;
  const pub = bytesToHex(branch.identity.publicKey);
  const priv = bytesToHex(branch.identity.privateKey);
  _destroyIdentity(tree);
  return { publicKey: pub, privateKey: priv };
}

/**
 * Derive an additional persona from the mnemonic via nsec-tree.
 * Returns { publicKey, privateKey } as hex strings.
 */
export function deriveExtraPersona(
  mnemonic: string,
  derivationName: string,
): { publicKey: string; privateKey: string } {
  const tree = _createSignetIdentity(mnemonic);
  const persona = _deriveAdditionalPersona(tree.root, derivationName);
  const pub = bytesToHex(persona.identity.publicKey);
  const priv = bytesToHex(persona.identity.privateKey);
  _destroyIdentity(tree);
  // Zeroize persona private key bytes after extracting to hex
  persona.identity.privateKey.fill(0);
  return { publicKey: pub, privateKey: priv };
}

/**
 * Derive the natural-person and persona pubkeys from a mnemonic without
 * exposing private keys. Used by the restore flow to probe kind-0 profiles
 * before committing to a full identity record.
 */
export function derivePubkeysFromMnemonic(mnemonic: string): {
  naturalPerson: string;
  persona: string;
} {
  const tree = _createSignetIdentity(mnemonic);
  const np = bytesToHex(tree.naturalPerson.identity.publicKey);
  const persona = bytesToHex(tree.persona.identity.publicKey);
  _destroyIdentity(tree);
  return { naturalPerson: np, persona };
}

/**
 * Derive the public key of an extra persona without returning the private key.
 * Used by the restore-flow probe; the private key is zeroized immediately.
 */
export function deriveExtraPersonaPubkey(
  mnemonic: string,
  derivationName: string,
): string {
  const tree = _createSignetIdentity(mnemonic);
  const persona = _deriveAdditionalPersona(tree.root, derivationName);
  const pub = bytesToHex(persona.identity.publicKey);
  _destroyIdentity(tree);
  persona.identity.privateKey.fill(0);
  return pub;
}

/**
 * Derive a full dependant identity (natural-person + persona keypairs) from the
 * guardian's mnemonic. Uses deterministic derivation paths so the same dependant
 * can be re-derived if the guardian recovers from their Shamir backup.
 */
export function deriveDependantIdentity(
  mnemonic: string,
  derivationPath: string,
): { naturalPerson: { publicKey: string; privateKey: string }; persona: { publicKey: string; privateKey: string } } {
  const match = /^dependant-(0|[1-9]\d*)$/.exec(derivationPath);
  if (!match) throw new Error('Invalid dependant derivation path');

  const tree = _createSignetIdentity(mnemonic);
  let derived: ReturnType<typeof _deriveDependantIdentity> | undefined;
  try {
    derived = _deriveDependantIdentity(tree.root, Number(match[1]));
    return {
      naturalPerson: {
        publicKey: bytesToHex(derived.naturalPerson.identity.publicKey),
        privateKey: bytesToHex(derived.naturalPerson.identity.privateKey),
      },
      persona: {
        publicKey: bytesToHex(derived.persona.identity.publicKey),
        privateKey: bytesToHex(derived.persona.identity.privateKey),
      },
    };
  } finally {
    derived?.naturalPerson.identity.privateKey.fill(0);
    derived?.persona.identity.privateKey.fill(0);
    _destroyIdentity(tree);
  }
}

/**
 * Publish a Tier 1 self-declared credential carrying a persona's display name.
 * The credential content embeds the display name as a tag.
 * Returns the signed event so the caller can store its ID for supersession.
 *
 * @param privateKey  - Persona's private key (hex)
 * @param displayName - The name to record
 * @param supersedesId - ID of the previous name credential (for traceability)
 */
export async function publishPersonaNameCredential(
  privateKey: string,
  displayName: string,
  supersedesId?: string,
): Promise<import('signet-protocol').NostrEvent> {
  const pubkey = getPublicKey(privateKey);
  const DEFAULT_EXPIRY_SECONDS = 365 * 24 * 60 * 60; // 1 year
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS;

  const template = buildCredentialEvent(pubkey, {
    subjectPubkey: pubkey,
    tier: 1,
    type: 'self',
    scope: 'adult',
    method: 'self-declaration',
    expiresAt,
    supersedes: supersedesId,
  });

  // Add display-name tag to the event before signing
  const withName = {
    ...template,
    tags: [...template.tags, ['display-name', displayName]],
  };

  return signEvent(withName, privateKey);
}

/** Create a new identity with two keypairs from a fresh mnemonic */
export function createNewIdentity(
  displayName: string,
  primaryKeypair: 'natural-person' | 'persona',
  isChild: boolean,
  guardianPubkey?: string
): SignetIdentity {
  const mnemonic = generateMnemonic();
  return buildIdentity(mnemonic, displayName, primaryKeypair, isChild, guardianPubkey);
}

/** Restore an identity from an existing mnemonic */
export function importFromMnemonic(
  mnemonic: string,
  displayName: string,
  primaryKeypair: 'natural-person' | 'persona',
  isChild: boolean,
  guardianPubkey?: string
): SignetIdentity {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid backup words');
  }
  return buildIdentity(mnemonic, displayName, primaryKeypair, isChild, guardianPubkey);
}

function buildIdentity(
  mnemonic: string,
  displayName: string,
  primaryKeypair: 'natural-person' | 'persona',
  isChild: boolean,
  guardianPubkey?: string
): SignetIdentity {
  const tree = _createSignetIdentity(mnemonic);

  const npPub = bytesToHex(tree.naturalPerson.identity.publicKey);
  const npPriv = bytesToHex(tree.naturalPerson.identity.privateKey);
  const personaPub = bytesToHex(tree.persona.identity.publicKey);
  const personaPriv = bytesToHex(tree.persona.identity.privateKey);

  // Zeroize all raw key material from protocol tree (private keys + root secret)
  _destroyIdentity(tree);

  const primaryPub = primaryKeypair === 'natural-person' ? npPub : personaPub;

  return {
    id: primaryPub,
    mnemonic,
    naturalPerson: {
      publicKey: npPub,
      privateKey: npPriv,
      displayName: primaryKeypair === 'natural-person' ? displayName : '',
    },
    persona: {
      publicKey: personaPub,
      privateKey: personaPriv,
      displayName: primaryKeypair === 'persona' ? displayName : '',
    },
    primaryKeypair,
    isChild,
    guardianPubkey,
    createdAt: Math.floor(Date.now() / 1000),
    backedUp: false,
    // The real-name slot is dormant unless this identity was created with the
    // real name as its primary face (recovery-words restore with "Use my real
    // name"). New identities are always persona-primary, so they start dormant.
    naturalPersonActive: primaryKeypair === 'natural-person',
  };
}

/** Import an identity from an nsec (single-keypair, no mnemonic) */
export function importFromNsec(
  nsec: string,
  displayName: string,
  primaryKeypair: 'natural-person' | 'persona',
): SignetIdentity {
  const privateKey = bytesToHex(decodeNsec(nsec));
  const publicKey = getPublicKey(privateKey);
  const emptyKeypair = { publicKey: '', privateKey: '', displayName: '' };

  return {
    id: publicKey,
    mnemonic: '', // nsec import has no mnemonic — Shamir/backup unavailable
    naturalPerson: primaryKeypair === 'natural-person'
      ? { publicKey, privateKey, displayName }
      : emptyKeypair,
    persona: primaryKeypair === 'persona'
      ? { publicKey, privateKey, displayName }
      : emptyKeypair,
    primaryKeypair,
    isChild: false,
    createdAt: Math.floor(Date.now() / 1000),
    backedUp: true, // no mnemonic to back up — suppress backup nag
    // An nsec import has no tree-derived NP key at all when it lands in the
    // persona slot — there is nothing to activate. Keeping the invariant
    // "active ⟺ the NP slot carries a name" makes the NP-slot variant correct
    // too, without a second rule.
    naturalPersonActive: primaryKeypair === 'natural-person',
  };
}

/** Import a Signet Lite identity from the same 12 words + Lite identity name. */
export function importFromLiteMnemonic(
  mnemonic: string,
  liteIdentityName: string,
  displayName: string,
): SignetIdentity {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid backup words');
  }
  const name = liteIdentityName.trim();
  if (!name) throw new Error('Lite identity name is required');

  const naturalPerson = deriveKeypair(mnemonic, 'natural-person');
  const root = liteRootFromMnemonic(mnemonic);
  let personaPublic = '';
  let personaPrivate = '';
  try {
    const liteIdentity = deriveLiteIdentity(root, name, 0);
    personaPublic = bytesToHex(liteIdentity.publicKey);
    personaPrivate = bytesToHex(liteIdentity.privateKey);
    liteIdentity.privateKey.fill(0);
  } finally {
    root.destroy();
  }

  return {
    id: personaPublic,
    mnemonic,
    naturalPerson: {
      publicKey: naturalPerson.publicKey,
      privateKey: naturalPerson.privateKey,
      displayName: '',
    },
    persona: {
      publicKey: personaPublic,
      privateKey: personaPrivate,
      displayName,
    },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: Math.floor(Date.now() / 1000),
    backedUp: true,
    naturalPersonActive: false,
    liteImported: true,
  };
}

/** Get the active keypair's public key */
export function getActivePubkey(identity: SignetIdentity): string {
  return identity.primaryKeypair === 'natural-person'
    ? identity.naturalPerson.publicKey
    : identity.persona.publicKey;
}

/** Get the active keypair's private key */
export function getActivePrivateKey(identity: SignetIdentity): string {
  return identity.primaryKeypair === 'natural-person'
    ? identity.naturalPerson.privateKey
    : identity.persona.privateKey;
}

/** Get the active display name */
export function getActiveDisplayName(identity: SignetIdentity): string {
  return identity.primaryKeypair === 'natural-person'
    ? identity.naturalPerson.displayName
    : identity.persona.displayName;
}

/**
 * Sign an auth challenge using the Nostr signEvent convention.
 *
 * The challenge is embedded in a Kind 21236 Signet-ephemeral event so that
 * the signature is a standard Nostr event signature any verifier can check
 * with `verifyEvent`. This ceremony is used for both redirect mode (consumer
 * reconstructs the event from params + signature) and relay mode (the full
 * signed event is published inside the gift-wrapped AuthResponse).
 *
 * Kind 21236 sits in Signet's reserved ephemeral range alongside kind 21235
 * (venue entry). It deliberately avoids kind 27235 which is reserved by
 * NIP-98 for HTTP Auth — the tag semantics (`challenge`/`origin`) differ.
 *
 * Works with every SigningBackend — local, NIP-46 bunker, NIP-07 — because
 * they all expose `signEvent`.
 *
 * Returns the full signed event plus convenience copies of its `sig` and `id`.
 */
export async function signAuthChallenge(
  backend: SigningBackend,
  challenge: string,
  origin: string,
  /**
   * Optional per-persona avatar metadata. When the signing keypair has an
   * avatar set, the consumer site receives the
   * encrypted-blob coordinates and the AES decryption key as kind-21236
   * tags. The consumer fetches the encrypted blob from Blossom, decrypts
   * with the key, and renders the persona's picture alongside the handle.
   *
   * Sensitivity note: `keyHex` decrypts the avatar blob — anyone who
   * acquires it can render the picture. Profile-picture-level
   * sensitivity; the user is consenting to share it by signing in.
   * Same precedence as the displayName: deliberate disclosure to the
   * consumer they just approved. See per-persona-avatars phase 4 in
   * the 2026-05-16 avatars sequence.
   */
  avatar?: { hash: string; blossomUrl: string; keyHex: string } | undefined,
): Promise<{ pubkey: string; signature: string; eventId: string; authEvent: import('signet-protocol').NostrEvent }> {
  const pubkey = backend.activePublicKeyHex;
  const tags: string[][] = [
    ['challenge', challenge],
    ['origin', origin],
  ];
  if (avatar && avatar.hash && avatar.blossomUrl && avatar.keyHex) {
    tags.push(['avatar_hash', avatar.hash]);
    tags.push(['avatar_url', avatar.blossomUrl]);
    tags.push(['avatar_key', avatar.keyHex]);
  }
  const authEvent = await backend.signEvent({
    pubkey,
    kind: 21236,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });
  return { pubkey, signature: authEvent.sig, eventId: authEvent.id, authEvent };
}
