/**
 * Where an owner key lives, i.e. what actually signs for it. Pure.
 *
 * Read live from the identity and signing mode rather than from what a place
 * recorded when it was approved: NIP-55 rows were stamped `local` even when a
 * Heartwood signs, and a Nostr Connect app paired through My Signet is signed by
 * whatever My Signet signs with.
 */
import type { SignetIdentity } from '../types';

export type KeyHome = 'heartwood' | 'phone' | 'remote-signer' | 'extension';

export function keyHomeFor(
  pubkey: string,
  o: { identity: SignetIdentity | null; signingMode?: string; routerPresent: boolean },
): KeyHome | undefined {
  const id = o.identity;
  if (!id || !pubkey) return undefined;
  const want = pubkey.toLowerCase();
  const slots = [id.naturalPerson, id.persona, ...(id.extraPersonas ?? []), id.professionalPersona];
  const slot = slots.find(s => !!s && s.publicKey.toLowerCase() === want);
  if (!slot) return undefined;
  if (o.signingMode === 'nip07') return 'extension';
  if (slot.privateKey) return 'phone';
  if (o.signingMode === 'bunker') return o.routerPresent ? 'heartwood' : 'remote-signer';
  return undefined;
}
