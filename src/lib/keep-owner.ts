import { extractEndpointPubkey } from './dependant-status-sync';

/**
 * The keys a Keep claim may be authored by, for the `authors` filter.
 *
 * Bothy's claim is signed by the keeper's master (claim rule 4: the master
 * `p` tag equals the event signer).
 *
 * - Local (mnemonic) install: the app is its own NIP-46 signer, and each
 *   route signs as one slot key (Natural Person, Persona, Professional,
 *   extras), so a claim is authored by one of the slot keys. The app holds
 *   no separate master, so the slot keys are the whole answer.
 * - Bunker (Heartwood) install: the master lives on the device and is
 *   deliberately NOT one of the slot keys (onboarding refuses a slot equal
 *   to it), so the slot keys alone never match. Add the signer's key as the
 *   app knows it: the live `get_public_key` answer when connected, and the
 *   pubkey in the stored bunker:// address (available before reconnect).
 *   Both are kept; an extra author can only match a claim that key signed.
 *
 * Never reads a private key.
 */
export function keepAuthorPubkeys(args: {
  slotPubkeys: readonly string[];
  signingMode?: string;
  bunkerUri?: string;
  liveSignerPubkey?: string;
}): string[] {
  const out = new Set<string>();
  const add = (k: string | null | undefined) => {
    const key = (k ?? '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(key)) out.add(key);
  };
  args.slotPubkeys.forEach(add);
  if (args.signingMode === 'bunker') {
    add(args.bunkerUri ? extractEndpointPubkey(args.bunkerUri) : null);
    add(args.liveSignerPubkey);
  }
  return [...out];
}
