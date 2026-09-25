/**
 * Copy for the two screens that need a raw private key on this device
 * (family-bunker §11.1.7): AddMember (ECDH shared secret) and VerifySomeone
 * (compound multi-sign ceremony). They stay local-key-only this cycle;
 * say so honestly per signing mode instead of "disconnect your signer",
 * which is wrong advice once the keys live on Heartwood.
 */
export type SigningMode = 'local' | 'bunker' | 'nip07' | 'paired-child' | undefined;

const FEATURE = {
  contacts: { title: 'Add Contact', verb: 'Adding a contact this way' },
  credentials: { title: 'Verify Someone', verb: 'Issuing a credential' },
} as const;

const WHERE: Record<Exclude<SigningMode, 'local' | undefined>, string> = {
  bunker: 'your keys live on your Heartwood signer',
  nip07: 'your keys live in your Nostr browser extension',
  'paired-child': "your keys live on your guardian's phone",
};

export interface LocalKeyOnlyCopy {
  title: string;
  body: string;
}

/**
 * Returns the "not available here" copy for `feature` under `signingMode`,
 * or `null` when the feature IS available (local key material on this device).
 */
export function localKeyOnlyCopy(
  feature: keyof typeof FEATURE,
  signingMode: SigningMode,
): LocalKeyOnlyCopy | null {
  if (signingMode === 'local' || signingMode === undefined) return null;
  const f = FEATURE[feature];
  return {
    title: f.title,
    body: `${f.verb} needs a private key on this device, and ${WHERE[signingMode]}. It isn't available here for now — a later update brings it to signer-held keys.`,
  };
}

/**
 * One-line replacement for any "show the backup words" affordance that would
 * have nothing to show, because the mnemonic moved to a Heartwood signer
 * (family-bunker §11.1.7). Single source of truth: used by the guardian's
 * dependant Backup section, the owner's Advanced → Backup block, AND as the
 * defensive fallback when a reveal attempt fails for any other keyless
 * reason — so the affordance fails loud with accurate copy instead of
 * silently doing nothing.
 */
export const BACKUP_WORDS_ON_SIGNER = 'Backup words live with your Heartwood signer.';
