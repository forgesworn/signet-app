import { getDb } from '../db';
import { buildDirectoryAddEventSigned } from './role-anchor';
import { publishEvent } from '../relay-service';
import type { ProfessionKind } from './types';

export interface PassiveDiscoveryInput {
  leadPubkey: string;
  firmName: string;
  identifier: { kind: string; value: string };
  canonicalUrl: string;
  professionKind: ProfessionKind;
  /** Whether the lead pubkey's role-anchor includes `listed: true`. False = opt-out; skip. */
  listedFlag: boolean;
  /** The verifier's own private key (hex). Used to sign the witness directory event. */
  verifierPrivkeyHex: string;
}

/**
 * Fire-and-forget passive directory publish hook.
 *
 * Called from verifyProChain on success. If the firm is not yet in the local
 * `proDirectorySeen` cache and the lead opted in (listedFlag === true),
 * publishes a kind-30203 event signed by the *verifier* (acting as witness)
 * and caches the firm to avoid repeat publishes.
 *
 * The published event uses the verifier's key, not the lead's — it is a
 * witness attestation that this firm was successfully verified, not a
 * lead self-registration. Downstream directory generators accept both.
 */
export async function maybePassiveDirectoryPublish(
  input: PassiveDiscoveryInput,
): Promise<void> {
  if (!input.listedFlag) return;

  const db = await getDb();
  const existing = await db.get('proDirectorySeen', input.leadPubkey);
  if (existing) return;

  const ev = await buildDirectoryAddEventSigned(
    {
      firmName: input.firmName,
      identifier: input.identifier,
      canonicalUrl: input.canonicalUrl,
      professionKind: input.professionKind,
      optOut: false,
    },
    input.verifierPrivkeyHex,
  );
  await publishEvent(ev);

  await db.put('proDirectorySeen', {
    leadPubkey: input.leadPubkey,
    seenAt: new Date().toISOString(),
    firmName: input.firmName,
    identifier: input.identifier,
  });
}
