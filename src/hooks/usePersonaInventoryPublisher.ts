/**
 * Guardian-side persona-inventory publisher
 * (2026-05-15-persona-inventory-sync-to-paired-child-design.md §2.5).
 *
 * Watches each paired dependant for persona-inventory changes (built-in
 * persona, extra personas added/renamed/hidden/soft-deleted, and the
 * `hiddenOnPairedDeviceKeys` per-dep visibility list) and publishes a
 * NIP-44-encrypted kind-30078 event to the child's transport pubkey.
 * Signed with the guardian's per-dependant endpoint keypair — same
 * identity the child already trusts.
 *
 * Debounced at 1 s to coalesce rapid toggles in the GuardianSettings
 * UI. A per-dependant hash prevents re-publishing identical state.
 */

import { useEffect, useRef } from 'react';
import type { DependantIdentity, PublicProfileConfig } from '../types';
import { LocalSigningBackend } from '../lib/signing-backend';
import { publishPersonaInventory, publicProfileToInventoryBlock } from '../lib/persona-inventory-sync';
import { isDependantNaturalPersonActive } from '../lib/identity-display';

const PUBLISH_DEBOUNCE_MS = 1000;

interface Options {
  dependants: DependantIdentity[];
  relayUrl: string;
  encryptionKey: string | null;
}

/** Stable hash for publish idempotency — avoids re-publishing identical state.
 *  Avatar hash AND key are both part of the hash: in the rare case where a
 *  re-upload produces the same SHA-256 (same source bytes) but a fresh AES
 *  key (always regenerated in encryptPhoto), the kid would otherwise retain
 *  the now-invalid old key and the carousel image would 404 on decrypt.
 *  Including avatarKey forces a republish so the kid receives the new key. */
/**
 * Pull the public-profile config fields off a keypair slot. The 9 fields
 * (`displayName`, `about`, `pictureUrl`, …) live as top-level slot keys per
 * Phase 1's persona-card-as-source-of-truth split — `publicProfile` itself
 * is state only (`enabled`, `lastEventId`, …). Returns `undefined` when none
 * of the optional fields is set AND `displayName` is empty.
 */
function extractConfigFromSlot(slot: {
  displayName?: string;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
}): PublicProfileConfig | undefined {
  const displayName = slot.displayName ?? '';
  const hasAny =
    displayName !== '' ||
    !!slot.about ||
    !!slot.pictureUrl ||
    !!slot.pictureBlossomHash ||
    !!slot.bannerUrl ||
    !!slot.bannerBlossomHash ||
    !!slot.nip05 ||
    !!slot.lud16 ||
    !!slot.website;
  if (!hasAny) return undefined;
  const out: PublicProfileConfig = { displayName };
  if (slot.about) out.about = slot.about;
  if (slot.pictureUrl) out.pictureUrl = slot.pictureUrl;
  if (slot.pictureBlossomHash) out.pictureBlossomHash = slot.pictureBlossomHash;
  if (slot.bannerUrl) out.bannerUrl = slot.bannerUrl;
  if (slot.bannerBlossomHash) out.bannerBlossomHash = slot.bannerBlossomHash;
  if (slot.nip05) out.nip05 = slot.nip05;
  if (slot.lud16) out.lud16 = slot.lud16;
  if (slot.website) out.website = slot.website;
  return out;
}

/**
 * Stable config-only hash of a publicProfile. Includes ONLY the fields that
 * appear on the wire — state fields (lastEventId, lastPublishedAt,
 * lastPublishedRelay) are explicitly excluded because they're kid-owned per
 * §5.4 and including them would force needless republishes whenever the kid
 * locally updated its own state. Takes the config + enabled bit separately,
 * matching the persona-card-as-source-of-truth split (config = slot
 * top-level fields, enabled = state field on `publicProfile`).
 */
function publicProfileHashFragment(
  config: PublicProfileConfig | undefined,
  enabled: boolean,
): string {
  if (!config && !enabled) return '';
  return JSON.stringify({
    enabled,
    displayName: config?.displayName,
    about: config?.about,
    pictureUrl: config?.pictureUrl,
    pictureBlossomHash: config?.pictureBlossomHash,
    bannerUrl: config?.bannerUrl,
    bannerBlossomHash: config?.bannerBlossomHash,
    nip05: config?.nip05,
    lud16: config?.lud16,
    website: config?.website,
  });
}

function inventoryHashFor(dep: DependantIdentity): string {
  return JSON.stringify({
    id: dep.id,
    client: dep.bunkerEndpoint?.authorizedClientPubkey ?? '',
    npActive: isDependantNaturalPersonActive(dep),
    npAvatar: dep.naturalPerson.avatarHash ?? '',
    npAvatarKey: dep.naturalPerson.avatarKey ?? '',
    npProfile: publicProfileHashFragment(
      extractConfigFromSlot(dep.naturalPerson),
      dep.naturalPerson.publicProfile?.enabled ?? false,
    ),
    personaPub: dep.persona.publicKey,
    personaName: dep.persona.displayName,
    personaAvatar: dep.persona.avatarHash ?? '',
    personaAvatarKey: dep.persona.avatarKey ?? '',
    personaProfile: publicProfileHashFragment(
      extractConfigFromSlot(dep.persona),
      dep.persona.publicProfile?.enabled ?? false,
    ),
    extras: (dep.extraPersonas ?? []).map(ep => ({
      k: ep.publicKey,
      n: ep.displayName,
      h: ep.hidden,
      a: ep.avatarHash ?? '',
      ak: ep.avatarKey ?? '',
      pp: publicProfileHashFragment(
        extractConfigFromSlot(ep),
        ep.publicProfile?.enabled ?? false,
      ),
    })),
    hidden: (dep.hiddenOnPairedDeviceKeys ?? []).slice().sort(),
  });
}

/**
 * Build the avatar fields for a `PersonaInventoryEntry` from a keypair slot
 * that has the same shape on guardian and dep records. Returns an empty
 * spread when no avatar is set (hash + URL + key must all be present).
 */
function avatarPayloadFor(
  slot: { avatarHash?: string; avatarBlossomUrl?: string; avatarKey?: string; avatarUpdatedAt?: number },
): Partial<{ avatarHash: string; avatarBlossomUrl: string; avatarKey: string; avatarUpdatedAt: number }> {
  if (!slot.avatarHash || !slot.avatarBlossomUrl || !slot.avatarKey) return {};
  return {
    avatarHash: slot.avatarHash,
    avatarBlossomUrl: slot.avatarBlossomUrl,
    avatarKey: slot.avatarKey,
    avatarUpdatedAt: slot.avatarUpdatedAt,
  };
}

export function usePersonaInventoryPublisher({ dependants, relayUrl, encryptionKey }: Options) {
  const lastPublishedRef = useRef<Map<string, string>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!relayUrl || !encryptionKey) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      for (const dep of dependants) {
        const endpoint = dep.bunkerEndpoint;
        if (!endpoint?.privateKey || !endpoint?.authorizedClientPubkey) continue;
        const npVisible = isDependantNaturalPersonActive(dep) && !!dep.naturalPerson.publicKey;
        const hiddenKeys = dep.hiddenOnPairedDeviceKeys ?? [];
        const personaVisible = !!dep.persona.publicKey && !hiddenKeys.includes(dep.persona.publicKey);
        const anyExtraVisible = (dep.extraPersonas ?? [])
          .some(ep => !ep.hidden && !hiddenKeys.includes(ep.publicKey));
        // Nothing this child is allowed to see: real identity dormant, persona
        // absent or hidden from the paired device, no visible extras. The
        // payload would be empty, so publishing it costs a signature and a
        // relay round-trip EVERY effect run (the hash dedupe only holds after a
        // publish that succeeded) and tells the child nothing. Same trade-off
        // as the pre-existing no-persona-key guard this replaces: an inventory
        // already on the relay is not retracted by hiding the last slot.
        if (!npVisible && !personaVisible && !anyExtraVisible) continue;

        const hash = inventoryHashFor(dep);
        if (lastPublishedRef.current.get(dep.id) === hash) continue;

        // Build publicProfile blocks via the wire-converter — strips state
        // fields (lastEventId / lastPublishedAt / lastPublishedRelay) per
        // §5.4's one-way data-flow contract. Config + enabled are sourced
        // separately per the Phase 1 source-of-truth split: config = slot
        // top-level fields, enabled = `publicProfile?.enabled`.
        const npProfile = publicProfileToInventoryBlock(
          extractConfigFromSlot(dep.naturalPerson),
          dep.naturalPerson.publicProfile?.enabled ?? false,
        );
        const personaProfile = publicProfileToInventoryBlock(
          extractConfigFromSlot(dep.persona),
          dep.persona.publicProfile?.enabled ?? false,
        );
        const visiblePersona = dep.persona.publicKey && !hiddenKeys.includes(dep.persona.publicKey)
          ? {
              publicKey: dep.persona.publicKey,
              displayName: dep.persona.displayName,
              ...avatarPayloadFor(dep.persona),
              ...(personaProfile ? { publicProfile: personaProfile } : {}),
            }
          : undefined;

        const visibleExtras = (dep.extraPersonas ?? [])
          .filter(ep => !ep.hidden && !hiddenKeys.includes(ep.publicKey))
          .map(ep => {
            const epProfile = publicProfileToInventoryBlock(
              extractConfigFromSlot(ep),
              ep.publicProfile?.enabled ?? false,
            );
            return {
              publicKey: ep.publicKey,
              displayName: ep.displayName,
              ...avatarPayloadFor(ep),
              ...(epProfile ? { publicProfile: epProfile } : {}),
            };
          });

        let backend: LocalSigningBackend;
        try {
          backend = new LocalSigningBackend(endpoint.privateKey);
        } catch {
          // Invalid privkey — skip this dependant silently.
          continue;
        }

        try {
          const ok = await publishPersonaInventory(
            {
              childTransportPubkey: endpoint.authorizedClientPubkey,
              naturalPerson: npVisible
                ? {
                    publicKey: dep.naturalPerson.publicKey,
                    displayName: dep.naturalPerson.displayName,
                    ...avatarPayloadFor(dep.naturalPerson),
                    ...(npProfile ? { publicProfile: npProfile } : {}),
                  }
                : undefined,
              persona: visiblePersona,
              extraPersonas: visibleExtras,
              revision: Math.floor(Date.now() / 1000),
            },
            backend,
            relayUrl,
          );
          if (ok) lastPublishedRef.current.set(dep.id, hash);
        } finally {
          // Fresh LocalSigningBackend per dependant per publish cycle — must
          // be zeroized here or the key material stays referenced until GC
          // (mirrors usePersonaInventory.ts's backend.destroy() on cleanup).
          backend.destroy();
        }
      }
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [dependants, relayUrl, encryptionKey]);
}
