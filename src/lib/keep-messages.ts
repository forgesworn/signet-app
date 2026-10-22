/**
 * K1d messages between My Signet and a Keep: build the rumors we send and read
 * the acks we get back. Pure apart from the signing backend we are handed; no
 * relay, no storage. See the K1d contract for the wire format.
 *
 * Sending reuses `giftWrap` (rumor -> kind 13 seal signed by the persona ->
 * kind 1059 wrap under a throwaway key). Its `created_at` jitter on seal and
 * wrap is a few seconds, which sits inside NIP-59's "up to two days back"
 * allowance; the rumor carries the real time, as the contract requires.
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
import type { DecryptingSigningBackend } from './signing-backend';
import {
  KEEP_ACK_STATUSES, KEEP_INVITE_LABEL_MAX, KEEP_MSG_ACK_KIND, KEEP_MSG_CLAIM_KIND,
  KEEP_MSG_INVITE_KIND, KEEP_MSG_REVOKE_KIND, KEEP_REFUSAL_REASONS,
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

export function claimRumor(backend: DecryptingSigningBackend, keep: string, code: string, now: number): UnsignedEvent {
  return rumorTemplate(backend, KEEP_MSG_CLAIM_KIND, [['keep', keep], ['code', code]], now);
}

/** Exactly one of `persona` / `guest`; `label` is cut to the contract's 40 characters. */
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
  const label = Array.from(spec.label ?? '').slice(0, KEEP_INVITE_LABEL_MAX).join('').trim();
  if (label) tags.push(['name', label]);
  return rumorTemplate(backend, KEEP_MSG_INVITE_KIND, tags, now);
}

export function revokeRumor(backend: DecryptingSigningBackend, keep: string, grant: string, now: number): UnsignedEvent {
  if (!HEX64.test(keep) || !HEX32.test(grant)) throw new Error('Invalid revoke');
  return rumorTemplate(backend, KEEP_MSG_REVOKE_KIND, [['keep', keep], ['grant', grant]], now);
}

/** Wrap one rumor to the Keep; the wrap goes to the Keep's relays. */
export function wrapForKeep(rumor: UnsignedEvent, keep: string, backend: DecryptingSigningBackend): Promise<NostrEvent> {
  return giftWrap(rumor, keep, backend);
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
  if (!Number.isSafeInteger(rumor.created_at)) return null;
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
    return parseAckRumor(rumor, seal.pubkey);
  } catch {
    return null;
  }
}
