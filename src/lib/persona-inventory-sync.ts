/**
 * Per-dependant persona-inventory sync rail
 * (2026-05-15-persona-inventory-sync-to-paired-child-design.md).
 *
 * Guardian publishes a NIP-44-encrypted kind-30078 replaceable event
 * carrying the dependant's persona inventory (built-in NP, optional
 * built-in persona, extra personas) so the paired-child device can
 * render the full carousel rather than only the NP stub seeded at pair
 * time. Signer is the guardian's per-dependant endpoint keypair
 * — the same cryptographic identity the child already trusts for every
 * NIP-46 envelope. Recipient is the child's transport pubkey (bound at
 * pair time).
 *
 * **Distinct d-tag** from `signet:dependant-status` so the two
 * payloads don't collide on the same replaceable-event slot.
 *
 * **Privacy invariant.** The payload carries persona pubkeys and
 * display names only — same profile as a Nostr kind-0. Private keys
 * NEVER appear in the payload; the child never holds signing material,
 * every sign request round-trips to the guardian bunker over NIP-46.
 *
 * **Forward compatibility.** Payload version `v: 1`; anything else is
 * ignored.
 */

import type { UnsignedEvent } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';
import { safeImageOrLinkUrl } from './public-profile-publish';
import { isValidRelayUrl } from './relay-url';

const INVENTORY_D_TAG = 'signet:persona-inventory';
const INVENTORY_KIND = 30078;
const SCHEMA_V = 1;

const HEX64 = /^[0-9a-f]{64}$/i;
const NIP05_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

// Field caps — mirror public-profile-publish.ts §3.4 / Appendix A. Inlined
// here because the design treats the inventory rail as the wire-level
// authority for the dep→kid hop and validation must NOT differ from the
// kid-side kind-0 parser. If caps drift, kid can render content the kid
// can't ever publish (or vice versa).
const CAP_NAME = 50;
const CAP_DISPLAY_NAME_PROFILE = 100;
const CAP_ABOUT = 500;
const CAP_PICTURE_URL = 500;
const CAP_BANNER_URL = 500;
const CAP_NIP05 = 100;
const CAP_LUD16 = 100;
const CAP_WEBSITE = 300;

/** Strip control / bidi characters and cap at 100 chars. */
function sanitiseDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').slice(0, 100);
}

/**
 * Convert a guardian-side persona slot's public-profile **config** to the
 * inventory wire block (`PersonaInventoryPublicProfileBlock`). The `enabled`
 * flag is sourced from the slot's `publicProfile` state (`PersonaPublicProfile`),
 * not from the config — per Phase 1's persona-card-as-source-of-truth split,
 * config (display fields) and state (enabled, lastEventId, …) live on
 * separate top-level slot fields.
 *
 * Returns `undefined` when both `config` is absent AND `enabled` is false —
 * i.e. there's nothing to put on the wire and no policy to propagate. State
 * fields (`lastEventId`, `lastPublishedAt`, `lastPublishedRelay`) are NEVER
 * carried — §5.4 one-way data-flow contract, the kid owns those.
 *
 * Wire-format note: the legacy `name?: string` key is retained on
 * `PersonaInventoryPublicProfileBlock` so kid devices on older code keep
 * parsing inbound payloads, but the new publisher no longer populates it.
 * Display name now flows via the kind-0 publisher's single-source-of-truth
 * `displayName` rule (T2-T3) — `name` is dead in the new direction.
 */
export function publicProfileToInventoryBlock(
  config: import('../types').PublicProfileConfig | undefined,
  enabled: boolean,
): PersonaInventoryPublicProfileBlock | undefined {
  if (!config && !enabled) return undefined;
  const out: PersonaInventoryPublicProfileBlock = { enabled };
  if (config?.displayName) out.displayName = config.displayName;
  if (config?.about) out.about = config.about;
  if (config?.pictureUrl) out.pictureUrl = config.pictureUrl;
  if (config?.pictureBlossomHash) out.pictureBlossomHash = config.pictureBlossomHash;
  if (config?.bannerUrl) out.bannerUrl = config.bannerUrl;
  if (config?.bannerBlossomHash) out.bannerBlossomHash = config.bannerBlossomHash;
  if (config?.nip05) out.nip05 = config.nip05;
  if (config?.lud16) out.lud16 = config.lud16;
  if (config?.website) out.website = config.website;
  return out;
}

/**
 * Public Nostr profile (kind-0) block carried on the inventory wire — config
 * fields ONLY. The kid owns the publication-state fields (`lastEventId`,
 * `lastPublishedAt`, `lastPublishedRelay`) per §5.1.3 atomicity contract;
 * the guardian writes only the configuration ("this profile should be
 * published with these fields") and the kid fills in the state once it
 * actually publishes. See §5.4 of the public-profile design doc for the
 * full sequence.
 *
 * State fields are intentionally absent from this interface so a future
 * encoder can't smuggle them onto the wire by spreading a full
 * `PersonaPublicProfile` — the type system forbids it.
 */
export interface PersonaInventoryPublicProfileBlock {
  enabled: boolean;
  name?: string;
  displayName?: string;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
}

export interface PersonaInventoryEntry {
  publicKey: string;
  displayName: string;
  /**
   * Optional per-persona avatar. Carries the Blossom blob coordinates and
   * the decryption key so the paired-child surface can render the same
   * picture the guardian sees. NIP-44 already encrypts the whole inventory
   * payload to the kid's transport pubkey, so `avatarKey` traverses the
   * relay encrypted — no new secret-on-relay primitive needed.
   *
   * All four fields move together; absence is "no avatar set on this
   * slot". Added 2026-05-16 as Phase 2 of the per-persona-avatars feature.
   */
  avatarHash?: string;
  avatarBlossomUrl?: string;
  avatarKey?: string;
  avatarUpdatedAt?: number;
  /**
   * Optional public Nostr profile (kind-0) policy block. Config fields only.
   * See `PersonaInventoryPublicProfileBlock` for the no-state-fields rationale.
   */
  publicProfile?: PersonaInventoryPublicProfileBlock;
}

export interface PersonaInventoryPayload {
  v: 1;
  revision: number;
  /**
   * The dependant's real-name slot. ABSENT while that slot is dormant
   * (spec §7.6) — the guardian must not hand the paired child, or the relay,
   * a pubkey the child is not meant to use. A receiver treats absence as
   * "this dependant has no active real identity", never as "unchanged".
   *
   * **Version skew.** A child device still running the parser from before
   * this field went optional hard-rejects any payload that omits
   * `naturalPerson` — the whole inventory event reads as malformed and the
   * child's carousel simply goes stale (not corrupt) until it re-syncs.
   * Blast radius is narrow: only a persona-first dependant (creatable only
   * on this build or later) ever publishes without `naturalPerson`, so this
   * only bites a child paired on an older build after the guardian upgraded.
   * Accepted for now, on the assumption the APK update check (see
   * `src/lib/app-update.ts`) brings that child current before it matters;
   * revisit if adoption data says otherwise.
   */
  naturalPerson?: PersonaInventoryEntry;
  persona?: PersonaInventoryEntry;
  extraPersonas: PersonaInventoryEntry[];
}

export interface PersonaInventoryParams {
  /**
   * The child device's NIP-46 transport pubkey. Payload is NIP-44-
   * encrypted to this key. Must be 64-char hex.
   */
  childTransportPubkey: string;
  /**
   * The dependant's real-name slot. Omit while it is dormant (spec §7.6) —
   * the caller must not hand the child a pubkey it is not meant to use.
   */
  naturalPerson?: PersonaInventoryEntry;
  /** Omit when the guardian has hidden the built-in persona. */
  persona?: PersonaInventoryEntry;
  /** Already-filtered list — only entries that should appear on the child. */
  extraPersonas: PersonaInventoryEntry[];
  /** Unix seconds — guardian-side timestamp; monotonically increases. */
  revision: number;
}

/**
 * Publish a persona-inventory record. Signer is the guardian's per-
 * dependant endpoint backend; it encrypts to the child's transport
 * pubkey using the (endpoint-privkey, child-transport-pubkey) NIP-44
 * pair.
 *
 * Returns true on relay acceptance. False results are not fatal — the
 * event is replaceable, so the next publish overwrites.
 */
export async function publishPersonaInventory(
  params: PersonaInventoryParams,
  endpointBackend: DecryptingSigningBackend,
  relayUrl: string,
): Promise<boolean> {
  if (!isValidRelayUrl(relayUrl)) return false;
  if (!HEX64.test(params.childTransportPubkey)) return false;
  if (params.naturalPerson && !HEX64.test(params.naturalPerson.publicKey)) return false;
  const personaOk = !!params.persona && HEX64.test(params.persona.publicKey);
  // A payload with neither a real identity nor a persona names nobody —
  // there's no slot the child could render.
  if (!params.naturalPerson && !personaOk) return false;
  if (typeof params.revision !== 'number' || params.revision <= 0) return false;

  // Carry avatar fields through verbatim when present + well-formed. The
  // encoder builds payload entries explicitly (rather than spreading the
  // input) so we don't accidentally smuggle arbitrary keys onto the wire —
  // any future field has to be added here on purpose.
  const payload: PersonaInventoryPayload = {
    v: SCHEMA_V,
    revision: params.revision,
    extraPersonas: params.extraPersonas.map(ep => ({
      publicKey: ep.publicKey.toLowerCase(),
      displayName: ep.displayName,
      ...avatarFieldsFor(ep),
      ...publicProfileFieldsFor(ep),
    })),
  };
  if (params.naturalPerson) {
    payload.naturalPerson = {
      publicKey: params.naturalPerson.publicKey.toLowerCase(),
      displayName: params.naturalPerson.displayName,
      ...avatarFieldsFor(params.naturalPerson),
      ...publicProfileFieldsFor(params.naturalPerson),
    };
  }
  if (params.persona && personaOk) {
    payload.persona = {
      publicKey: params.persona.publicKey.toLowerCase(),
      displayName: params.persona.displayName,
      ...avatarFieldsFor(params.persona),
      ...publicProfileFieldsFor(params.persona),
    };
  }

  const ciphertext = await endpointBackend.nip44Encrypt(
    params.childTransportPubkey,
    JSON.stringify(payload),
  );

  const event: UnsignedEvent = {
    kind: INVENTORY_KIND,
    pubkey: endpointBackend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', INVENTORY_D_TAG],
      ['p', params.childTransportPubkey.toLowerCase()],
    ],
    content: ciphertext,
  };
  const signed = await endpointBackend.signEvent(event);

  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const result = await relay.publish(signed);
    return result.ok;
  } catch {
    return false;
  } finally {
    relay.disconnect();
  }
}

/**
 * Build the avatar wire fields from a guardian-side persona slot. Returns
 * an empty object when no avatar is set (all four wire fields move
 * together). Same all-or-nothing semantics as `readOptionalAvatar` on the
 * subscriber side, so a partial guardian record never produces a partial
 * wire payload.
 */
function avatarFieldsFor(
  slot: Partial<Pick<PersonaInventoryEntry, 'avatarHash' | 'avatarBlossomUrl' | 'avatarKey' | 'avatarUpdatedAt'>>,
): Partial<Pick<PersonaInventoryEntry, 'avatarHash' | 'avatarBlossomUrl' | 'avatarKey' | 'avatarUpdatedAt'>> {
  const { avatarHash, avatarBlossomUrl, avatarKey, avatarUpdatedAt } = slot;
  if (!avatarHash || !avatarBlossomUrl || !avatarKey) return {};
  if (!HEX64.test(avatarHash) || !HEX64.test(avatarKey)) return {};
  return {
    avatarHash: avatarHash.toLowerCase(),
    avatarBlossomUrl,
    avatarKey: avatarKey.toLowerCase(),
    avatarUpdatedAt,
  };
}

/**
 * Subscribe to inventory events addressed TO the child. Stays open and
 * processes events as they arrive — both the initial set on the relay
 * AND any new publishes that land after subscription.
 *
 * An earlier one-shot fetch raced the guardian's 1-second publish
 * debounce: the kid would unlock and fetch ~200-700ms after bind,
 * while the guardian's first publish for the freshly-bound dep
 * landed ~1000-1500ms after bind. With no retry path, the kid stayed
 * stuck on the pair-time NP-only stub forever. Subscribing stays
 * resident across that window and across any future inventory edits
 * (rename, add, hide) so the carousel stays current without
 * lock/unlock cycles.
 *
 * Returns an `unsubscribe` function that tears down the subscription
 * and closes the relay connection. Caller MUST call it on
 * unmount / dep change to avoid leaking a websocket.
 */
export function subscribePersonaInventory(
  endpointPubkey: string,
  childTransportBackend: DecryptingSigningBackend,
  relayUrl: string,
  onPayload: (result: { payload: PersonaInventoryPayload; createdAt: number }) => void,
): () => void {
  if (!isValidRelayUrl(relayUrl)) return () => { /* no-op */ };
  if (!HEX64.test(endpointPubkey)) return () => { /* no-op */ };

  const relay = new RelayClient(relayUrl);
  let cancelled = false;
  let subId: string | null = null;

  void (async () => {
    try {
      await relay.connect();
      if (cancelled) {
        relay.disconnect();
        return;
      }
      subId = relay.subscribe(
        [{
          kinds: [INVENTORY_KIND],
          authors: [endpointPubkey.toLowerCase()],
          '#d': [INVENTORY_D_TAG],
        } as never],
        async (event) => {
          if (cancelled) return;
          try {
            const plaintext = await childTransportBackend.nip44Decrypt(
              endpointPubkey.toLowerCase(),
              event.content,
            );
            const payload = parsePersonaInventoryPayload(plaintext);
            if (!payload) return;
            onPayload({ payload, createdAt: event.created_at });
          } catch {
            // Decrypt or parse failure — drop this event silently. Next
            // publish from the guardian will deliver a fresh attempt.
          }
        },
      );
    } catch {
      // Connection failure — caller sees no events. RelayClient's
      // auto-reconnect (default on) will re-establish in the background;
      // when it does, the relay re-sends the latest event for our
      // subscription's filter, so we recover without explicit re-subscribe.
    }
  })();

  return () => {
    cancelled = true;
    if (subId) {
      try { relay.closeSubscription(subId); } catch { /* ignore */ }
    }
    relay.disconnect();
  };
}

/**
 * Parse + shape-check a decrypted payload. Returns null on any
 * malformation. Strips control / bidi characters from display names
 * and caps them at 100 chars.
 */
export function parsePersonaInventoryPayload(raw: string): PersonaInventoryPayload | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v !== SCHEMA_V) return null;
  if (typeof p.revision !== 'number' || p.revision <= 0) return null;

  let naturalPerson: PersonaInventoryEntry | undefined;
  if (p.naturalPerson !== undefined) {
    // Present-but-malformed is still a hard reject: silently dropping it
    // would read to the child as "the guardian deactivated the real
    // identity", which is a very different claim from "malformed data".
    if (typeof p.naturalPerson !== 'object' || p.naturalPerson === null) return null;
    const npRec = p.naturalPerson as Record<string, unknown>;
    if (typeof npRec.publicKey !== 'string' || !HEX64.test(npRec.publicKey)) return null;
    if (typeof npRec.displayName !== 'string') return null;
    naturalPerson = {
      publicKey: npRec.publicKey.toLowerCase(),
      displayName: sanitiseDisplayName(npRec.displayName),
      ...readOptionalAvatar(npRec),
      ...readOptionalPublicProfile(npRec),
    };
  }

  if (!Array.isArray(p.extraPersonas)) return null;
  const extraPersonas: PersonaInventoryEntry[] = [];
  for (const entry of p.extraPersonas) {
    if (typeof entry !== 'object' || entry === null) return null;
    const er = entry as Record<string, unknown>;
    if (typeof er.publicKey !== 'string' || !HEX64.test(er.publicKey)) return null;
    if (typeof er.displayName !== 'string') return null;
    extraPersonas.push({
      publicKey: er.publicKey.toLowerCase(),
      displayName: sanitiseDisplayName(er.displayName),
      ...readOptionalAvatar(er),
      ...readOptionalPublicProfile(er),
    });
  }

  const out: PersonaInventoryPayload = {
    v: SCHEMA_V,
    revision: p.revision,
    extraPersonas,
  };
  if (naturalPerson) out.naturalPerson = naturalPerson;

  if (p.persona !== undefined) {
    if (typeof p.persona !== 'object' || p.persona === null) return null;
    const per = p.persona as Record<string, unknown>;
    if (typeof per.publicKey !== 'string' || !HEX64.test(per.publicKey)) return null;
    if (typeof per.displayName !== 'string') return null;
    out.persona = {
      publicKey: per.publicKey.toLowerCase(),
      displayName: sanitiseDisplayName(per.displayName),
      ...readOptionalAvatar(per),
      ...readOptionalPublicProfile(per),
    };
  }

  // A payload with neither identity slot names nobody — reject rather than
  // hand the child a record that would wipe both of its slots.
  if (!out.naturalPerson && !out.persona) return null;

  return out;
}

/**
 * Extract avatar fields from a raw inbound persona entry record, defensively
 * coerced. All-or-nothing — if `avatarHash` or `avatarKey` is malformed we
 * drop the avatar entirely rather than carry partial state through. This
 * keeps `parsePersonaInventoryPayload` strict (returns null on real schema
 * violations only — avatar shape problems are tolerated as "no avatar set").
 *
 * Hash + key must both be valid 64-char hex; URL must be a non-empty string
 * (Blossom URL validation happens at fetch time, not parse time).
 */
function readOptionalAvatar(rec: Record<string, unknown>): Partial<Pick<PersonaInventoryEntry, 'avatarHash' | 'avatarBlossomUrl' | 'avatarKey' | 'avatarUpdatedAt'>> {
  const hash = rec.avatarHash;
  const url = rec.avatarBlossomUrl;
  const keyHex = rec.avatarKey;
  const updatedAt = rec.avatarUpdatedAt;
  if (typeof hash !== 'string' || !HEX64.test(hash)) return {};
  if (typeof url !== 'string' || url.length === 0) return {};
  if (typeof keyHex !== 'string' || !HEX64.test(keyHex)) return {};
  return {
    avatarHash: hash.toLowerCase(),
    avatarBlossomUrl: url,
    avatarKey: keyHex.toLowerCase(),
    avatarUpdatedAt: typeof updatedAt === 'number' && updatedAt > 0 ? updatedAt : undefined,
  };
}

/**
 * Build the publicProfile config-only block from a guardian-side persona slot
 * (whatever shape — works with the dep's NP/persona slot or an `ExtraPersona`,
 * both of which carry `publicProfile?: PersonaPublicProfile`).
 *
 * Returns an empty object when the slot has no `publicProfile`, OR when the
 * `enabled` flag is missing. State fields (`lastEventId`, `lastPublishedAt`,
 * `lastPublishedRelay`) are **never** copied onto the wire — per the §5.4
 * one-way data-flow contract, the kid owns those. The guardian transports
 * configuration intent; the kid owns publication state.
 *
 * Per-field validation matches `readOptionalPublicProfile` so the encoder
 * and parser cannot drift — a guardian who sets a `picture` that the parser
 * would reject won't smuggle it past the parser by encoding it themselves.
 */
function publicProfileFieldsFor(
  slot: { publicProfile?: PersonaInventoryPublicProfileBlock },
): { publicProfile?: PersonaInventoryPublicProfileBlock } {
  const p = slot.publicProfile;
  if (!p) return {};
  const out: PersonaInventoryPublicProfileBlock = { enabled: p.enabled };
  // Wire-format invariant: the new publisher does NOT populate the legacy
  // `name` key — display name flows through `displayName` only (kind-0
  // single-source-of-truth rule, T2-T3). The interface retains `name?: string`
  // so older kid devices' parsers don't fail on inbound payloads emitted by
  // a guardian on older code; we just stop emitting it from this direction.
  if (typeof p.displayName === 'string' && p.displayName.length > 0 && p.displayName.length <= CAP_DISPLAY_NAME_PROFILE) {
    out.displayName = p.displayName;
  }
  if (typeof p.about === 'string' && p.about.length > 0 && p.about.length <= CAP_ABOUT) {
    out.about = p.about;
  }
  if (typeof p.pictureUrl === 'string' && p.pictureUrl.length > 0 && p.pictureUrl.length <= CAP_PICTURE_URL && safeImageOrLinkUrl(p.pictureUrl)) {
    out.pictureUrl = p.pictureUrl;
    if (typeof p.pictureBlossomHash === 'string' && HEX64.test(p.pictureBlossomHash)) {
      out.pictureBlossomHash = p.pictureBlossomHash.toLowerCase();
    }
  }
  if (typeof p.bannerUrl === 'string' && p.bannerUrl.length > 0 && p.bannerUrl.length <= CAP_BANNER_URL && safeImageOrLinkUrl(p.bannerUrl)) {
    out.bannerUrl = p.bannerUrl;
    if (typeof p.bannerBlossomHash === 'string' && HEX64.test(p.bannerBlossomHash)) {
      out.bannerBlossomHash = p.bannerBlossomHash.toLowerCase();
    }
  }
  if (typeof p.nip05 === 'string' && p.nip05.length > 0 && p.nip05.length <= CAP_NIP05 && NIP05_RE.test(p.nip05)) {
    out.nip05 = p.nip05;
  }
  if (typeof p.lud16 === 'string' && p.lud16.length > 0 && p.lud16.length <= CAP_LUD16 && NIP05_RE.test(p.lud16)) {
    out.lud16 = p.lud16;
  }
  if (typeof p.website === 'string' && p.website.length > 0 && p.website.length <= CAP_WEBSITE && safeImageOrLinkUrl(p.website)) {
    out.website = p.website;
  }
  return { publicProfile: out };
}

/**
 * Parse + validate an inbound publicProfile block. Returns `{ publicProfile }`
 * when valid, `{}` otherwise. Strict on `enabled` (must be boolean) so a
 * malformed block doesn't accidentally clear/set the kid's policy. Per-field
 * validation drops individual fields silently — a bad `nip05` doesn't
 * invalidate the whole profile.
 */
function readOptionalPublicProfile(
  rec: Record<string, unknown>,
): { publicProfile?: PersonaInventoryPublicProfileBlock } {
  const raw = rec.publicProfile;
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return {};
  const out: PersonaInventoryPublicProfileBlock = { enabled: r.enabled };
  if (typeof r.name === 'string' && r.name.length > 0 && r.name.length <= CAP_NAME) {
    out.name = sanitiseDisplayName(r.name);
  }
  if (typeof r.displayName === 'string' && r.displayName.length > 0 && r.displayName.length <= CAP_DISPLAY_NAME_PROFILE) {
    out.displayName = sanitiseDisplayName(r.displayName);
  }
  if (typeof r.about === 'string' && r.about.length > 0 && r.about.length <= CAP_ABOUT) {
    out.about = sanitiseDisplayName(r.about).slice(0, CAP_ABOUT);
  }
  if (typeof r.pictureUrl === 'string' && r.pictureUrl.length > 0 && r.pictureUrl.length <= CAP_PICTURE_URL && safeImageOrLinkUrl(r.pictureUrl)) {
    out.pictureUrl = r.pictureUrl;
    if (typeof r.pictureBlossomHash === 'string' && HEX64.test(r.pictureBlossomHash)) {
      out.pictureBlossomHash = r.pictureBlossomHash.toLowerCase();
    }
  }
  if (typeof r.bannerUrl === 'string' && r.bannerUrl.length > 0 && r.bannerUrl.length <= CAP_BANNER_URL && safeImageOrLinkUrl(r.bannerUrl)) {
    out.bannerUrl = r.bannerUrl;
    if (typeof r.bannerBlossomHash === 'string' && HEX64.test(r.bannerBlossomHash)) {
      out.bannerBlossomHash = r.bannerBlossomHash.toLowerCase();
    }
  }
  if (typeof r.nip05 === 'string' && r.nip05.length > 0 && r.nip05.length <= CAP_NIP05 && NIP05_RE.test(r.nip05)) {
    out.nip05 = r.nip05;
  }
  if (typeof r.lud16 === 'string' && r.lud16.length > 0 && r.lud16.length <= CAP_LUD16 && NIP05_RE.test(r.lud16)) {
    out.lud16 = r.lud16;
  }
  if (typeof r.website === 'string' && r.website.length > 0 && r.website.length <= CAP_WEBSITE && safeImageOrLinkUrl(r.website)) {
    out.website = r.website;
  }
  return { publicProfile: out };
}
