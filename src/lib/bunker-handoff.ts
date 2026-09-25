import { BunkerSigningBackend } from './signing-backend';
import type { SigningBackend } from './signing-backend';

export interface BunkerHandoffPreferences {
  activeAccountId?: string;
  signingMode?: 'local' | 'bunker' | 'nip07' | 'paired-child';
  /**
   * Must already be the DECRYPTED plaintext URI (M1 — bunkerUri is
   * encrypted at rest; callers get a usable value here from a keyed
   * `db.getPreferences(encryptionKey)` call, e.g. via App.tsx's
   * post-unlock `reloadPreferences(encryptionKey)`).
   */
  bunkerUri?: string;
}

export interface BunkerHandoffIdentity {
  id: string;
  naturalPerson: {
    publicKey: string;
  };
}

export interface BunkerHandoffSelection {
  source: string;
  keypairType: string;
}

function validBunkerUri(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('bunker://')
    ? value
    : undefined;
}

/** The identity a `bunker://<pubkey>?...` URI is bound to (lowercase hex), or undefined. */
function bunkerUriPubkey(uri: string): string | undefined {
  const match = /^bunker:\/\/([0-9a-fA-F]{64})(\?|$)/.exec(uri.trim());
  return match ? match[1].toLowerCase() : undefined;
}

export function runtimeBunkerUriForBackend(
  backend: SigningBackend,
  activeBunkerBackend: BunkerSigningBackend | null,
  preferences: BunkerHandoffPreferences,
): string | undefined {
  return boundToBackend(backend, resolveRuntimeBunkerUri(backend, activeBunkerBackend, preferences));
}

function resolveRuntimeBunkerUri(
  backend: SigningBackend,
  activeBunkerBackend: BunkerSigningBackend | null,
  preferences: BunkerHandoffPreferences,
): string | undefined {
  const runtimeUri = validBunkerUri((backend as SigningBackend & { bunkerUri?: unknown }).bunkerUri);
  if (runtimeUri) return runtimeUri;

  if (backend instanceof BunkerSigningBackend && backend.bunkerUri) {
    return backend.bunkerUri;
  }

  if (backend === activeBunkerBackend) {
    if (activeBunkerBackend?.bunkerUri) return activeBunkerBackend.bunkerUri;
    if (preferences.signingMode === 'bunker' && preferences.bunkerUri) {
      return preferences.bunkerUri;
    }
  }

  return undefined;
}

/**
 * Defence in depth: a handed-off URI must be bound to the identity the
 * backend signs as. A `RoutedBunkerSigningBackend` (family bunker, per-slot)
 * exposes no `bunkerUri`, so it never reaches here with the master's URI —
 * but if any backend ever did, refuse rather than hand a consumer the wrong
 * (or the root) identity. Backends without a known pubkey (pre-connect) are
 * let through unchanged.
 */
function boundToBackend(backend: SigningBackend, uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const pk = (backend.activePublicKeyHex || '').trim().toLowerCase();
  if (pk && bunkerUriPubkey(uri) !== pk) return undefined;
  return uri;
}

export function storedBunkerUriForGuardianNaturalPerson(
  selection: BunkerHandoffSelection,
  signingPubkey: string,
  identity: BunkerHandoffIdentity | null | undefined,
  preferences: BunkerHandoffPreferences,
): string | undefined {
  if (
    selection.source !== 'guardian'
    || selection.keypairType !== 'natural-person'
    || !identity?.naturalPerson.publicKey
    || signingPubkey.toLowerCase() !== identity.naturalPerson.publicKey.toLowerCase()
  ) {
    return undefined;
  }

  if (
    preferences.signingMode !== 'bunker'
    || !preferences.bunkerUri
    || (preferences.activeAccountId && preferences.activeAccountId !== identity.id)
  ) {
    return undefined;
  }

  // Never hand out a bunker URI bound to a different identity than the one
  // that signed. On the family bunker the stored URI is the MASTER pairing
  // (secret included) while the NP is a derived persona — handing it over
  // would let the consumer act as the master (an earlier hardware finding). A
  // slot-addressed NP handoff is a Phase-3 item (pairing-event policy push).
  if (bunkerUriPubkey(preferences.bunkerUri) !== signingPubkey.toLowerCase()) {
    return undefined;
  }

  return preferences.bunkerUri;
}
