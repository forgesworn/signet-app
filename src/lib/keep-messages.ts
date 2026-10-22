/**
 * K1d messages between My Signet and a Keep: build the rumors we send and read
 * the acks we get back. Pure apart from the signing backend we are handed; no
 * relay, no storage. See the K1d contract for the wire format.
 *
 * Sending reuses `giftWrap` (rumor -> kind 13 seal signed by the persona ->
 * kind 1059 wrap under a throwaway key). The `created_at` of the seal and of
 * the wrap are each backdated by a random time of up to two days (standard
 * NIP-59, so the relays cannot pair our wrap with the Keep's ack by time); the
 * rumor carries the real time, as the contract requires.
 *
 * Reading an ack follows the contract's receiver rules to the letter: the seal
 * must verify and be signed by a Keep key we know, the rumor's author must be
 * the seal's author, and its `keep` tag must name that same Keep. Anything else
 * (including other apps' gift wraps addressed to the same persona) is dropped
 * without a trace.
 */
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { giftWrap } from './relay-publish';
import { sanitizeDisplayName } from './text-sanitize';
import type { DecryptingSigningBackend } from './signing-backend';
import {
  KEEP_ACK_STATUSES, KEEP_INVITE_LABEL_MAX, KEEP_MAX_OWNER_PERSONAS, KEEP_MSG_ACCEPT_KIND, KEEP_MSG_ACK_KIND,
  KEEP_MSG_CLAIM_KIND, KEEP_MSG_INVITE_KIND, KEEP_MSG_OWNERS_KIND, KEEP_MSG_REVOKE_KIND, KEEP_REFUSAL_REASONS,
  KEEP_SCOPES, KEEP_WRAP_JITTER_S,
} from './keep-wire';

export type AckStatus = typeof KEEP_ACK_STATUSES[number];
export type RefusalReason = typeof KEEP_REFUSAL_REASONS[number];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

export interface InviteSpec {
  keep: string;
  /** 32 hex, made here. */
  grant: string;
  /** 64 hex, made here. */
  secret: string;
  /** Unix seconds. */
  expiration: number;
  /** A personal invite names the persona it is bound to; a guest pass does not. */
  persona?: string;
  guest?: boolean;
  label?: string;
}

function rumorTemplate(backend: DecryptingSigningBackend, kind: number, tags: string[][], now: number): UnsignedEvent {
  return { kind, pubkey: backend.activePublicKeyHex, created_at: now, tags, content: '' };
}

/** `scope` (K1e) says whether the Keep is for all of the owner's personas or one; left out, the Keep reads `one`. */
export function claimRumor(
  backend: DecryptingSigningBackend, keep: string, code: string, now: number, scope?: typeof KEEP_SCOPES[number],
): UnsignedEvent {
  return rumorTemplate(backend, KEEP_MSG_CLAIM_KIND, [['keep', keep], ['code', code], ...(scope ? [['scope', scope]] : [])], now);
}

export interface OwnerPersonaSpec {
  persona: string;
  /** Section names switched on for the persona (`games`). */
  sections: readonly string[];
}

const SECTION_NAME = /^[a-z0-9_-]{1,32}$/;

/** An owners update (K1e): the revision and one `persona` tag per owner persona, 1 to 16, no duplicates. */
export function ownersUpdateRumor(
  backend: DecryptingSigningBackend, keep: string, rev: number, personas: readonly OwnerPersonaSpec[], now: number,
): UnsignedEvent {
  if (!HEX64.test(keep) || !Number.isSafeInteger(rev) || rev < 1) throw new Error('Invalid update');
  if (personas.length < 1 || personas.length > KEEP_MAX_OWNER_PERSONAS) throw new Error('Invalid update');
  if (new Set(personas.map(p => p.persona)).size !== personas.length) throw new Error('Invalid update');
  const tags: string[][] = [['keep', keep], ['rev', String(rev)]];
  for (const p of personas) {
    if (!HEX64.test(p.persona) || !p.sections.every(x => SECTION_NAME.test(x))) throw new Error('Invalid update');
    tags.push(['persona', p.persona, ...p.sections]);
  }
  return rumorTemplate(backend, KEEP_MSG_OWNERS_KIND, tags, now);
}

/** "I agree to be an owner persona of this Keep, as listed in update `rev`" (K1e), signed by the persona being added. */
export function ownerAcceptRumor(backend: DecryptingSigningBackend, keep: string, rev: number, now: number): UnsignedEvent {
  if (!HEX64.test(keep) || !Number.isSafeInteger(rev) || rev < 1) throw new Error('Invalid accept');
  return rumorTemplate(backend, KEEP_MSG_ACCEPT_KIND, [['keep', keep], ['rev', String(rev)]], now);
}

/** Exactly one of `persona` / `guest`; `label` loses control and bidi characters and is cut to the contract's 40. */
export function inviteRumor(backend: DecryptingSigningBackend, spec: InviteSpec, now: number): UnsignedEvent {
  if (!HEX64.test(spec.keep) || !HEX32.test(spec.grant) || !HEX64.test(spec.secret)) throw new Error('Invalid invite');
  if (!Number.isSafeInteger(spec.expiration) || spec.expiration <= 0) throw new Error('Invalid invite');
  if (!!spec.persona === !!spec.guest) throw new Error('An invite is personal or a guest pass');
  if (spec.persona && !HEX64.test(spec.persona)) throw new Error('Invalid invite');
  const tags: string[][] = [
    ['keep', spec.keep], ['grant', spec.grant], ['secret', spec.secret],
    ['expiration', String(spec.expiration)],
    spec.persona ? ['p', spec.persona] : ['guest'],
  ];
  const label = sanitizeDisplayName(spec.label ?? '', KEEP_INVITE_LABEL_MAX);
  if (label) tags.push(['name', label]);
  return rumorTemplate(backend, KEEP_MSG_INVITE_KIND, tags, now);
}

export function revokeRumor(backend: DecryptingSigningBackend, keep: string, grant: string, now: number): UnsignedEvent {
  if (!HEX64.test(keep) || !HEX32.test(grant)) throw new Error('Invalid revoke');
  return rumorTemplate(backend, KEEP_MSG_REVOKE_KIND, [['keep', keep], ['grant', grant]], now);
}

/** Wrap one rumor to the Keep; the wrap goes to the Keep's relays. */
export function wrapForKeep(rumor: UnsignedEvent, keep: string, backend: DecryptingSigningBackend): Promise<NostrEvent> {
  return giftWrap(rumor, keep, backend, { maxJitterS: KEEP_WRAP_JITTER_S });
}

export interface KeepAck {
  keep: string;
  status: AckStatus;
  /** Present for invite / revoke acks. */
  grant?: string;
  /** True for the ack of a claim. */
  claim: boolean;
  reason?: RefusalReason;
  /** The rumor's real time. */
  at: number;
  /**
   * True for the ack of an owners update or an owner accept (K1e): `updated`, `pending`, or
   * a refusal that names neither a grant nor a claim. It is sent to the persona that signed
   * the message it answers, which is `to`.
   */
  owners?: boolean;
  /** The Keep's revision (K1e): the new one on `updated`, the current one on `pending` and `refused stale`. */
  rev?: number;
  /** The persona the wrap was addressed to (set when opened, on owners acks). */
  to?: string;
}

function single(tags: string[][], name: string): string[] | null {
  const found = tags.filter(t => Array.isArray(t) && t[0] === name);
  return found.length === 1 ? found[0] : null;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** The fields of an ack rumor that passed the Keep checks; null when it is not a well-formed ack for `keep`. */
export function parseAckRumor(rumor: { kind: number; tags: string[][]; created_at: number }, keep: string): KeepAck | null {
  if (rumor.kind !== KEEP_MSG_ACK_KIND || !Array.isArray(rumor.tags)) return null;
  const tags = rumor.tags.filter(t => Array.isArray(t) && t.every(x => typeof x === 'string'));
  const keepTag = single(tags, 'keep');
  if (!keepTag || keepTag[1] !== keep) return null;
  const statusTag = single(tags, 'status');
  const status = statusTag?.[1] as AckStatus | undefined;
  if (!status || !(KEEP_ACK_STATUSES as readonly string[]).includes(status)) return null;
  const grantTag = single(tags, 'grant');
  const claimTag = single(tags, 'claim');
  const grant = grantTag?.[1];
  // K1e: the acks of an owners update / owner accept carry a revision and no grant or claim.
  const revText = single(tags, 'rev')?.[1];
  const rev = revText !== undefined && /^(0|[1-9]\d{0,15})$/.test(revText) ? Number(revText) : undefined;
  if (!Number.isSafeInteger(rumor.created_at)) return null;
  if (status === 'updated' || status === 'pending') {
    if (rev === undefined || claimTag) return null;
    return { keep, status, claim: false, owners: true, rev, at: rumor.created_at };
  }
  if (status === 'refused' && !grantTag && !claimTag) {
    const r = single(tags, 'reason')?.[1];
    if (!r || !(KEEP_REFUSAL_REASONS as readonly string[]).includes(r)) return null;
    if (r === 'stale' && rev === undefined) return null;
    return { keep, status, claim: false, owners: true, reason: r as RefusalReason, at: rumor.created_at, ...(rev !== undefined ? { rev } : {}) };
  }
  if (status === 'paired') {
    if (!claimTag) return null;
  } else {
    if (claimTag && !grantTag) return null; // a refused claim carries no grant: nothing for us to apply
    if (!grant || !HEX32.test(grant)) return null;
  }
  let reason: RefusalReason | undefined;
  if (status === 'refused') {
    const r = single(tags, 'reason')?.[1];
    if (!r || !(KEEP_REFUSAL_REASONS as readonly string[]).includes(r)) return null;
    reason = r as RefusalReason;
  }
  return {
    keep, status, claim: status === 'paired', at: rumor.created_at,
    ...(status === 'paired' ? {} : { grant }),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Open a gift wrap addressed to `backend`'s persona and return the ack inside,
 * if it is a valid one from one of `keeps`. Never throws.
 */
export async function unwrapKeepAck(
  wrap: NostrEvent,
  backend: DecryptingSigningBackend,
  keeps: ReadonlySet<string>,
): Promise<KeepAck | null> {
  try {
    if (wrap.kind !== 1059 || typeof wrap.content !== 'string' || wrap.content.length > 65_535) return null;
    const sealJson = parseJson(await backend.nip44Decrypt(wrap.pubkey, wrap.content));
    if (!sealJson) return null;
    const seal = sealJson as unknown as NostrEvent;
    if (seal.kind !== 13 || typeof seal.pubkey !== 'string' || !keeps.has(seal.pubkey)) return null;
    if (!verifyEvent({ id: seal.id, pubkey: seal.pubkey, kind: seal.kind, created_at: seal.created_at, tags: seal.tags, content: seal.content, sig: seal.sig })) return null;
    const rumorJson = parseJson(await backend.nip44Decrypt(seal.pubkey, seal.content));
    if (!rumorJson) return null;
    const rumor = rumorJson as unknown as NostrEvent;
    if (rumor.pubkey !== seal.pubkey) return null;
    if (typeof rumor.id === 'string' && rumor.id !== getEventHash({ ...rumor, tags: rumor.tags } as Parameters<typeof getEventHash>[0])) return null;
    const ack = parseAckRumor(rumor, seal.pubkey);
    return ack && ack.owners ? { ...ack, to: backend.activePublicKeyHex } : ack;
  } catch {
    return null;
  }
}
