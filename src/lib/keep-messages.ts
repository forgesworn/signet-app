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
  KEEP_ACK_STATUSES, KEEP_INVITE_LABEL_MAX, KEEP_MAX_OWNER_PERSONAS, KEEP_MAX_REV, KEEP_MSG_ACCEPT_KIND, KEEP_MSG_ACK_KIND,
  KEEP_MSG_CLAIM_KIND, KEEP_MSG_INVITE_KIND, KEEP_MSG_OWNERS_KIND, KEEP_MSG_PASSES_REQUEST_KIND, KEEP_MSG_PASS_REPORT_KIND,
  KEEP_MSG_REVOKE_KIND, KEEP_MSG_SETTINGS_KIND, KEEP_PASS_STATES, KEEP_PASS_VIAS, KEEP_REFUSAL_REASONS, KEEP_SCOPES,
  KEEP_SETTING_RETURN_PASSES, KEEP_WRAP_JITTER_S,
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
  if (!HEX64.test(keep) || !Number.isInteger(rev) || rev < 1 || rev > KEEP_MAX_REV) throw new Error('Invalid update');
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
  if (!HEX64.test(keep) || !Number.isInteger(rev) || rev < 1 || rev > KEEP_MAX_REV) throw new Error('Invalid accept');
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

/** Settings (K1f): the Keep's own revision counter for them, and the return-passes switch. */
export function settingsRumor(backend: DecryptingSigningBackend, keep: string, setrev: number, returnPasses: boolean, now: number): UnsignedEvent {
  if (!HEX64.test(keep) || !Number.isInteger(setrev) || setrev < 1 || setrev > KEEP_MAX_REV) throw new Error('Invalid settings');
  return rumorTemplate(backend, KEEP_MSG_SETTINGS_KIND, [
    ['keep', keep], ['setrev', String(setrev)], [KEEP_SETTING_RETURN_PASSES, returnPasses ? 'on' : 'off'],
  ], now);
}

/** "Send me a report for every pass that isn't expired" (K1f). */
export function passesRequestRumor(backend: DecryptingSigningBackend, keep: string, now: number): UnsignedEvent {
  if (!HEX64.test(keep)) throw new Error('Invalid request');
  return rumorTemplate(backend, KEEP_MSG_PASSES_REQUEST_KIND, [['keep', keep]], now);
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
  /** The persona the wrap was addressed to (set when opened, on owners and settings acks). */
  to?: string;
  /**
   * True for the ack of a settings message (K1f): `updated` (naming the setting) or `refused stale`. It
   * carries the Keep's `setrev` (the new one on `updated`, the current one on `refused stale`) and no `rev`.
   */
  settings?: boolean;
  setrev?: number;
}

export type PassState = typeof KEEP_PASS_STATES[number];
export type PassVia = typeof KEEP_PASS_VIAS[number];

/** A pass report (K1f) that passed the checks. It never holds a secret: the Keep does not send one and none is read. */
export interface KeepPassReport {
  keep: string;
  grant: string;
  /** The player persona the pass is bound to. */
  persona: string;
  state: PassState;
  /** Unix seconds. */
  expiration: number;
  /** When the player was last seen, unix seconds. */
  seen: number;
  via?: PassVia;
  /** The seat name, cleaned as invite labels are; absent when empty. */
  name?: string;
  /** The rumor's real time. */
  at: number;
}

/** What a gift wrap addressed to an owner persona held, once it passed the checks. */
export type KeepMessage = { kind: 'ack'; ack: KeepAck } | { kind: 'report'; report: KeepPassReport };

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

/** A decimal revision this app can store (and add one to), or undefined. */
function parseRev(text: string | undefined): number | undefined {
  const n = parseSafeDecimal(text);
  return n !== undefined && n < Number.MAX_SAFE_INTEGER ? n : undefined;
}

/**
 * A non-negative decimal that is a safe integer (at most 2^53 - 1), or undefined. Sixteen digits fit the
 * pattern but can be past 2^53, where a number is no longer exact and storing it would make the saved list
 * unreadable, so the value itself is checked and not only its shape.
 */
function parseSafeDecimal(text: string | undefined): number | undefined {
  if (text === undefined || !DECIMAL.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
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
  // A revision the next one cannot follow is not believed. The Keep stops at 2^53, but this app stores a revision as a
  // safe integer (at most 2^53 - 1), so the next one after an ack must still be one: an ack may say up to 2^53 - 2.
  const rev = parseRev(revText);
  if (!Number.isSafeInteger(rumor.created_at)) return null;
  // K1f: the ack of a settings message carries `setrev` (and, on `updated`, `setting`), never `rev`, grant or claim.
  const setrevTag = single(tags, 'setrev');
  if (setrevTag || tags.some(t => t[0] === 'setrev' || t[0] === 'setting')) {
    if (!setrevTag || revText !== undefined || grantTag || claimTag) return null;
    const setrev = parseRev(setrevTag[1]);
    if (setrev === undefined) return null;
    if (status === 'updated') {
      if (single(tags, 'setting')?.[1] !== KEEP_SETTING_RETURN_PASSES) return null;
      return { keep, status, claim: false, settings: true, setrev, at: rumor.created_at };
    }
    if (status === 'refused' && single(tags, 'reason')?.[1] === 'stale') {
      return { keep, status, claim: false, settings: true, reason: 'stale', setrev, at: rumor.created_at };
    }
    return null;
  }
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

/** A tag list of a pass report is short; one longer than this is not from a Keep that follows the contract. */
const MAX_REPORT_TAGS = 16;

const DECIMAL = /^(0|[1-9]\d{0,15})$/;

/**
 * The fields of a pass report rumor (K1f, kind 27667) that passed the checks; null otherwise. Strict: each
 * tag appears once; `grant` is 32 hex, `p` and `keep` 64 hex; `state` is one of the three; `expiration` and
 * `seen` are decimal seconds that are safe integers. A `via` this build does not know is left out (the Keep may add ways in later); a
 * `name` is cleaned like an invite label and left out when nothing is left. A report with a `secret` tag is
 * dropped whole: a pass secret is a bearer credential for the player and never belongs in this app.
 */
export function parsePassReportRumor(
  rumor: { kind: number; tags: string[][]; created_at: number; content?: string }, keep: string,
): KeepPassReport | null {
  if (rumor.kind !== KEEP_MSG_PASS_REPORT_KIND || !Array.isArray(rumor.tags) || rumor.tags.length > MAX_REPORT_TAGS) return null;
  if (rumor.content !== undefined && rumor.content !== '') return null;
  if (!rumor.tags.every(t => Array.isArray(t) && t.length >= 1 && t.every(x => typeof x === 'string'))) return null;
  if (rumor.tags.some(t => t[0].toLowerCase() === 'secret')) return null;
  if (!Number.isSafeInteger(rumor.created_at)) return null;
  const keepTag = single(rumor.tags, 'keep');
  if (!keepTag || keepTag[1] !== keep) return null;
  const grant = single(rumor.tags, 'grant')?.[1];
  const persona = single(rumor.tags, 'p')?.[1];
  const state = single(rumor.tags, 'state')?.[1];
  const expiration = single(rumor.tags, 'expiration')?.[1];
  const seen = single(rumor.tags, 'seen')?.[1];
  if (!grant || !HEX32.test(grant) || !persona || !HEX64.test(persona)) return null;
  if (!state || !(KEEP_PASS_STATES as readonly string[]).includes(state)) return null;
  const expirationAt = parseSafeDecimal(expiration);
  const seenAt = parseSafeDecimal(seen);
  if (expirationAt === undefined || seenAt === undefined) return null;
  const viaTags = rumor.tags.filter(t => t[0] === 'via');
  if (viaTags.length > 1 || rumor.tags.filter(t => t[0] === 'name').length > 1) return null;
  const via = viaTags[0]?.[1];
  const name = sanitizeDisplayName(rumor.tags.find(t => t[0] === 'name')?.[1] ?? '', KEEP_INVITE_LABEL_MAX);
  return {
    keep, grant, persona, state: state as PassState, expiration: expirationAt, seen: seenAt, at: rumor.created_at,
    ...(via !== undefined && (KEEP_PASS_VIAS as readonly string[]).includes(via) ? { via: via as PassVia } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Open a gift wrap addressed to `backend`'s persona and return what is inside, if it is a valid ack or pass
 * report from one of `keeps`. Never throws. The checks are the contract's receiver rules: the seal verifies
 * and is signed by a Keep key we know, the rumor's author is the seal's author, and its `keep` tag names that
 * same Keep. Anything else (including other apps' gift wraps addressed to the same persona) is dropped.
 */
export async function unwrapKeepMessage(
  wrap: NostrEvent,
  backend: DecryptingSigningBackend,
  keeps: ReadonlySet<string>,
): Promise<KeepMessage | null> {
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
    if (rumor.kind === KEEP_MSG_PASS_REPORT_KIND) {
      const report = parsePassReportRumor(rumor, seal.pubkey);
      return report ? { kind: 'report', report } : null;
    }
    const ack = parseAckRumor(rumor, seal.pubkey);
    if (!ack) return null;
    return { kind: 'ack', ack: ack.owners || ack.settings ? { ...ack, to: backend.activePublicKeyHex } : ack };
  } catch {
    return null;
  }
}

/** The ack inside a gift wrap, if it is a valid one from one of `keeps` (a pass report is not an ack). Never throws. */
export async function unwrapKeepAck(
  wrap: NostrEvent,
  backend: DecryptingSigningBackend,
  keeps: ReadonlySet<string>,
): Promise<KeepAck | null> {
  const message = await unwrapKeepMessage(wrap, backend, keeps);
  return message?.kind === 'ack' ? message.ack : null;
}
