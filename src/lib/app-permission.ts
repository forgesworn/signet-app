/**
 * App permission requests (`?action=app-permission`, design 2026-10-12): an
 * app asks a persona to sign ONE fixed statement — kind 30420, "this install
 * may play online as me" — and gets the answer back as a stored gift wrap on
 * the app's relay. Pure: no relay traffic, no storage, the clock is a param.
 *
 *   parseAppPermissionRequest     the URL request (D1), refusal reason on failure
 *   validateAppPermissionTemplate the one template shape (D2); `checkTime`
 *                                 false on the guardian, who answers later
 *   checkAppPermissionClaim       the sanitised app claim an ask carries (D6)
 *   appPermissionAskDetails       what the guardian's card may show, or null
 *                                 (⇒ the generic card)
 *   buildAppPermission*Rumor      the kind-29999 answer rumors (D8)
 *
 * Every string the app supplies is display text only: the card's headline
 * and "What this allows" are My Signet's own copy, never the app's.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { sanitizeDisplayName } from './text-sanitize';
import { isValidRelayUrl } from './relay-url';
import { safeOriginForGrant } from './scope-inference';
import { siteTarget } from './child-rules';
import type { ChildSignAsk } from './child-sign-asks';

export const APP_PERMISSION_ACTION = 'app-permission';
export const APP_PERMISSION_KIND = 30420;
/** The closed list. v1 has one permission. */
export const APP_PERMISSIONS = ['online-play'] as const;
export type AppPermissionName = (typeof APP_PERMISSIONS)[number];
export const APP_PERMISSION_RESPONSE_TYPE = 'signet-app-permission-response';
/** The answer rumor kind (as `?auth=1`, so apps reuse their checks). */
export const APP_PERMISSION_ANSWER_KIND = 29999;

/** `t` and the template's `valid_from` must be this close to now at parse time (seconds). */
export const APP_PERMISSION_FRESHNESS_S = 300;
/** A statement lasts at most this long (seconds). */
export const APP_PERMISSION_MAX_VALIDITY_S = 90 * 86400;
export const APP_PERMISSION_TEMPLATE_PARAM_MAX = 4096;
export const APP_PERMISSION_RELAY_MAX = 1024;
export const APP_PERMISSION_NAME_MAX = 64;
export const APP_PERMISSION_REASON_MAX = 200;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX64_ANY = /^[0-9a-f]{64}$/i;
const UINT = /^(0|[1-9][0-9]{0,15})$/;
const APP_ID = /^[a-z0-9-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const TEMPLATE_KEYS = ['content', 'kind', 'pubkey', 'tags'];
const TAG_NAMES = ['d', 'p', 'valid_from', 'valid_until', 'v', 'role', 'expiration'] as const;

// ── Template (D2) ──────────────────────────────────────────────────────────

/** The unsigned statement, exactly as the app sent it. My Signet sets `created_at` when it signs. */
export interface AppPermissionTemplate { kind: 30420; pubkey: string; content: ''; tags: string[][] }

export interface AppPermissionTemplateDetails {
  /** `d`: the app id. */
  appId: string;
  /** `p`: the app install's runtime key. */
  installKey: string;
  /** Unix seconds. */
  validFrom: number;
  validUntil: number;
}

export type AppPermissionTemplateRefusal =
  | 'keys' | 'kind' | 'content' | 'pubkey' | 'tags'
  | 'd' | 'p' | 'valid_from' | 'valid_until' | 'v' | 'role' | 'expiration';

/** 64 lowercase hex that lifts to a secp256k1 x-only point. */
export function isXOnlyPoint(hex: string): boolean {
  if (!HEX64.test(hex)) return false;
  try { schnorr.utils.lift_x(BigInt(`0x${hex}`)); return true; } catch { return false; }
}

const uint = (s: string): number | null => (UINT.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null);

/**
 * The one shape (D2). `raw` must be an object with EXACTLY the keys
 * `kind`, `pubkey`, `content`, `tags`. Every tag in the list exactly once,
 * each exactly `[name, value]`, nothing else. `checkTime` covers only the
 * `valid_from` ±300 s check; every other rule is checked either way.
 */
export function validateAppPermissionTemplate(
  raw: unknown,
  opts: { nowS: number; checkTime: boolean },
): { ok: true; template: AppPermissionTemplate; details: AppPermissionTemplateDetails } | { ok: false; reason: AppPermissionTemplateRefusal } {
  const no = (reason: AppPermissionTemplateRefusal) => ({ ok: false as const, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('keys');
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== TEMPLATE_KEYS.length || keys.some((k, i) => k !== TEMPLATE_KEYS[i])) return no('keys');
  if (o.kind !== APP_PERMISSION_KIND) return no('kind');
  if (o.content !== '') return no('content');
  if (typeof o.pubkey !== 'string' || !HEX64.test(o.pubkey)) return no('pubkey');
  const pubkey = o.pubkey;

  if (!Array.isArray(o.tags) || o.tags.length !== TAG_NAMES.length) return no('tags');
  const values = new Map<string, string>();
  for (const tag of o.tags) {
    if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string') return no('tags');
    if (!(TAG_NAMES as readonly string[]).includes(tag[0]) || values.has(tag[0])) return no('tags');
    values.set(tag[0], tag[1]);
  }
  const v = (name: (typeof TAG_NAMES)[number]) => values.get(name) as string;

  if (!APP_ID.test(v('d'))) return no('d');
  if (!isXOnlyPoint(v('p')) || v('p') === pubkey) return no('p');
  const validFrom = uint(v('valid_from'));
  if (validFrom === null) return no('valid_from');
  if (opts.checkTime && Math.abs(validFrom - opts.nowS) > APP_PERMISSION_FRESHNESS_S) return no('valid_from');
  const validUntil = uint(v('valid_until'));
  if (validUntil === null || validUntil <= validFrom || validUntil > validFrom + APP_PERMISSION_MAX_VALIDITY_S) return no('valid_until');
  if (v('v') !== '1') return no('v');
  if (v('role') !== 'player') return no('role');
  if (v('expiration') !== v('valid_until')) return no('expiration');

  return {
    ok: true,
    template: { kind: APP_PERMISSION_KIND, pubkey, content: '', tags: o.tags.map(t => [t[0], t[1]] as string[]) },
    details: { appId: v('d'), installKey: v('p'), validFrom, validUntil },
  };
}

/** The four template fields of an event (the guardian re-validates the ask's template through this). */
export function appPermissionTemplateOf(e: Pick<UnsignedEvent, 'kind' | 'pubkey' | 'content' | 'tags'>): Record<string, unknown> {
  return { kind: e.kind, pubkey: e.pubkey, content: e.content, tags: e.tags };
}

// ── App claim (D6) ─────────────────────────────────────────────────────────

/** What the app says about itself; carried on the child's ask, re-checked by the guardian. */
export interface AppPermissionClaim {
  permission: AppPermissionName;
  name: string;
  /** Canonical https (or localhost) origin. The app's own claim: the card says "From <origin>" and no more. */
  origin: string;
  reason: string;
}

/**
 * Sanitise, then require 1..max code points. Over-long text is refused, not
 * cut: a reason cut short could read differently to the guardian.
 */
function boundedText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const clean = sanitizeDisplayName(raw, max + 1);
  const n = Array.from(clean).length;
  return n >= 1 && n <= max ? clean : null;
}

function isPermission(raw: unknown): raw is AppPermissionName {
  return typeof raw === 'string' && (APP_PERMISSIONS as readonly string[]).includes(raw);
}

/** Canonical origin for an https / localhost origin string that IS an origin (no path). */
function canonicalOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const safe = safeOriginForGrant(raw);
  return safe && safe === raw ? safe : null;
}

/** Exactly `{permission, name, origin, reason}`, each valid; name and reason re-sanitised. Else null. */
export function checkAppPermissionClaim(raw: unknown): AppPermissionClaim | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== 'name,origin,permission,reason') return null;
  if (!isPermission(o.permission)) return null;
  const origin = canonicalOrigin(o.origin);
  const name = boundedText(o.name, APP_PERMISSION_NAME_MAX);
  const reason = boundedText(o.reason, APP_PERMISSION_REASON_MAX);
  if (!origin || !name || !reason) return null;
  return { permission: o.permission, name, origin, reason };
}

export interface AppPermissionAskDetails extends AppPermissionClaim, AppPermissionTemplateDetails {}

/**
 * The guardian's card input for an app-permission ask (D6/D10), or null —
 * the generic card — when the ask has no claim, is not this scope, its
 * template no longer passes the one-shape check (no clock check: the
 * guardian may answer later), its tags were truncated, or its target is not
 * the claimed origin.
 */
export function appPermissionAskDetails(ask: ChildSignAsk): AppPermissionAskDetails | null {
  if (ask.scope !== 'app-permission' || ask.method !== 'sign_event' || !ask.template || ask.tagsTruncated || ask.contentTruncated) return null;
  const claim = ask.appPermission ? checkAppPermissionClaim(ask.appPermission) : null;
  if (!claim || ask.target !== siteTarget(claim.origin)) return null;
  const t = validateAppPermissionTemplate(appPermissionTemplateOf(ask.template), { nowS: 0, checkTime: false });
  if (!t.ok || t.template.pubkey !== ask.persona) return null;
  return { ...claim, ...t.details };
}

// ── Request (D1) ───────────────────────────────────────────────────────────

export interface AppPermissionRequest extends AppPermissionClaim {
  template: AppPermissionTemplate;
  details: AppPermissionTemplateDetails;
  /** The app's relay: the answer goes here (plus the user's relay). */
  relay: string;
  /** The answer is gift-wrapped to this key. Lowercase. */
  sessionPubkey: string;
  /** 64 lowercase hex. */
  challenge: string;
  /** Unix seconds. */
  t: number;
  /** Same origin as `origin`; required, unused in relay mode. */
  callback: string;
}

export type AppPermissionRefusal =
  | 'action' | 'permission' | 'origin' | 'callback' | 't' | 'challenge'
  | 'relay' | 'session' | 'name' | 'reason' | 'template';

function isValidOriginScheme(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function decodeBase64Url(raw: string): string | null {
  if (!B64URL.test(raw)) return null;
  try {
    const b64 = raw.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}

/**
 * Parse `?action=app-permission&permission&origin&name&reason&template&relay
 * &sessionPubkey&challenge&t&callback` (D1). Any failure refuses the whole
 * request — nothing reaches a card — with the first reason found.
 */
export function parseAppPermissionRequest(
  search: string,
  nowS: number = Math.floor(Date.now() / 1000),
): { ok: true; request: AppPermissionRequest } | { ok: false; reason: AppPermissionRefusal } {
  const no = (reason: AppPermissionRefusal) => ({ ok: false as const, reason });
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return no('action'); }
  if (params.get('action') !== APP_PERMISSION_ACTION) return no('action');

  const permission = params.get('permission');
  if (!isPermission(permission)) return no('permission');

  let originUrl: URL;
  try { originUrl = new URL(params.get('origin') ?? ''); } catch { return no('origin'); }
  if (!isValidOriginScheme(originUrl)) return no('origin');
  const origin = originUrl.origin;

  let callbackUrl: URL;
  try { callbackUrl = new URL(params.get('callback') ?? ''); } catch { return no('callback'); }
  if (!isValidOriginScheme(callbackUrl) || callbackUrl.origin !== origin) return no('callback');

  const t = uint(params.get('t') ?? '');
  if (t === null || Math.abs(nowS - t) > APP_PERMISSION_FRESHNESS_S) return no('t');

  const rawChallenge = params.get('challenge') ?? '';
  if (!HEX64_ANY.test(rawChallenge)) return no('challenge');

  const relay = params.get('relay') ?? '';
  if (!relay || relay.length > APP_PERMISSION_RELAY_MAX || !isValidRelayUrl(relay)) return no('relay');

  const sessionPubkey = (params.get('sessionPubkey') ?? '').toLowerCase();
  if (!isXOnlyPoint(sessionPubkey)) return no('session');

  const name = boundedText(params.get('name'), APP_PERMISSION_NAME_MAX);
  if (!name) return no('name');
  const reason = boundedText(params.get('reason'), APP_PERMISSION_REASON_MAX);
  if (!reason) return no('reason');

  const rawTemplate = params.get('template');
  if (!rawTemplate || rawTemplate.length > APP_PERMISSION_TEMPLATE_PARAM_MAX) return no('template');
  const json = decodeBase64Url(rawTemplate);
  if (json === null) return no('template');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return no('template'); }
  const checked = validateAppPermissionTemplate(parsed, { nowS, checkTime: true });
  if (!checked.ok) return no('template');

  return {
    ok: true,
    request: {
      permission, origin, name, reason, template: checked.template, details: checked.details,
      relay, sessionPubkey, challenge: rawChallenge.toLowerCase(), t, callback: callbackUrl.toString(),
    },
  };
}

// ── Answer rumors (D8) ─────────────────────────────────────────────────────

/** Approved: rumor by the persona, gift-wrapped ONCE through the seal-pass backend to `sessionPubkey`. */
export function buildAppPermissionApprovedRumor(a: {
  persona: string; challenge: string; permission: AppPermissionName; event: NostrEvent; nowS?: number;
}): UnsignedEvent {
  return {
    kind: APP_PERMISSION_ANSWER_KIND,
    pubkey: a.persona,
    created_at: a.nowS ?? Math.floor(Date.now() / 1000),
    tags: [['session', a.challenge], ['status', 'approved']],
    content: JSON.stringify({ type: APP_PERMISSION_RESPONSE_TYPE, permission: a.permission, challenge: a.challenge, event: a.event }),
  };
}

/**
 * Denied (guardian Deny or the user's Cancel): `pubkey` is a THROWAWAY key's,
 * never the persona's — the app must not be able to attribute a refusal.
 */
export function buildAppPermissionDeniedRumor(a: {
  pubkey: string; challenge: string; permission: AppPermissionName; nowS?: number;
}): UnsignedEvent {
  return {
    kind: APP_PERMISSION_ANSWER_KIND,
    pubkey: a.pubkey,
    created_at: a.nowS ?? Math.floor(Date.now() / 1000),
    tags: [['session', a.challenge], ['status', 'rejected']],
    content: JSON.stringify({ type: APP_PERMISSION_RESPONSE_TYPE, permission: a.permission, challenge: a.challenge, denied: true }),
  };
}
