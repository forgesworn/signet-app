/**
 * The identity the App's backend-setup effect last built signing backends
 * for. The effect skips all work while this id is unchanged, so every event
 * that must rebuild the signer has to change it.
 *
 * `pairingGeneration` is App's `pairedChildBumpCounter`: an in-session
 * re-pair of a paired-child install keeps the same identity (same dependant,
 * same stub) but retires the old pairing's backend and router. Without the
 * generation in the id the effect re-ran, matched the old id and returned,
 * so no signer was ever connected for the new pairing until a cold start
 * (device bug 5, 2026-09-30).
 */
export function backendsTargetId(input: {
  identityId: string;
  identityEncrypted: boolean;
  activeDependant: { id: string; primaryKeypair: string } | null;
  pairingGeneration: number;
}): string {
  if (input.activeDependant) {
    return `dep:${input.activeDependant.id}:${input.activeDependant.primaryKeypair}`;
  }
  return `${input.identityId}:${input.identityEncrypted ? 'enc' : 'dec'}:${input.pairingGeneration}`;
}
