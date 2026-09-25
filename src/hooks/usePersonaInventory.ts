/**
 * Child-side persona-inventory subscriber + merge
 * (2026-05-15-persona-inventory-sync-to-paired-child-design.md §2.6).
 *
 * Runs only in `paired-child` signingMode. Loads the PairedChildRecord,
 * extracts the endpoint pubkey from the stored bunker URI, builds a
 * LocalSigningBackend over the child's transport private key, opens a
 * relay subscription for the guardian's NIP-44-encrypted persona-inventory
 * events, decrypts each one as it arrives, merges into the stored
 * SignetIdentity (public keys + display names only — private keys stay
 * empty since the child never holds signing material), and saves it back
 * encrypted. After each merge it calls `onInventoryMerged()` so App.tsx
 * can reload identity React state and the carousel re-renders.
 *
 * **Subscription model (not one-shot).** Originally a one-shot fetch on
 * mount, but that raced the guardian's 1-second publish debounce on
 * fresh pair: kid unlocks → fetch fires within ~700ms of bind → relay
 * has nothing yet → kid stuck on NP stub. Subscription stays resident
 * so the guardian's publish lands the moment it's on the relay, and
 * subsequent edits (rename, add, hide) flow through without lock/unlock.
 *
 * §2.7 active-persona revocation fallback: if the currently-selected
 * `primaryKeypair` is no longer in the merged inventory, fall back to
 * `'natural-person'` before saving.
 */

import { useEffect, useRef } from 'react';
import type { PairedChildRecord, SignetIdentity, ExtraPersona, PersonaPublicProfile, PublicProfileConfig } from '../types';
import { LocalSigningBackend } from '../lib/signing-backend';
import { subscribePersonaInventory, type PersonaInventoryPayload, type PersonaInventoryPublicProfileBlock } from '../lib/persona-inventory-sync';
// `extractEndpointPubkey` lives on dependant-status-sync — reuse it here
// rather than duplicating the bunker URI authority parser.
import { extractEndpointPubkey } from '../lib/dependant-status-sync';
import * as db from '../lib/db';

interface Options {
  relayUrl: string;
  encryptionKey: string | null;
  dependantPubkey: string | null;
  enabled: boolean;
  /** Called after a successful merge so App.tsx can reload identity React state. */
  onInventoryMerged: () => Promise<void>;
}

export function usePersonaInventory({ relayUrl, encryptionKey, dependantPubkey, enabled, onInventoryMerged }: Options) {
  // Keep onInventoryMerged in a ref so subscription identity doesn't churn
  // every render. The callback is recreated on every App.tsx render
  // (inline arrow), so including it in the subscribe effect's deps would
  // tear down + re-open the relay subscription on every render — which
  // would in turn drop the live subscription mid-publish.
  const onMergedRef = useRef(onInventoryMerged);
  onMergedRef.current = onInventoryMerged;

  useEffect(() => {
    if (!enabled || !encryptionKey || !dependantPubkey) return;

    let active = true;
    let unsubscribe: (() => void) | null = null;
    let backend: LocalSigningBackend | null = null;
    let record: PairedChildRecord | null = null;

    void (async () => {
      record = await db.loadPairedChild(dependantPubkey, encryptionKey).catch(() => null);
      if (!active || !record) return;

      try {
        backend = new LocalSigningBackend(record.clientKeypair.privateKey);
      } catch {
        return;
      }
      if (!active) {
        backend.destroy();
        return;
      }

      const endpointPubkey = extractEndpointPubkey(record.bunkerUri);
      if (!endpointPubkey) return;

      unsubscribe = subscribePersonaInventory(
        endpointPubkey,
        backend,
        relayUrl,
        async ({ payload }) => {
          if (!active) return;
          await mergeInventory(payload, dependantPubkey, encryptionKey);
          await onMergedRef.current();
        },
      );

      if (!active && unsubscribe) {
        // Effect was cleaned up while we were still setting up; tear down
        // the subscription we just opened so we don't leak a websocket.
        unsubscribe();
        unsubscribe = null;
      }
    })();

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribe = null;
      backend?.destroy();
      backend = null;
      record = null;
    };
  }, [enabled, encryptionKey, dependantPubkey, relayUrl]);
}

/**
 * Apply a decrypted inventory payload to the stored SignetIdentity:
 * merge persona + extras (public keys + display names), drop stale
 * revisions, and fall back to NP if the active persona disappeared.
 * Exported for testability.
 */
export async function mergeInventory(
  payload: PersonaInventoryPayload,
  dependantPubkey: string,
  encryptionKey: string,
): Promise<void> {
  const cachedRevision = await db.loadPairedChildPersonaRevision().catch(() => 0);
  if (payload.revision <= cachedRevision) return;

  const stored: SignetIdentity | undefined = await db
    .loadIdentityDecrypted(dependantPubkey, encryptionKey)
    .catch(() => undefined);
  if (!stored) return;

  // Carry avatar fields through from the inventory payload onto the kid's
  // local persona slots. The publisher (Phase 3) emits them when
  // the guardian has set a photo; we merge them so `useResolvedAvatar`
  // (Phase 1) picks them up and renders the decrypted blob. All-or-nothing
  // semantics: if any of hash/url/key is missing the field stays absent on
  // the merged record. The kid's NP slot is mostly a stub (no signing
  // key here) — we keep `naturalPerson.publicKey/privateKey/displayName`
  // from the stored seed but accept any new avatar fields the publisher
  // sent, since those CAN change between syncs.
  // Merge publicProfile config from the wire onto the kid's slot, PRESERVING
  // kid-local publication state fields (`lastEventId`, `lastPublishedAt`,
  // `lastPublishedRelay`). The guardian owns the configuration; the kid
  // owns the state. Lookup uses the slot's pubkey on the existing stored
  // record so a renamed/moved slot still picks up its prior state.
  const findStoredExtra = (pubkey: string) =>
    (stored.extraPersonas ?? []).find(ep => ep.publicKey === pubkey);

  const mergedExtras: ExtraPersona[] = payload.extraPersonas.map(ep => {
    const localExtra = findStoredExtra(ep.publicKey);
    const { config: cfg, state: st } = mergeSlotPublicConfig(
      ep.publicProfile,
      localExtra ? extractConfigFromSlot(localExtra) : undefined,
      localExtra?.publicProfile,
    );
    return {
      publicKey: ep.publicKey,
      privateKey: '',
      displayName: ep.displayName,
      derivationName: '',
      avatarHash: ep.avatarHash,
      avatarBlossomUrl: ep.avatarBlossomUrl,
      avatarKey: ep.avatarKey,
      avatarUpdatedAt: ep.avatarUpdatedAt,
      ...(cfg ?? {}),
      publicProfile: st,
    };
  });

  const npMerge = payload.naturalPerson
    ? mergeSlotPublicConfig(
        payload.naturalPerson.publicProfile,
        extractConfigFromSlot(stored.naturalPerson),
        stored.naturalPerson.publicProfile,
      )
    : { config: undefined, state: undefined };
  const personaMerge = mergeSlotPublicConfig(
    payload.persona?.publicProfile,
    extractConfigFromSlot(stored.persona),
    stored.persona.publicProfile,
  );

  // For NP/persona slots, we rebuild the 8 optional public-profile config
  // fields purely from the wire when the wire carried a publicProfile block
  // (wire-wins-wipes). Keys the guardian dropped are explicitly set to
  // `undefined` so a `...stored.naturalPerson` spread can't leak them back.
  // When the wire omits `publicProfile` entirely (older guardian publish),
  // we leave the stored slot's config fields untouched. Slot identity
  // (`displayName`) comes from the wire's top-level entry, not from the
  // publicProfile config.
  const applyConfigWithWipes = (
    wirePresent: boolean,
    cfg: PublicProfileConfig | undefined,
    prevNip05: string | undefined,
  ) => {
    if (!wirePresent) return {};
    // A locally-stored NIP-05 check result is only meaningful for the
    // exact identifier it was computed against. `...stored.naturalPerson`
    // / `...stored.persona` is spread BEFORE this patch at each call site,
    // so without this the check fields would silently survive a guardian
    // rename and the kid's card would show "Verified" for an identifier
    // this device never actually checked.
    const nip05Changed = (cfg?.nip05 ?? undefined) !== (prevNip05 ?? undefined);
    return {
      about: cfg?.about,
      pictureUrl: cfg?.pictureUrl,
      pictureBlossomHash: cfg?.pictureBlossomHash,
      bannerUrl: cfg?.bannerUrl,
      bannerBlossomHash: cfg?.bannerBlossomHash,
      nip05: cfg?.nip05,
      lud16: cfg?.lud16,
      website: cfg?.website,
      ...(nip05Changed ? { nip05CheckResult: undefined, nip05CheckedAt: undefined } : {}),
    };
  };

  const merged: SignetIdentity = {
    ...stored,
    // Spec §7.6. The pair-time seed writes the dependant's `id` into the
    // kid's NP slot, and for a persona-first dependant that id IS the
    // persona pubkey. When the guardian's inventory omits the real
    // identity, clear the stub rather than leaving a second row rendering
    // the same key under a real-identity label.
    naturalPerson: payload.naturalPerson
      ? {
          ...stored.naturalPerson,
          avatarHash: payload.naturalPerson.avatarHash,
          avatarBlossomUrl: payload.naturalPerson.avatarBlossomUrl,
          avatarKey: payload.naturalPerson.avatarKey,
          avatarUpdatedAt: payload.naturalPerson.avatarUpdatedAt,
          ...applyConfigWithWipes(
            payload.naturalPerson.publicProfile !== undefined,
            npMerge.config,
            stored.naturalPerson.nip05,
          ),
          publicProfile: npMerge.state,
        }
      : { publicKey: '', privateKey: '', displayName: '' },
    primaryKeypair: payload.naturalPerson ? stored.primaryKeypair : 'persona',
    naturalPersonActive: !!payload.naturalPerson,
    persona: {
      // Sibling to fix 1 (sweep-2 medium): spread stored.persona FIRST so
      // that when `applyConfigWithWipes(false, _)` returns `{}` (wire omits
      // the persona's publicProfile block, e.g. older guardian / mid-rollout)
      // the kid's local kind-0 config fields (about, pictureUrl, etc.) are
      // preserved. Matches the NP slot above.
      ...stored.persona,
      publicKey: payload.persona?.publicKey ?? '',
      privateKey: '',
      displayName: payload.persona?.displayName ?? '',
      avatarHash: payload.persona?.avatarHash,
      avatarBlossomUrl: payload.persona?.avatarBlossomUrl,
      avatarKey: payload.persona?.avatarKey,
      avatarUpdatedAt: payload.persona?.avatarUpdatedAt,
      ...applyConfigWithWipes(
        payload.persona?.publicProfile !== undefined,
        personaMerge.config,
        stored.persona.nip05,
      ),
      publicProfile: personaMerge.state,
    },
    extraPersonas: mergedExtras,
  };

  // §2.7 revocation fallback. If the active persona is no longer in
  // the merged inventory, reset to NP so the carousel lands somewhere
  // valid. No error shown — the picker rendered the lapsed row from
  // local state on the last unlock; by the next render it's gone.
  const primary = merged.primaryKeypair;
  if (primary === 'persona' && merged.persona.publicKey === '') {
    merged.primaryKeypair = 'natural-person';
  } else if (primary !== 'natural-person' && primary !== 'persona') {
    const stillPresent = merged.extraPersonas?.some(ep => ep.publicKey === primary);
    if (!stillPresent) {
      merged.primaryKeypair = 'natural-person';
    }
  }

  await db.saveIdentityEncrypted(merged, encryptionKey);
  await db.savePairedChildPersonaRevision(payload.revision);
}

/**
 * Pull the public-profile **config** fields off a keypair slot. The 9 fields
 * (`displayName`, `about`, `pictureUrl`, …) live as top-level slot keys per
 * Phase 1's persona-card-as-source-of-truth split — `publicProfile` itself
 * is state only (`enabled`, `lastEventId`, …). Returns `undefined` when none
 * of the optional fields is set AND `displayName` is empty, so callers can
 * cleanly decide whether the slot has any config worth merging.
 */
export function extractConfigFromSlot(slot: {
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
 * Merge an incoming inventory publicProfile block (guardian-owned config)
 * with the kid's local slot config + locally-stored state. Returns config
 * and state SEPARATELY so the caller can spread `config` onto the slot's
 * top-level fields and assign `state` to the slot's `publicProfile`.
 *
 * **Wire-wins-wipes semantics** (matches original `mergePublicProfile`
 * before the Phase 1 T6 split — see the internal design notes §5 "Cross-device
 * sync rail unchanged in spirit"). When `remote` is present, config comes
 * PURELY from the wire — any field the guardian dropped disappears from
 * the merged record. This is essential so guardian-side deletions
 * propagate to the kid.
 *
 * - `localState` is preserved verbatim — kid owns publication state per
 *   §5.4. Only the `enabled` bit is taken from the wire (the guardian
 *   flipping enabled on/off must propagate); `lastEventId`/`lastPublishedAt`/
 *   `lastPublishedRelay` stay kid-owned.
 * - When the wire omits the block entirely (older guardian publish),
 *   return `localConfig` and `localState` as-is — no wire = no sync this
 *   round; don't wipe kid state.
 */
export function mergeSlotPublicConfig(
  remote: PersonaInventoryPublicProfileBlock | undefined,
  localConfig: PublicProfileConfig | undefined,
  localState: PersonaPublicProfile | undefined,
): { config: PublicProfileConfig | undefined; state: PersonaPublicProfile | undefined } {
  if (!remote) {
    return { config: localConfig, state: localState };
  }
  // Config: take EVERY field from the wire. Guardian-dropped fields
  // disappear from the merged record (wire-wins-wipes). `displayName`
  // falls back to the legacy `name` field for older guardian payloads.
  const displayName = remote.displayName ?? remote.name ?? '';
  const candidateConfig: PublicProfileConfig = { displayName };
  if (remote.about) candidateConfig.about = remote.about;
  if (remote.pictureUrl) candidateConfig.pictureUrl = remote.pictureUrl;
  if (remote.pictureBlossomHash) candidateConfig.pictureBlossomHash = remote.pictureBlossomHash;
  if (remote.bannerUrl) candidateConfig.bannerUrl = remote.bannerUrl;
  if (remote.bannerBlossomHash) candidateConfig.bannerBlossomHash = remote.bannerBlossomHash;
  if (remote.nip05) candidateConfig.nip05 = remote.nip05;
  if (remote.lud16) candidateConfig.lud16 = remote.lud16;
  if (remote.website) candidateConfig.website = remote.website;
  const hasConfig =
    candidateConfig.displayName !== '' ||
    !!candidateConfig.about ||
    !!candidateConfig.pictureUrl ||
    !!candidateConfig.pictureBlossomHash ||
    !!candidateConfig.bannerUrl ||
    !!candidateConfig.bannerBlossomHash ||
    !!candidateConfig.nip05 ||
    !!candidateConfig.lud16 ||
    !!candidateConfig.website;
  const config = hasConfig ? candidateConfig : undefined;

  // State: take `enabled` from the wire (guardian policy), preserve kid-owned
  // publication-state fields verbatim.
  const state: PersonaPublicProfile = { enabled: remote.enabled };
  if (localState?.lastEventId) state.lastEventId = localState.lastEventId;
  if (localState?.lastPublishedAt) state.lastPublishedAt = localState.lastPublishedAt;
  if (localState?.lastPublishedRelay) state.lastPublishedRelay = localState.lastPublishedRelay;
  if (localState?.lastPublishedContentHash) state.lastPublishedContentHash = localState.lastPublishedContentHash;

  return { config, state };
}
