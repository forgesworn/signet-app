/**
 * Cross-device dependant sync, Phase 2.
 *
 * Dependants have a thorny sync problem: they contain **private keys**.
 * We can't publish private keys to a relay, even NIP-44-encrypted to
 * ourselves, without breaking the "keys never leave device" principle
 * this app's security model rests on.
 *
 * Solution: sync only the metadata. On the receiving device, re-derive
 * the private keys deterministically from the guardian's own mnemonic
 * plus the stored `derivationPath`. Since `deriveDependantIdentity`
 * and `deriveExtraPersona` are both pure functions of `(mnemonic,
 * derivationPath)`, a dependant created on device A can be exactly
 * reconstituted on device B with zero key-material in transit.
 *
 * Three dependant sub-cases, each handled differently on receive:
 *
 * 1. **Derived** (`derivationPath` matches `dependant-N`): re-derive
 *    NP + persona via `deriveDependantIdentity`; re-derive extra
 *    personas via `deriveExtraPersona(mnemonic, ep.derivationName)`.
 *
 * 2. **View-only import** (`derivationPath` starts `imported-view-`):
 *    no private keys exist even on origin; save with empty privkeys.
 *
 * 3. **Import with mnemonic** (`derivationPath` starts `imported-`):
 *    receiver doesn't have the source mnemonic; can't reconstruct.
 *    Skipped in sync — user must re-import on each device manually.
 *    Logged as "skipped" via the `skipped` array in the merge result
 *    so the caller (or future UX) can surface "N dependants couldn't
 *    be synced because they were imported from outside your main
 *    Signet."
 *
 * No-deletion policy (same as contacts-sync): remote's absence of a
 * dependant doesn't trigger local removal. Users wanting to delete a
 * dependant must do so on each device. Documented — tombstones are a
 * future refinement for whole dependants. Extra-persona deletions carry
 * permanent tombstones, which win over stale live copies.
 */

import type { UnsignedEvent } from 'signet-protocol';
import type { AutonomyStage, DependantIdentity, ExtraPersona, ExtraPersonaTombstone, GrantSchedule, PersonaPublicProfile } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { deriveDependantIdentity, deriveExtraPersona } from './signet';
import { isDependantNaturalPersonActive } from './identity-display';
import { parseScheduleField } from './grants-sync';
import { isValidRelayUrl } from './relay-url';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { dependantPersonaTombstones, applyDependantPersonaTombstones } from './dependant-persona-allocation';
import { sealVaultPayload, openVaultPayloadOrThrow } from './vault-envelope';

export const SYNC_D_TAG = 'signet:dependants';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;

/** Wire shape for a dependant's extra persona. */
interface SyncedExtraPersona {
  derivationName: string;
  publicKey: string;
  displayName: string;
  lastNameCredentialId?: string;
}

/** Wire shape for a single dependant. Only metadata + pubkeys — never privkeys. */
interface SyncedDependant {
  id: string;
  guardianPubkey: string;
  displayName: string;
  dateOfBirth?: string;
  derivationPath: string;
  autonomyStage: AutonomyStage;
  primaryKeypair: 'natural-person' | 'persona' | string;
  createdAt: number;
  /** NP + Persona pubkeys + display names. Privkeys re-derived on receive. */
  np: { publicKey: string; displayName: string };
  persona: { publicKey: string; displayName: string };
  extras?: SyncedExtraPersona[];
  extraPersonaTombstones?: ExtraPersonaTombstone[];
  /**
   * true when the source dependant is an `imported-view-*` record with
   * no private keys even on the origin device. Receiver saves with
   * empty privkeys.
   */
  viewOnly?: boolean;
  /**
   * Charter clause #1: dep-level default
   * schedule. Carried on the wire as of phase 3. Validated defensively
   * on receive via `parseScheduleField`. Absent or invalid schedules
   * are treated as "no defaultSchedule on this side" for LWW.
   */
  defaultSchedule?: GrantSchedule;
  /**
   * Present and `true` only when the dependant's real identity is activated
   * (spec §3.4 / §7.6). Absence means "this record can't say" — the receiver
   * falls back to the §3.2 lift rule and the merge ORs, so an older device
   * publishing without the field can never deactivate a real identity.
   *
   * **Version skew.** A SECOND GUARDIAN DEVICE still running the parser from
   * before this field existed ignores it and applies the §3.2 lift rule to
   * every record it receives. For a persona-first dependant that rule reads a
   * dormant, empty `np.displayName` and correctly lifts to inactive — but the
   * old build has no persona-first concept downstream, so it renders and QRs
   * `naturalPerson.publicKey` for that dependant anyway.
   *
   * Accepted, for the same reasons as the inventory rail's skew note (see
   * `PersonaInventoryPayload.naturalPerson` in `persona-inventory-sync.ts`):
   * alpha, both devices belong to the same user, and the APK update check
   * (`src/lib/app-update.ts`) brings the stale one current. A `SCHEMA_V` bump
   * would be worse — the old device would reject the whole rail and lose its
   * dependant backup rather than showing one pubkey it should not.
   */
  naturalPersonActive?: true;
}

/**
 * Reconstruction fallback (spec §3.2 / §3.4): a wire record's flag wins when
 * present, otherwise a non-empty NP display name lifts an older-build record
 * to active. Single definition — used by both `keylessRecordFromWire` and
 * `fromSyncWire` so the rule never drifts between the two reconstruction paths.
 */
function wireNaturalPersonActive(wire: Pick<SyncedDependant, 'naturalPersonActive' | 'np'>): boolean {
  return isDependantNaturalPersonActive({
    naturalPersonActive: wire.naturalPersonActive,
    naturalPerson: { publicKey: '', privateKey: '', displayName: wire.np.displayName },
  });
}

interface SyncedDependantsPayload {
  v: number;
  dependants: SyncedDependant[];
}

/** Classify a dependant's derivation path. */
type DependantSource = 'derived' | 'imported-view' | 'imported-private' | 'unknown';
function classifySource(derivationPath: string): DependantSource {
  if (/^dependant-\d+$/.test(derivationPath)) return 'derived';
  if (derivationPath.startsWith('imported-view-')) return 'imported-view';
  if (derivationPath.startsWith('imported-')) return 'imported-private';
  return 'unknown';
}

/**
 * Build a wire-shape dependant from the local IDB record. Returns null
 * for `imported-private` dependants — those can't be sync'd without
 * the source mnemonic, which we don't persist.
 */
export function toSyncWire(dep: DependantIdentity): SyncedDependant | null {
  dep = applyDependantPersonaTombstones(dep);
  const source = classifySource(dep.derivationPath);
  if (source === 'imported-private' || source === 'unknown') return null;

  const extras: SyncedExtraPersona[] = (dep.extraPersonas ?? []).map((ep) => {
    const e: SyncedExtraPersona = {
      derivationName: ep.derivationName,
      publicKey: ep.publicKey,
      displayName: ep.displayName,
    };
    if (ep.lastNameCredentialId) e.lastNameCredentialId = ep.lastNameCredentialId;
    return e;
  });

  const wire: SyncedDependant = {
    id: dep.id,
    guardianPubkey: dep.guardianPubkey,
    displayName: dep.displayName,
    derivationPath: dep.derivationPath,
    autonomyStage: dep.autonomyStage,
    primaryKeypair: dep.primaryKeypair,
    createdAt: dep.createdAt,
    np: { publicKey: dep.naturalPerson.publicKey, displayName: dep.naturalPerson.displayName },
    persona: { publicKey: dep.persona.publicKey, displayName: dep.persona.displayName },
  };
  if (dep.dateOfBirth) wire.dateOfBirth = dep.dateOfBirth;
  if (extras.length > 0) wire.extras = extras;
  const tombstones = dependantPersonaTombstones(dep.derivationPath, dep.extraPersonaTombstones);
  if (tombstones.length) wire.extraPersonaTombstones = tombstones;
  if (source === 'imported-view') wire.viewOnly = true;
  if (dep.defaultSchedule) wire.defaultSchedule = dep.defaultSchedule;
  if (isDependantNaturalPersonActive(dep)) wire.naturalPersonActive = true;
  return wire;
}

/**
 * Build a keyless DependantIdentity from a wire record — every slot
 * (NP, persona, extras) gets `privateKey: ''`. Used for view-only
 * imports (no private keys ever existed) and for keyless receivers
 * accepting a `derived` dependant with no mnemonic to re-derive from
 * (family-bunker §11.1.8) — `derivationPath` is passed through
 * unchanged either way so routing/enrolment can still tell a
 * tree-derived slot from a true import.
 */
function keylessRecordFromWire(wire: SyncedDependant, derivationPath: string): DependantIdentity {
  const dep: DependantIdentity = {
    id: wire.id,
    guardianPubkey: wire.guardianPubkey,
    displayName: wire.displayName,
    naturalPerson: { publicKey: wire.np.publicKey, privateKey: '', displayName: wire.np.displayName },
    persona: { publicKey: wire.persona.publicKey, privateKey: '', displayName: wire.persona.displayName },
    derivationPath,
    createdAt: wire.createdAt,
    autonomyStage: wire.autonomyStage,
    primaryKeypair: wire.primaryKeypair,
    naturalPersonActive: wireNaturalPersonActive(wire),
  };
  if (wire.dateOfBirth) dep.dateOfBirth = wire.dateOfBirth;
  if (wire.extras && wire.extras.length > 0) {
    dep.extraPersonas = wire.extras.map((ep) => ({
      publicKey: ep.publicKey,
      privateKey: '',
      displayName: ep.displayName,
      derivationName: ep.derivationName,
      ...(ep.lastNameCredentialId ? { lastNameCredentialId: ep.lastNameCredentialId } : {}),
    }));
  }
  const ds = parseScheduleField(wire.defaultSchedule);
  if (ds) dep.defaultSchedule = ds;
  dep.extraPersonaTombstones = dependantPersonaTombstones(wire.derivationPath, wire.extraPersonaTombstones);
  return applyDependantPersonaTombstones(dep);
}

/**
 * Reconstruct a full DependantIdentity from a wire-shape record. For
 * derived dependants, re-derives private keys from the guardian's
 * mnemonic. For view-only imports, populates empty privkeys.
 */
export function fromSyncWire(
  wire: SyncedDependant,
  guardianMnemonic: string,
  opts?: { deviceHeldKeys?: boolean },
): DependantIdentity | null {
  const source = classifySource(wire.derivationPath);
  if (source === 'imported-private' || source === 'unknown') return null;

  // Defence-in-depth: even though the sync record decrypted from a gift-
  // wrap addressed to our own key, validate every pubkey field before
  // trusting any of them. A compromised / rogue relay can't forge our
  // ciphertext, but belt-and-braces guards against malformed records
  // that somehow got past the shape check at `fromSyncWireShape`.
  //
  // `persona.publicKey` and extras may legitimately be empty on view-only
  // imports (persona wasn't set on the source device). Skip the hex check
  // in that specific case rather than rejecting the record.
  const HEX64 = /^[0-9a-f]{64}$/i;
  if (!HEX64.test(wire.id)) return null;
  if (!HEX64.test(wire.guardianPubkey)) return null;
  if (!HEX64.test(wire.np.publicKey)) return null;
  if (wire.persona.publicKey !== '' && !HEX64.test(wire.persona.publicKey)) return null;
  for (const ep of wire.extras ?? []) {
    if (ep.publicKey !== '' && !HEX64.test(ep.publicKey)) return null;
  }

  if (source === 'derived') {
    if (!guardianMnemonic) {
      if (!opts?.deviceHeldKeys) return null;
      // Keyless receiver (family-bunker §11.1.8): this phone's family keys
      // live on Heartwood, so there is no mnemonic to cross-check against.
      // Trust the wire's public keys — the payload is NIP-44-encrypted to
      // and signed by our own NP, so tamper resistance is the signature,
      // not the re-derive — and keep `derivationPath` so routing/enrolment
      // treat the dep as tree-derived. Every slot is keyless, exactly like
      // a stripped record.
      return keylessRecordFromWire(wire, wire.derivationPath);
    }
    // Sanity-check the wire pubkeys against freshly derived ones. A
    // mismatch would indicate either a tampered relay payload or a
    // different mnemonic — either way we skip, don't overwrite local.
    const { naturalPerson: np, persona } = deriveDependantIdentity(guardianMnemonic, wire.derivationPath);
    if (np.publicKey !== wire.np.publicKey || persona.publicKey !== wire.persona.publicKey) {
      return null;
    }
    const extras: ExtraPersona[] = (wire.extras ?? []).map((ep) => {
      const derived = deriveExtraPersona(guardianMnemonic, ep.derivationName);
      if (derived.publicKey !== ep.publicKey) {
        // Skip this specific extra persona rather than rejecting the whole dependant.
        return null as unknown as ExtraPersona;
      }
      const e: ExtraPersona = {
        publicKey: ep.publicKey,
        privateKey: derived.privateKey,
        displayName: ep.displayName,
        derivationName: ep.derivationName,
      };
      if (ep.lastNameCredentialId) e.lastNameCredentialId = ep.lastNameCredentialId;
      return e;
    }).filter((x): x is ExtraPersona => x !== null);

    const dep: DependantIdentity = {
      id: wire.id,
      guardianPubkey: wire.guardianPubkey,
      displayName: wire.displayName,
      naturalPerson: {
        publicKey: np.publicKey,
        privateKey: np.privateKey,
        displayName: wire.np.displayName,
      },
      persona: {
        publicKey: persona.publicKey,
        privateKey: persona.privateKey,
        displayName: wire.persona.displayName,
      },
      derivationPath: wire.derivationPath,
      createdAt: wire.createdAt,
      autonomyStage: wire.autonomyStage,
      primaryKeypair: wire.primaryKeypair,
      naturalPersonActive: wireNaturalPersonActive(wire),
    };
    if (wire.dateOfBirth) dep.dateOfBirth = wire.dateOfBirth;
    if (extras.length > 0) dep.extraPersonas = extras;
    const ds = parseScheduleField(wire.defaultSchedule);
    if (ds) dep.defaultSchedule = ds;
    dep.extraPersonaTombstones = dependantPersonaTombstones(wire.derivationPath, wire.extraPersonaTombstones);
    return applyDependantPersonaTombstones(dep);
  }

  // view-only import
  return keylessRecordFromWire(wire, wire.derivationPath);
}

/**
 * Merge a freshly-reconstructed-from-wire dependant with the local IDB
 * record, preserving local-only fields that never cross the wire and
 * unioning extras by publicKey.
 *
 * Why this exists: the wire shape (`SyncedDependant`) intentionally
 * omits fields that are device-local (transport keypairs) or that
 * haven't been added to the sync schema yet (`auditVisibility`).
 * `fromSyncWire` reconstructs a dependant from the wire only, so a
 * naive `db.saveDependant(reconstructed)` clobbers those local-only
 * fields on every fetch. Extras are nominally synced, but the LWW
 * guard in `useDependantsSync` uses `createdAt` (set once at
 * `addDependant` time, never bumped on extras-add), so a stale wire
 * authored *before* an extra was added would also wipe the extra
 * — see the internal issue tracker report. Solution: layer the local
 * record on top, prefer remote for the wire-eligible fields, union
 * extras by publicKey (no-deletion policy, same as the dependants
 * list itself).
 *
 * Returns `remote` unchanged when `local` is null (new dependant
 * arriving from sync — nothing to merge).
 */
/**
 * Preserve slot-level local-only fields when overlaying a freshly-
 * reconstructed-from-wire slot on top of the local copy. The wire
 * intentionally omits `publicProfile` (publish state — `enabled`,
 * `lastEventId`, `lastPublishedAt`, `lastPublishedRelay`,
 * `lastPublishedContentHash`) and the 8 kind-0 config fields (`about`,
 * `pictureUrl`, `pictureBlossomHash`, `bannerUrl`, `bannerBlossomHash`,
 * `nip05`, `lud16`, `website`). Naive `...remote` clobbers these on
 * every sync, which would silently drop a kid's published-kind-0 state
 * and cause a desync between guardian's IDB and the live relay record.
 *
 * See §5.1.3 atomicity contract.
 */
function preserveLocalSlotState<T extends {
  publicProfile?: PersonaPublicProfile;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  // Audit pass 4 additions — device-local fields that aren't on the wire.
  avatarHash?: string;
  avatarBlossomUrl?: string;
  avatarKey?: string;
  avatarUpdatedAt?: number;
  // persona-card-npub-nip05 addition — device-local NIP-05 check result,
  // never carried on the wire (see personas-sync.ts toWire / persona-
  // inventory-sync.ts publicProfileToInventoryBlock, both explicit
  // allowlists that never include these two fields).
  nip05CheckResult?: import('./nip05-check').Nip05CheckResult;
  nip05CheckedAt?: number;
}>(remote: T, local: T | undefined): T {
  if (!local) return remote;
  return {
    ...remote,
    publicProfile: local.publicProfile,
    about: local.about,
    pictureUrl: local.pictureUrl,
    pictureBlossomHash: local.pictureBlossomHash,
    bannerUrl: local.bannerUrl,
    bannerBlossomHash: local.bannerBlossomHash,
    nip05: local.nip05,
    lud16: local.lud16,
    website: local.website,
    nip05CheckResult: local.nip05CheckResult,
    nip05CheckedAt: local.nip05CheckedAt,
    // Audit pass 4 additions:
    // - avatar* fields are per-device encrypted-Blossom mirrors of bunker
    //   endpoints — never propagate cross-device. Every sync was
    //   clobbering them to undefined for any slot the remote omitted.
    // - hidden / imported are ExtraPersona device-local flags. Preserved
    //   via a cast since the generic constraint covers NP+Persona+extras
    //   uniformly but only extras carry these fields.
    avatarHash: local.avatarHash,
    avatarBlossomUrl: local.avatarBlossomUrl,
    avatarKey: local.avatarKey,
    avatarUpdatedAt: local.avatarUpdatedAt,
    ...((local as { hidden?: boolean }).hidden !== undefined
      ? { hidden: (local as { hidden?: boolean }).hidden }
      : {}),
    ...((local as { imported?: boolean }).imported !== undefined
      ? { imported: (local as { imported?: boolean }).imported }
      : {}),
  };
}

/**
 * Never let an empty remote private key clobber a non-empty local one.
 * A keyless-derived remote (family-bunker §11.1.8 — `privateKey: ''`
 * on every slot) can legitimately arrive on a device whose local copy
 * still holds real key material, e.g. the generic-bunker connect path
 * where dependants stay local while `deviceHeldKeys` also evaluates
 * true. Merging naively (`...remote`) would overwrite a real,
 * irrecoverable key with an empty string. Mirrors the existing
 * fallback `unionExtras` already applies to extras' `privateKey`.
 */
function preserveLocalPrivateKey<T extends { privateKey: string }>(remote: T, local: T | undefined): T {
  if (local && remote.privateKey === '' && local.privateKey !== '') {
    return { ...remote, privateKey: local.privateKey };
  }
  return remote;
}

export function mergeDependantWithLocal(
  remote: DependantIdentity,
  local: DependantIdentity | null,
): DependantIdentity {
  if (!local) return applyDependantPersonaTombstones(remote);
  const merged: DependantIdentity = {
    ...remote,
    // Device-local fields: never cross the wire, always keep local copy.
    bunkerEndpoint: local.bunkerEndpoint,
    appBunkerEndpoint: local.appBunkerEndpoint,
    auditVisibility: local.auditVisibility,
    petitionOnDeny: local.petitionOnDeny,
    // Monotonic OR (spec §3.4). Activation propagates; absence on either side
    // never deactivates. Both sides are read through the lift-aware accessor so
    // a pre-field record on either device resolves before the OR.
    naturalPersonActive: isDependantNaturalPersonActive(local) || isDependantNaturalPersonActive(remote),
    // Photo metadata is device-local, same as the bunker-endpoint mirrors
    // above. Each device captures and uploads its own
    // photo; nothing about the captured blob, the chosen Blossom server,
    // or the per-device decryption key should propagate cross-device.
    photoHash: local.photoHash,
    blossomUrl: local.blossomUrl,
    photoKey: local.photoKey,
    photoUpdatedAt: local.photoUpdatedAt,
    // NP + Persona slot-level public-profile state and kind-0 config.
    // These never cross the wire (intentional — see preserveLocalSlotState
    // docstring); a naive `...remote` would clobber them on every sync.
    naturalPerson: preserveLocalPrivateKey(
      preserveLocalSlotState(remote.naturalPerson, local.naturalPerson),
      local.naturalPerson,
    ),
    persona: preserveLocalPrivateKey(
      preserveLocalSlotState(remote.persona, local.persona),
      local.persona,
    ),
    // Extras: union by publicKey. Remote metadata wins (displayName,
    // lastNameCredentialId), local privateKey is a fallback only when
    // remote re-derivation produced an empty privateKey for that entry.
    extraPersonas: unionExtras(local.extraPersonas, remote.extraPersonas),
    extraPersonaTombstones: dependantPersonaTombstones(remote.derivationPath, [
      ...(local.extraPersonaTombstones ?? []), ...(remote.extraPersonaTombstones ?? []),
    ]),
  };
  // Charter clause #1. Schedule rides on the
  // wire as of phase 3: independent LWW on `issuedAt`, with remote
  // breaking ties (consistent with the rest of the merge's posture).
  const newDefault = pickNewerSchedule(local.defaultSchedule, remote.defaultSchedule);
  if (newDefault) merged.defaultSchedule = newDefault;
  else delete merged.defaultSchedule;
  return applyDependantPersonaTombstones(merged);
}

function pickNewerSchedule(
  local: GrantSchedule | undefined,
  remote: GrantSchedule | undefined,
): GrantSchedule | undefined {
  if (local === undefined && remote === undefined) return undefined;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  return remote.issuedAt >= local.issuedAt ? remote : local;
}

function unionExtras(
  local: ExtraPersona[] | undefined,
  remote: ExtraPersona[] | undefined,
): ExtraPersona[] | undefined {
  const byKey = new Map<string, ExtraPersona>();
  for (const ep of local ?? []) {
    if (ep.publicKey) byKey.set(ep.publicKey, ep);
  }
  for (const ep of remote ?? []) {
    if (!ep.publicKey) continue;
    const existing = byKey.get(ep.publicKey);
    // Apply slot-level preservation so per-extra `publicProfile` state and
    // kind-0 config (about, pictureUrl, …) don't get wiped by the remote
    // overlay — same invariant as NP/Persona slots above.
    const merged = preserveLocalSlotState(ep, existing);
    byKey.set(ep.publicKey, {
      ...merged,
      privateKey: ep.privateKey || existing?.privateKey || '',
    });
  }
  const list = Array.from(byKey.values());
  return list.length > 0 ? list : undefined;
}

/**
 * Publish the guardian's dependants to every relay in `relayUrls`,
 * encrypted to self. A plain string is treated as a single-relay pool.
 * Returns true if at least one relay accepted it.
 */
export async function publishDependantsSync(
  dependants: DependantIdentity[],
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
): Promise<boolean> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return false;

  const wire: SyncedDependant[] = [];
  for (const dep of dependants) {
    const s = toSyncWire(dep);
    if (s) wire.push(s);
  }
  const payload: SyncedDependantsPayload = { v: SCHEMA_V, dependants: wire };
  // Never publish an information-free record (see personas-sync.ts) — an
  // empty record carries no information and can only destroy a real one.
  if (payload.dependants.length === 0) return false;
  // Vault envelope v2 (see `vault-envelope.ts`): AES-256-GCM over a padded
  // body, with only the 32-byte content key on the NIP-44 leg. A payload over
  // the top bucket cannot be chunked by this rail, so it refuses to publish
  // rather than truncating — same posture as the information-free guard above.
  const encrypted = await sealVaultPayload(JSON.stringify(payload), backend);
  if (encrypted === null) return false;

  const event: UnsignedEvent = {
    kind: SYNC_KIND,
    pubkey: backend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', SYNC_D_TAG]],
    content: encrypted,
  };
  const signed = await backend.signEvent(event);
  return publishToRelays(signed, targets);
}

/**
 * Fetch the latest synced dependants payload for `authorPubkey` across
 * every relay in `relayUrls`. A plain string is treated as a single-relay
 * pool. Returns `'unreachable'` when no relay in the pool was even
 * queryable (every URL invalid, or every relay unreachable); `null` for
 * a malformed `authorPubkey`, or when at least one relay answered but
 * nothing usable was found; otherwise the resolved payload.
 */
export async function fetchDependantsSync(
  authorPubkey: string,
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
  sinceCreatedAt?: number,
  /**
   * Optional decrypt cache (family-bunker §11.1.10). On a hit, an
   * unchanged relay event needs no `nip44_decrypt` round-trip to the
   * signing device — which post-migration is a 0.4–2 s NIP-46 call.
   */
  cache?: SyncDecryptCache,
): Promise<{ dependants: SyncedDependant[]; createdAt: number; eventId: string; reachableRelays: number } | null | 'unreachable'> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return 'unreachable';
  // A malformed author is a caller bug, not a relay-reachability fact —
  // return null (nothing found), not 'unreachable'.
  if (!/^[0-9a-f]{64}$/i.test(authorPubkey)) return null;

  const { event: latest, reachableRelays } = await fetchNewestFromRelays(
    { kinds: [SYNC_KIND], authors: [authorPubkey], '#d': [SYNC_D_TAG], limit: 1 },
    targets,
    authorPubkey,
  );

  if (reachableRelays === 0) return 'unreachable';
  if (!latest) return null;
  if (sinceCreatedAt !== undefined && latest.created_at <= sinceCreatedAt) return null;

  try {
    const plaintext = await readSyncPlaintext(
      cache,
      latest,
      () => openVaultPayloadOrThrow(latest.content, backend, authorPubkey),
    );
    const parsed = parsePayload(plaintext);
    if (!parsed) return null;
    return { dependants: parsed, createdAt: latest.created_at, eventId: latest.id, reachableRelays };
  } catch {
    return null;
  }
}

// Count caps on the decrypted dependant sync payload (security audit
// 2026-06-15). Self-authored + NIP-44-encrypted, but persisted to IDB — bound
// the array sizes so a replayed/compromised-sibling oversized payload can't
// bloat storage. (Free-text fields are already .slice(0, 200)-capped below.)
const MAX_SYNC_DEPENDANTS = 200;
const MAX_SYNC_EXTRAS = 50;

/**
 * Parse + allowlist-copy a decrypted sync payload. Runtime caller is
 * `fetchDependantsSync`; exported so tests can exercise the real fetch
 * path — a field copied by `toSyncWire`/`fromSyncWire`
 * but missed here silently vanishes on every cross-device fetch.
 */
export function parsePayload(raw: string): SyncedDependant[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V) return null;
  if (!Array.isArray(p.dependants)) return null;
  if (p.dependants.length > MAX_SYNC_DEPENDANTS) return null;

  const out: SyncedDependant[] = [];
  for (const item of p.dependants) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Record<string, unknown>;
    if (typeof d.id !== 'string') continue;
    if (typeof d.derivationPath !== 'string') continue;
    if (typeof d.displayName !== 'string') continue;
    if (typeof d.guardianPubkey !== 'string') continue;
    if (typeof d.createdAt !== 'number') continue;
    if (typeof d.autonomyStage !== 'string') continue;
    if (typeof d.primaryKeypair !== 'string') continue;
    const np = d.np as Record<string, unknown> | undefined;
    const persona = d.persona as Record<string, unknown> | undefined;
    if (!np || typeof np.publicKey !== 'string' || typeof np.displayName !== 'string') continue;
    if (!persona || typeof persona.publicKey !== 'string' || typeof persona.displayName !== 'string') continue;

    const wire: SyncedDependant = {
      id: d.id,
      guardianPubkey: d.guardianPubkey,
      displayName: d.displayName.slice(0, 200),
      derivationPath: d.derivationPath,
      autonomyStage: d.autonomyStage as AutonomyStage,
      primaryKeypair: d.primaryKeypair,
      createdAt: d.createdAt,
      np: { publicKey: np.publicKey, displayName: np.displayName.slice(0, 200) },
      persona: { publicKey: persona.publicKey, displayName: persona.displayName.slice(0, 200) },
    };
    if (typeof d.dateOfBirth === 'string') wire.dateOfBirth = d.dateOfBirth;
    if (Array.isArray(d.extras)) {
      const extras: SyncedExtraPersona[] = [];
      for (const ep of (d.extras as Record<string, unknown>[]).slice(0, MAX_SYNC_EXTRAS)) {
        if (typeof ep.derivationName !== 'string') continue;
        if (typeof ep.publicKey !== 'string') continue;
        if (typeof ep.displayName !== 'string') continue;
        const e: SyncedExtraPersona = {
          derivationName: ep.derivationName,
          publicKey: ep.publicKey,
          displayName: (ep.displayName as string).slice(0, 200),
        };
        if (typeof ep.lastNameCredentialId === 'string') e.lastNameCredentialId = ep.lastNameCredentialId;
        extras.push(e);
      }
      if (extras.length > 0) wire.extras = extras;
    }
    const tombstones = dependantPersonaTombstones(wire.derivationPath, d.extraPersonaTombstones);
    if (tombstones.length) wire.extraPersonaTombstones = tombstones;
    if (d.viewOnly === true) wire.viewOnly = true;
    const ds = parseScheduleField(d.defaultSchedule);
    if (ds) wire.defaultSchedule = ds;
    if (d.naturalPersonActive === true) wire.naturalPersonActive = true;
    out.push(wire);
  }
  return out;
}

