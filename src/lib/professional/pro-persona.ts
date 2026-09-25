// Professional Persona keypair derivation helpers.
// Spec: 2026-04-25-pro-surface-architecture-design.md §4.5
//
// The Professional Persona is derived from the same mnemonic as the NP and
// anonymous Persona via the nsec-tree path token 'professional'. Derivation
// is one-directional: knowing a sibling's pubkey does not allow derivation
// of any other sibling's pubkey.

import { deriveExtraPersona } from '../signet';
import type { SigningBackend } from '../signing-backend';
import { publishEvent } from '../relay-service';

/** The canonical nsec-tree path token for the Professional Persona. */
const PRO_PERSONA_DERIVATION_TOKEN = 'professional';

export interface ProPersonaKeypair {
  publicKey: string;
  privateKey: string;
  displayName: string;
}

/**
 * Derive the Professional Persona keypair from the user's mnemonic.
 * Stable: calling this multiple times with the same mnemonic returns
 * identical keys. The displayName is left as an empty string here —
 * callers set it from NP displayName on first derivation (§4.5.4).
 */
export function deriveProfessionalPersona(mnemonic: string): ProPersonaKeypair {
  const { publicKey, privateKey } = deriveExtraPersona(mnemonic, PRO_PERSONA_DERIVATION_TOKEN);
  return { publicKey, privateKey, displayName: '' };
}

/**
 * Check whether Pro mode is blocked because the encrypted mnemonic has been
 * deleted (Heartwood-connect path, §4.5.10).
 *
 * Returns null when Pro mode is available, or a human-readable reason string
 * when it is blocked. The reason string is displayed in the Pro entry UI;
 * do NOT emit it to the console.
 *
 * Spec: 2026-04-25-pro-surface-architecture-design.md §4.5.10 — Pro-context
 * signing prefers the local mnemonic-derived key (`LocalSigningBackend`) when
 * present. When the mnemonic has been deleted (Heartwood-connect path), Pro
 * mode is unavailable UNLESS the connected bunker is Heartwood-capable (i.e.
 * it serves per-persona keys via `bunker-router.ts`'s per-slot routing) AND
 * the Professional Persona's pubkey is already known — in that case the
 * router serves the Professional key directly and Pro mode stays available.
 * A generic (non-Heartwood) bunker, or a Heartwood bunker whose Pro pubkey
 * hasn't been derived/discovered yet, still blocks.
 */
export function proModeBlockedReason(
  state: {
    hasMnemonic: boolean;
    bunkerActive: boolean;
    /** True when the connected bunker can serve per-persona keys (e.g. Heartwood router). */
    bunkerServesPersonas?: boolean;
    /** True when the Professional Persona's pubkey is already known/derived. */
    proPubkeyKnown?: boolean;
  }
): string | null {
  if (!state.hasMnemonic && state.bunkerActive && state.bunkerServesPersonas && state.proPubkeyKnown) {
    return null; // Heartwood serves the Professional key directly
  }
  if (!state.hasMnemonic && state.bunkerActive) {
    return (
      'Pro mode requires your recovery phrase to be stored on this device. ' +
      'You connected a Heartwood remote signer, which removes the local phrase. ' +
      'Heartwood support for Pro persona signing will arrive in a later phase.'
    );
  }
  return null;
}

/**
 * Publish a kind-0 metadata event for the Professional Persona.
 * Signed by the proBackend. Spec §4.5.4 — "re-publishes kind-0 on name save".
 */
export async function publishProKind0(
  proPublicKey: string,
  displayName: string,
  proBackend: SigningBackend,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const event = await proBackend.signEvent({
    kind: 0,
    pubkey: proPublicKey,
    created_at: now,
    tags: [],
    content: JSON.stringify({ name: displayName }),
  });
  await publishEvent(event);
}
