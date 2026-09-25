/**
 * Cross-device sync for the owner's extra personas (persona-N, derived via
 * nsec-tree). Cloned from `dependants-sync.ts` — same shape of problem
 * (never put private keys on the wire; re-derive from the mnemonic on the
 * receiving device instead), same NIP-44-to-self kind-30078 replaceable
 * event, extended to fan out over the whole configured relay pool rather
 * than a single relay (see `sync-relays.ts`).
 *
 * Wire payload carries public metadata only: pubkey, display name, hidden
 * flag, the 8 kind-0 *config* fields (never `publicProfile` publication
 * state, never avatar/contact-avatar material), and an `updatedAt` stamp
 * used for last-writer-wins. It also carries two owner-level facts about
 * the real-name slot — `naturalPersonActive` and, with it,
 * `naturalPersonDisplayName` — so a device that learns of an activation here
 * has a name to show for it. Never reached on a paired-child install: App.tsx
 * passes `identity: null` to `usePersonasSync` there, so the rail is inert. Tombstones (`ExtraPersonaTombstone`) let a
 * persona removed on one device stay removed everywhere, since the wire
 * itself has no concept of "this used to exist and is now gone" beyond
 * "it's absent from `personas`."
 *
 * Receive side has three cases per persona, same posture as dependants:
 *
 * 1. **Mnemonic present** — re-derive via `deriveExtraPersona(mnemonic,
 *    derivationName)` and REQUIRE the derived pubkey to equal the wire
 *    pubkey. A mismatch means either a tampered/rogue payload or a
 *    different mnemonic; either way the persona is skipped, never
 *    silently trusted.
 * 2. **No mnemonic, `deviceHeldKeys`** (family-bunker §11.1.8 posture) —
 *    accept the wire pubkey keyless (`privateKey: ''`); trust comes from
 *    the NIP-44-to-self envelope + signature, not from re-deriving.
 * 3. **Neither** — can't reconstitute; the derivationName is reported in
 *    `MergeResult.skipped`.
 */

import type { UnsignedEvent } from 'signet-protocol';
import type { ExtraPersona, ExtraPersonaTombstone, PublicProfileConfig, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { deriveExtraPersona } from './signet';
import { isNaturalPersonActive } from './identity-display';
import { isValidRelayUrl } from './relay-url';
import { safeImageOrLinkUrl } from './public-profile-publish';
import { sanitizeDisplayName } from './text-sanitize';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { sealVaultPayload, openVaultPayloadOrThrow } from './vault-envelope';

export const SYNC_D_TAG = 'signet:personas';
const SYNC_KIND = 30078;
const SCHEMA_V = 1 as const;

const HEX64 = /^[0-9a-f]{64}$/i;
const DERIVATION_NAME_RE = /^persona-\d+$/;
const NIP05_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

const CAP_DISPLAY_NAME = 100;
const CAP_ABOUT = 500;
const CAP_PICTURE_URL = 500;
const CAP_BANNER_URL = 500;
const CAP_NIP05 = 100;
const CAP_LUD16 = 100;
const CAP_WEBSITE = 300;

// Count caps on the decrypted payload (same posture as dependants-sync.ts /
// persona-inventory-sync.ts) — self-authored + NIP-44-encrypted, but
// persisted to IDB, so bound the array sizes defensively.
const MAX_SYNC_PERSONAS = 200;
const MAX_SYNC_TOMBSTONES = 200;

/** The 8 kind-0 config fields carried on the wire (never `displayName`, never state). */
const PROFILE_FIELD_KEYS = [
  'about',
  'pictureUrl',
  'pictureBlossomHash',
  'bannerUrl',
  'bannerBlossomHash',
  'nip05',
  'lud16',
  'website',
] as const;

export interface SyncedOwnerPersona {
  derivationName: string;
  publicKey: string;
  displayName: string;
  hidden?: boolean;
  updatedAt: number;
  lastNameCredentialId?: string;
  /** The 8 config fields only — never `publicProfile` (publication state). */
  profile?: Partial<PublicProfileConfig>;
}

export interface SyncedPersonasPayload {
  v: 1;
  personas: SyncedOwnerPersona[];
  tombstones: ExtraPersonaTombstone[];
  professional?: { publicKey: string; displayName: string; updatedAt: number };
  /**
   * Present (and always literally `true`) when the publishing device has an
   * ACTIVATED real-name slot. Absent means "this device has not activated" —
   * NOT "deactivate". The receive side ORs it, so activation propagates and
   * nothing on the wire can turn it back off. Carries no name: the NP display
   * name is not synced by this rail, only the fact of activation.
   */
  naturalPersonActive?: true;
  /**
   * The activated real-name display name. Present ONLY alongside
   * `naturalPersonActive` and only when non-empty — a device that learns of an
   * activation from this rail alone would otherwise show a nameless real
   * identity it has no way to fill in (the NP name is on no other owner rail).
   *
   * Not last-writer-wins: the receive side adopts it only into an EMPTY local
   * name, never over one this device already holds, so no timestamp is needed
   * and two named devices can never fight over it.
   */
  naturalPersonDisplayName?: string;
}

/**
 * Build the wire payload from a local identity. Skips imported extras
 * (`imported: true` / empty `derivationName`) — those never had a tree
 * derivation, so a receiving device could never reconstitute them anyway;
 * same posture as `dependants-sync.ts`'s `imported-private` case. Order
 * follows `identity.extraPersonas` array order.
 */
export function toWire(identity: SignetIdentity): SyncedPersonasPayload {
  const personas: SyncedOwnerPersona[] = [];
  for (const ep of identity.extraPersonas ?? []) {
    if (ep.imported || !ep.derivationName) continue;
    const wire: SyncedOwnerPersona = {
      derivationName: ep.derivationName,
      publicKey: ep.publicKey,
      displayName: ep.displayName,
      updatedAt: ep.updatedAt ?? 0,
    };
    if (ep.hidden !== undefined) wire.hidden = ep.hidden;
    if (ep.lastNameCredentialId) wire.lastNameCredentialId = ep.lastNameCredentialId;
    const profile = extractProfileFields(ep);
    if (profile) wire.profile = profile;
    personas.push(wire);
  }

  const payload: SyncedPersonasPayload = {
    v: SCHEMA_V,
    // Fresh allowlisted objects — never pass the local array by reference,
    // so a caller mutating the wire payload can't reach back into the
    // identity's own tombstone records.
    tombstones: (identity.extraPersonaTombstones ?? []).map((t) => ({
      derivationName: t.derivationName,
      removedAt: t.removedAt,
    })),
    personas,
  };

  if (identity.professionalPersona) {
    // `professionalPersona.updatedAt` is stamped by `updateDisplayName` on
    // every rename (see useIdentity.ts) — real LWW data, not a proxy.
    // Legacy records predating that stamp fall back to 0 (older than any
    // real remote update, so a genuine remote record always wins for them).
    payload.professional = {
      publicKey: identity.professionalPersona.publicKey,
      displayName: identity.professionalPersona.displayName,
      updatedAt: identity.professionalPersona.updatedAt ?? 0,
    };
  }

  if (isNaturalPersonActive(identity)) {
    payload.naturalPersonActive = true;
    // Sanitised + capped here as well as on parse: the wire is the boundary in
    // both directions, and a name that would not survive `parsePayload` must
    // never be published in the first place.
    const npName = sanitizeDisplayName(identity.naturalPerson.displayName ?? '', CAP_DISPLAY_NAME);
    if (npName) payload.naturalPersonDisplayName = npName;
  }

  return payload;
}

function extractProfileFields(ep: ExtraPersona): Partial<PublicProfileConfig> | undefined {
  const out: Partial<PublicProfileConfig> = {};
  for (const key of PROFILE_FIELD_KEYS) {
    const v = ep[key];
    if (typeof v === 'string' && v.length > 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseProfileField(raw: unknown): Partial<PublicProfileConfig> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<PublicProfileConfig> = {};
  if (typeof r.about === 'string' && r.about.length > 0 && r.about.length <= CAP_ABOUT) {
    out.about = r.about;
  }
  if (
    typeof r.pictureUrl === 'string' && r.pictureUrl.length > 0 && r.pictureUrl.length <= CAP_PICTURE_URL &&
    safeImageOrLinkUrl(r.pictureUrl)
  ) {
    out.pictureUrl = r.pictureUrl;
  }
  if (typeof r.pictureBlossomHash === 'string' && HEX64.test(r.pictureBlossomHash)) {
    out.pictureBlossomHash = r.pictureBlossomHash.toLowerCase();
  }
  if (
    typeof r.bannerUrl === 'string' && r.bannerUrl.length > 0 && r.bannerUrl.length <= CAP_BANNER_URL &&
    safeImageOrLinkUrl(r.bannerUrl)
  ) {
    out.bannerUrl = r.bannerUrl;
  }
  if (typeof r.bannerBlossomHash === 'string' && HEX64.test(r.bannerBlossomHash)) {
    out.bannerBlossomHash = r.bannerBlossomHash.toLowerCase();
  }
  if (typeof r.nip05 === 'string' && r.nip05.length > 0 && r.nip05.length <= CAP_NIP05 && NIP05_RE.test(r.nip05)) {
    out.nip05 = r.nip05;
  }
  if (typeof r.lud16 === 'string' && r.lud16.length > 0 && r.lud16.length <= CAP_LUD16 && NIP05_RE.test(r.lud16)) {
    out.lud16 = r.lud16;
  }
  if (
    typeof r.website === 'string' && r.website.length > 0 && r.website.length <= CAP_WEBSITE &&
    safeImageOrLinkUrl(r.website)
  ) {
    out.website = r.website;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A finite, non-negative Unix-seconds timestamp — rejects NaN/Infinity/negative. */
function isValidTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Parse + allowlist-copy a decrypted sync payload. Strict runtime guards:
 * wrong `v` invalidates the whole payload; a malformed individual persona
 * or tombstone entry is dropped (skipped), not fatal to the rest —
 * mirrors `dependants-sync.ts`'s `parsePayload`.
 */
export function parsePayload(raw: string): SyncedPersonasPayload | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (p.v !== SCHEMA_V) return null;
  if (!Array.isArray(p.personas)) return null;
  if (!Array.isArray(p.tombstones)) return null;

  const personas: SyncedOwnerPersona[] = [];
  for (const item of p.personas.slice(0, MAX_SYNC_PERSONAS)) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Record<string, unknown>;
    if (typeof d.derivationName !== 'string' || !DERIVATION_NAME_RE.test(d.derivationName)) continue;
    if (typeof d.publicKey !== 'string' || !HEX64.test(d.publicKey)) continue;
    if (typeof d.displayName !== 'string' || d.displayName.length > CAP_DISPLAY_NAME) continue;
    if (!isValidTimestamp(d.updatedAt)) continue;

    const wire: SyncedOwnerPersona = {
      derivationName: d.derivationName,
      publicKey: d.publicKey.toLowerCase(),
      displayName: d.displayName,
      updatedAt: d.updatedAt,
    };
    if (typeof d.hidden === 'boolean') wire.hidden = d.hidden;
    if (typeof d.lastNameCredentialId === 'string' && HEX64.test(d.lastNameCredentialId)) {
      wire.lastNameCredentialId = d.lastNameCredentialId.toLowerCase();
    }
    const profile = parseProfileField(d.profile);
    if (profile) wire.profile = profile;
    personas.push(wire);
  }

  const tombstones: ExtraPersonaTombstone[] = [];
  for (const item of p.tombstones.slice(0, MAX_SYNC_TOMBSTONES)) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.derivationName !== 'string' || !DERIVATION_NAME_RE.test(t.derivationName)) continue;
    if (!isValidTimestamp(t.removedAt)) continue;
    tombstones.push({ derivationName: t.derivationName, removedAt: t.removedAt });
  }

  const payload: SyncedPersonasPayload = { v: SCHEMA_V, personas, tombstones };

  if (p.professional !== undefined && typeof p.professional === 'object' && p.professional !== null) {
    const pro = p.professional as Record<string, unknown>;
    if (
      typeof pro.publicKey === 'string' && HEX64.test(pro.publicKey) &&
      typeof pro.displayName === 'string' && pro.displayName.length <= CAP_DISPLAY_NAME &&
      isValidTimestamp(pro.updatedAt)
    ) {
      payload.professional = {
        publicKey: pro.publicKey.toLowerCase(),
        displayName: pro.displayName,
        updatedAt: pro.updatedAt,
      };
    }
  }

  // Only a literal `true` counts. Anything else (false, 1, 'yes', an object)
  // is dropped rather than coerced — the field is monotonic, so a coerced
  // truthy value would be unrecoverable on every device that merges it.
  if (p.naturalPersonActive === true) {
    payload.naturalPersonActive = true;
    // Only carried with the flag — a name on its own says nothing this rail can
    // act on, and adopting it would name a slot the record never claimed is
    // active. Over-long is dropped rather than truncated: a silently-shortened
    // legal name is worse than none.
    if (
      typeof p.naturalPersonDisplayName === 'string'
      && p.naturalPersonDisplayName.length <= CAP_DISPLAY_NAME
    ) {
      const name = sanitizeDisplayName(p.naturalPersonDisplayName, CAP_DISPLAY_NAME);
      if (name) payload.naturalPersonDisplayName = name;
    }
  }

  return payload;
}

export interface MergeInput {
  local: ExtraPersona[];
  localTombstones: ExtraPersonaTombstone[];
  /** Last publish/fetch time we consider "ours" — for the ordering rule below. */
  localRecordAt: number;
  remote: SyncedPersonasPayload;
  remoteCreatedAt: number;
  mnemonic: string | null;
  deviceHeldKeys: boolean;
  /** This device's current `naturalPersonActive` (read via `isNaturalPersonActive`). */
  localNaturalPersonActive: boolean;
  /**
   * This device's current `naturalPerson.displayName`. Empty is the ONLY case
   * in which a remote name is adopted — see `MergeResult.naturalPersonDisplayName`.
   */
  localNaturalPersonDisplayName: string;
}

export interface MergeResult {
  extraPersonas: ExtraPersona[];
  tombstones: ExtraPersonaTombstone[];
  changed: boolean;
  /** derivationNames we could not reconstitute (no mnemonic match, no deviceHeldKeys). */
  skipped: string[];
  /**
   * `local || remote` — monotonic. True here with `localNaturalPersonActive`
   * false is the only case that makes `changed` fire on this field alone.
   */
  naturalPersonActive: boolean;
  /**
   * A real-identity name to adopt, set ONLY when this device's own NP name is
   * empty and the remote record is an activated one carrying a name. Undefined
   * means "leave the local name alone" — never "clear it".
   *
   * This is what stops a cross-device activation landing as a nameless active
   * real identity: the flag propagates monotonically, and the name rides with
   * it for exactly the device that has none.
   */
  naturalPersonDisplayName?: string;
}

/**
 * Merge a freshly-fetched remote personas payload with the local extras
 * array. Pure — no IDB, no relay I/O.
 *
 * - Reconstitutes each remote persona per the mnemonic/deviceHeldKeys/skip
 *   rules described in the module docstring.
 * - LWW per derivationName on `updatedAt` (remote breaks ties, consistent
 *   with `dependants-sync.ts`'s `pickNewerSchedule`). When remote wins, the
 *   result is `{ ...local, ...remoteFields }` so local-only fields (avatar
 *   material, `publicProfile` state) survive; when local wins, local is
 *   returned unchanged.
 * - Tombstones from both sides are unioned by derivationName (newest
 *   `removedAt` wins); a persona is dropped from the result when a
 *   tombstone's `removedAt >= that persona's (winning) updatedAt` — tie
 *   goes to the tombstone. Tombstones never apply to imported locals
 *   (empty `derivationName` / `imported: true`), which pass through
 *   untouched and keep their original relative position.
 * - Ordering: when the remote record is newer than our own
 *   (`remoteCreatedAt > localRecordAt`), the result follows remote order
 *   for personas the remote knows about, then any local-only personas in
 *   their existing relative order, at the tail. Otherwise local order is
 *   kept and any brand-new remote-only personas are appended at the tail.
 */
export function mergePersonas(input: MergeInput): MergeResult {
  const { local, localTombstones, localRecordAt, remote, remoteCreatedAt, mnemonic, deviceHeldKeys, localNaturalPersonActive, localNaturalPersonDisplayName } = input;
  const skipped: string[] = [];

  // 1. Reconstitute remote candidates, keyed by derivationName.
  const remoteMap = new Map<string, ExtraPersona>();
  for (const w of remote.personas) {
    let privateKey: string;
    if (mnemonic) {
      const derived = deriveExtraPersona(mnemonic, w.derivationName);
      if (derived.publicKey.toLowerCase() !== w.publicKey.toLowerCase()) {
        skipped.push(w.derivationName);
        continue;
      }
      privateKey = derived.privateKey;
    } else if (deviceHeldKeys) {
      privateKey = '';
    } else {
      skipped.push(w.derivationName);
      continue;
    }
    const candidate: ExtraPersona = {
      publicKey: w.publicKey,
      privateKey,
      displayName: w.displayName,
      derivationName: w.derivationName,
      updatedAt: w.updatedAt,
    };
    if (w.hidden !== undefined) candidate.hidden = w.hidden;
    if (w.lastNameCredentialId !== undefined) candidate.lastNameCredentialId = w.lastNameCredentialId;
    if (w.profile) Object.assign(candidate, w.profile);
    remoteMap.set(w.derivationName, candidate);
  }

  // 2. Local map (derived only) + imported passthrough (never touched by
  // remote merge or tombstones).
  const localMap = new Map<string, ExtraPersona>();
  const importedLocals: ExtraPersona[] = [];
  for (const p of local) {
    if (p.imported || !p.derivationName) {
      importedLocals.push(p);
    } else {
      localMap.set(p.derivationName, p);
    }
  }

  // 3. Tombstone union — newest removedAt wins.
  const tombstoneMap = new Map<string, ExtraPersonaTombstone>();
  for (const t of [...localTombstones, ...remote.tombstones]) {
    const existing = tombstoneMap.get(t.derivationName);
    if (!existing || t.removedAt > existing.removedAt) tombstoneMap.set(t.derivationName, t);
  }

  // 4. Resolve a winner per derivationName, then apply the tombstone drop.
  const allDerivationNames = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
  const winners = new Map<string, ExtraPersona>();
  for (const dn of allDerivationNames) {
    const l = localMap.get(dn);
    const r = remoteMap.get(dn);
    let winner: ExtraPersona;
    if (l && r) {
      const localUpdatedAt = l.updatedAt ?? 0;
      const remoteUpdatedAt = r.updatedAt ?? 0;
      if (remoteUpdatedAt >= localUpdatedAt) {
        // A profile config field absent from the wire candidate `r` means
        // the winning device doesn't have it set (either never set, or
        // explicitly cleared) — `extractProfileFields`/`w.profile` omit
        // falsy fields, so "absent" is the only signal a clear gets on
        // this wire. Explicitly null those keys out before spreading `r`
        // on top of `l`, or a field the remote side cleared would keep
        // showing the stale local value forever (a bare `{...l, ...r}`
        // only overwrites keys `r` actually carries).
        const cleared: Partial<Record<(typeof PROFILE_FIELD_KEYS)[number], undefined>> = {};
        for (const key of PROFILE_FIELD_KEYS) {
          if (!(key in r)) cleared[key] = undefined;
        }
        winner = {
          ...l,
          ...cleared,
          ...r,
          // Never let a keyless remote (deviceHeldKeys receiver) clobber a
          // real local private key — same convention as dependants-sync.ts's
          // `preserveLocalPrivateKey`.
          privateKey: r.privateKey || l.privateKey || '',
        };
        // A locally-stored NIP-05 check result is only meaningful for the
        // exact identifier it was computed against. The winning nip05 can
        // come from `r` (remote wins the merge above) while the check
        // fields never travel on the wire at all — without this, a
        // cross-device rename would leave a stale "Verified" pointing at
        // an identifier this device never actually checked.
        if (winner.nip05 !== l.nip05) {
          winner.nip05CheckResult = undefined;
          winner.nip05CheckedAt = undefined;
        }
      } else {
        winner = l;
      }
    } else {
      winner = (r ?? l)!;
    }
    const tomb = tombstoneMap.get(dn);
    if (tomb && tomb.removedAt >= (winner.updatedAt ?? 0)) continue;
    winners.set(dn, winner);
  }

  // 5. Ordering.
  let orderedNames: string[];
  if (remoteCreatedAt > localRecordAt) {
    const seen = new Set<string>();
    const remoteOrder: string[] = [];
    for (const w of remote.personas) {
      if (winners.has(w.derivationName) && !seen.has(w.derivationName)) {
        seen.add(w.derivationName);
        remoteOrder.push(w.derivationName);
      }
    }
    const localOnly = Array.from(localMap.keys()).filter((dn) => winners.has(dn) && !seen.has(dn));
    orderedNames = [...remoteOrder, ...localOnly];
  } else {
    const seen = new Set<string>();
    const localOrder: string[] = [];
    for (const dn of localMap.keys()) {
      if (winners.has(dn) && !seen.has(dn)) {
        seen.add(dn);
        localOrder.push(dn);
      }
    }
    const remoteOnlySeen = new Set<string>();
    const remoteOnly: string[] = [];
    for (const w of remote.personas) {
      if (winners.has(w.derivationName) && !seen.has(w.derivationName) && !remoteOnlySeen.has(w.derivationName)) {
        remoteOnlySeen.add(w.derivationName);
        remoteOnly.push(w.derivationName);
      }
    }
    orderedNames = [...localOrder, ...remoteOnly];
  }

  const orderedWinners = orderedNames.map((dn) => winners.get(dn)!);

  // Splice the ordered derived-persona block in at the position of the
  // FIRST non-imported local entry; every other originally-non-imported
  // slot is then skipped (it's already represented inside the block).
  // This does NOT preserve exact interleaving — an imported persona keeps
  // its position relative to the first derived persona, but the whole
  // derived block moves as one unit, so an imported persona that used to
  // sit *between* two derived ones ends up after both:
  //   local order  [P1, IMPORTED, P2]  →  result  [P1, P2, IMPORTED]
  // Good enough given the ordering ruling only specifies behaviour for
  // derivation-named personas; imported personas merely need to survive
  // somewhere sane, not preserve exact interleaving with derived ones.
  const extraPersonas: ExtraPersona[] = [];
  let spliced = false;
  for (const p of local) {
    if (p.imported || !p.derivationName) {
      extraPersonas.push(p);
    } else if (!spliced) {
      extraPersonas.push(...orderedWinners);
      spliced = true;
    }
  }
  if (!spliced) extraPersonas.push(...orderedWinners);

  const tombstones = Array.from(tombstoneMap.values()).sort((a, b) => a.derivationName.localeCompare(b.derivationName));

  // Monotonic OR — an activation on any device wins; absence never deactivates.
  const naturalPersonActive = localNaturalPersonActive || remote.naturalPersonActive === true;
  const npActiveChanged = naturalPersonActive !== localNaturalPersonActive;

  // Adopt the remote real-identity name into an EMPTY local one only. That is
  // the whole rule — no LWW, no tie-break: an empty local name is the only
  // state that can be improved, and a non-empty one is never overwritten by
  // the wire, so two named devices converge on their own names and neither
  // republishes over the other.
  const naturalPersonDisplayName =
    remote.naturalPersonActive === true
    && !!remote.naturalPersonDisplayName
    && localNaturalPersonDisplayName.trim() === ''
      ? remote.naturalPersonDisplayName
      : undefined;

  const changed =
    stableStringify(extraPersonas) !== stableStringify(local) ||
    stableStringify(sortedTombstones(tombstones)) !== stableStringify(sortedTombstones(localTombstones)) ||
    npActiveChanged ||
    naturalPersonDisplayName !== undefined;

  return {
    extraPersonas,
    tombstones,
    changed,
    skipped,
    naturalPersonActive,
    ...(naturalPersonDisplayName !== undefined ? { naturalPersonDisplayName } : {}),
  };
}

function sortedTombstones(list: ExtraPersonaTombstone[]): ExtraPersonaTombstone[] {
  return [...list].sort((a, b) => a.derivationName.localeCompare(b.derivationName));
}

/**
 * Deep-equality helper that's insensitive to object key insertion order AND
 * to explicit-`undefined`-valued keys (matches `JSON.stringify` semantics,
 * which is how these objects actually get persisted) — otherwise the
 * explicit `undefined` a profile-field "clear" writes (see the winner
 * resolution above) would make an object compare as different from an
 * equivalent one that simply never had that key.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Is `merged` carrying anything the relay's `remote` record does not hold?
 *
 * The question the post-fetch reseed actually needs to answer is NOT "are
 * these two records identical" — a plain inequality also fires when the
 * remote holds something THIS device cannot represent (a `professional`
 * block on a device with no Pro slot, a persona reported in
 * `MergeResult.skipped`), and publishing then would overwrite the richer
 * remote record with a poorer one, and flap once per app start.
 *
 * So: only things `merged` has and `remote` lacks (or differs on) count.
 *   - a persona (by derivationName) absent from remote, or differing in any
 *     field — compared via `stableStringify` of the wire entry, so the
 *     profile-field semantics match the merge exactly;
 *   - a tombstone absent from remote, or with a NEWER `removedAt`;
 *   - a `professional` block remote lacks, or that differs.
 * Anything remote has and merged lacks does NOT count. Ordering doesn't
 * count either (the caller decides whether local order won — see
 * `usePersonasSync`), so this stays a pure content comparison.
 */
export function isWireRicherThan(merged: SyncedPersonasPayload, remote: SyncedPersonasPayload): boolean {
  const remotePersonas = new Map(remote.personas.map((p) => [p.derivationName, p] as const));
  for (const p of merged.personas) {
    const r = remotePersonas.get(p.derivationName);
    if (!r) return true;
    if (stableStringify(p) !== stableStringify(r)) return true;
  }

  const remoteTombstones = new Map(remote.tombstones.map((t) => [t.derivationName, t] as const));
  for (const t of merged.tombstones) {
    const r = remoteTombstones.get(t.derivationName);
    if (!r) return true;
    if (t.removedAt > r.removedAt) return true;
  }

  if (merged.professional) {
    if (!remote.professional) return true;
    if (stableStringify(merged.professional) !== stableStringify(remote.professional)) return true;
  }

  // We hold an activation the relay's record does not. Republish so the other
  // device's next fetch picks it up; the reverse (relay richer) must NOT count,
  // same rule as the professional block above.
  if (merged.naturalPersonActive && !remote.naturalPersonActive) return true;

  // We hold the real-identity name and the relay's record does not. The reverse
  // must NOT count (same rule as the professional block): republishing a record
  // poorer in the name would strip it from the device that has it, and two
  // devices with DIFFERENT names never reach here at all — the merge keeps each
  // device's own name, so neither sees the other as missing one.
  if (merged.naturalPersonDisplayName && !remote.naturalPersonDisplayName) return true;

  return false;
}

/**
 * Publish the owner's extra personas to every relay in `relayUrls`,
 * encrypted to self. Returns true if at least one relay accepted it.
 */
export async function publishPersonasSync(
  identity: SignetIdentity,
  backend: DecryptingSigningBackend,
  relayUrls: string[],
): Promise<boolean> {
  const targets = relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return false;

  const payload = toWire(identity);
  // Never publish an information-free record. An empty record carries no
  // information and can only destroy a real one — and "empty" is reachable
  // without any user intent: a pool where one relay is down and another is
  // simply empty returns `null` ("nothing found"), not `'unreachable'`, so
  // the rail would happily overwrite a live backup with nothing. A user
  // with genuinely zero personas loses nothing by not publishing.
  if (
    payload.personas.length === 0
    && payload.tombstones.length === 0
    && !payload.professional
    && !payload.naturalPersonActive
  ) return false;
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
  try {
    // A connected-but-declining bunker (or a dropped NIP-46 round-trip)
    // REJECTS `signEvent` rather than resolving it. Everything else on this
    // rail reports a refusal as `false`, so an unguarded rejection here was
    // the one path that escaped into the caller's hook effect as an unhandled
    // promise — the global constraint is that nothing throws out of a publish.
    // `publishToRelays` never throws (`Promise.allSettled` internally), so
    // folding it into the same try adds no new risk. Mirrors
    // `contacts-v2-sync.ts`'s own `publishContent`.
    const signed = await backend.signEvent(event);
    return await publishToRelays(signed, targets);
  } catch {
    return false;
  }
}

/**
 * Fetch the latest synced personas payload for `authorPubkey` across every
 * relay in `relayUrls`. Each relay is queried independently (per-relay
 * try/catch); unreachable relays don't count toward `reachableRelays`.
 * Events are deduped by id across relays and the newest `created_at` wins.
 *
 * Returns `'unreachable'` when no relay in `relayUrls` was even queryable
 * (every URL invalid, or every relay unreachable). Returns `null` for a
 * malformed `authorPubkey`, or when at least one relay answered but no
 * event was found (or the found event failed to decrypt/parse, or wasn't
 * newer than `sinceCreatedAt`). Otherwise the resolved payload.
 */
export async function fetchPersonasSync(
  authorPubkey: string,
  backend: DecryptingSigningBackend,
  relayUrls: string[],
  sinceCreatedAt?: number,
  cache?: SyncDecryptCache,
): Promise<{ payload: SyncedPersonasPayload; createdAt: number; eventId: string; reachableRelays: number } | null | 'unreachable'> {
  const targets = relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return 'unreachable';
  // A malformed author is a caller bug, not a relay-reachability fact —
  // return null (nothing found), not 'unreachable'.
  if (!HEX64.test(authorPubkey)) return null;

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
    return { payload: parsed, createdAt: latest.created_at, eventId: latest.id, reachableRelays };
  } catch {
    // Decrypt failure (wrong key, corrupted ciphertext, backend error) —
    // degrade to "nothing usable found", same posture as a parse failure.
    return null;
  }
}

/**
 * Randomised publish-delay window (jitter): [6000, 91000) ms. Spreads
 * multi-device publishes so two devices editing near-simultaneously don't
 * race to publish at the same instant. `random` is injectable for tests.
 */
export function computePublishDelayMs(random: () => number = Math.random): number {
  return 1000 + Math.floor(random() * 85000) + 5000;
}
