/**
 * Guardian -> child rules wire (child-direct Heartwood pairing, spec §5.2).
 * Authored by the dependant's rail key, vault-sealed to the child's client
 * pubkey. Live rules only: no tombstones, no `lastUsedAt`. Every field is
 * treated as hostile on open; anything off yields null.
 */
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { AutonomyStage } from '../types/dependants';
import type { ChildRule } from '../types/child-rules';
import { validateSchedule, type GrantSchedule } from './grant-schedule';
import { childRuleId, isValidRuleScope } from './child-rules';
import { CHILD_CEILING_MAX } from './policy-compiler';
import { sanitizeDisplayName } from './text-sanitize';
import { sealVaultPayload, openVaultPayload, MAX_ENVELOPE_CHARS } from './vault-envelope';

export const CHILD_RULES_WIRE_D_TAG = 'signet:child-rules:v1';
const KIND = 30078;
const HEX64 = /^[0-9a-f]{64}$/;
const STAGES: readonly string[] = ['full-control', 'request-approve', 'autonomous-alerts', 'autonomous-logging', 'full-autonomy'];
const MAX_RULES = 2000, MAX_DISCONNECTED = 64, MAX_ID = 200;
export const TARGET_RE = /^(?:site:https?:\/\/[^\s]{1,200}|app:[0-9a-f]{64}|app:nip55:[A-Za-z0-9._]{1,200}|app:mysignet|peer:[0-9a-f]{64}|\*)$/;
export const SCOPE_RE = /^(?:\*|[a-z0-9:_-]{1,64})$/;

export interface ChildRulesPayload {
  v: 1;
  dependantId: string;
  stage: AutonomyStage;
  defaultSchedule?: GrantSchedule;
  ceilingKinds: number[];
  rules: ChildRule[];
  disconnectedApps: string[];
  updatedAt: number;
}

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

export function parseScheduleValue(raw: unknown): GrantSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  try { validateSchedule(raw as GrantSchedule); return raw as GrantSchedule; } catch { return undefined; }
}

/**
 * Strictly validate one wire rule. Null when any required field is off, or
 * when the id is not the deterministic id of its own fields. Timestamps are
 * milliseconds.
 */
export function parseChildRuleRecord(raw: unknown): ChildRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.dependantId !== 'string' || !HEX64.test(r.dependantId)) return null;
  if (typeof r.persona !== 'string' || !(r.persona === '*' || HEX64.test(r.persona))) return null;
  if (typeof r.scope !== 'string' || !SCOPE_RE.test(r.scope) || !isValidRuleScope(r.scope)) return null;
  if (typeof r.target !== 'string' || !TARGET_RE.test(r.target)) return null;
  if (r.decision !== 'allow' && r.decision !== 'deny') return null;
  if (!posInt(r.createdAt) || !posInt(r.updatedAt)) return null;
  if (typeof r.id !== 'string' || r.id !== childRuleId(r.dependantId, r.persona, r.scope, r.target)) return null;
  const out: ChildRule = {
    id: r.id, dependantId: r.dependantId, persona: r.persona, scope: r.scope,
    target: r.target as ChildRule['target'], decision: r.decision,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
  const schedule = parseScheduleValue(r.schedule);
  if (schedule) out.schedule = schedule;
  if (typeof r.label === 'string') { const l = sanitizeDisplayName(r.label, 100); if (l) out.label = l; }
  if (posInt(r.expiresAt)) out.expiresAt = r.expiresAt;
  if (posInt(r.tombstonedAt)) out.tombstonedAt = r.tombstonedAt;
  if (posInt(r.lastUsedAt)) out.lastUsedAt = r.lastUsedAt;
  return out;
}

function checkPayload(raw: unknown): ChildRulesPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.dependantId !== 'string' || !HEX64.test(o.dependantId)) return null;
  if (typeof o.stage !== 'string' || !STAGES.includes(o.stage)) return null;
  if (!posInt(o.updatedAt)) return null;
  if (!Array.isArray(o.ceilingKinds) || o.ceilingKinds.length > CHILD_CEILING_MAX
    || !o.ceilingKinds.every(k => Number.isInteger(k) && k >= 0 && k <= 65535)) return null;
  if (!Array.isArray(o.rules) || o.rules.length > MAX_RULES) return null;
  if (!Array.isArray(o.disconnectedApps) || o.disconnectedApps.length > MAX_DISCONNECTED
    || !o.disconnectedApps.every(a => typeof a === 'string' && a.length > 0 && a.length <= MAX_ID)) return null;
  const rules: ChildRule[] = [];
  for (const item of o.rules) {
    const rule = parseChildRuleRecord(item);
    if (!rule || rule.dependantId !== o.dependantId || rule.tombstonedAt) continue;
    const { lastUsedAt: _drop, ...rest } = rule; void _drop;
    rules.push(rest);
  }
  const out: ChildRulesPayload = {
    v: 1, dependantId: o.dependantId, stage: o.stage as AutonomyStage,
    ceilingKinds: [...(o.ceilingKinds as number[])], rules,
    disconnectedApps: [...(o.disconnectedApps as string[])], updatedAt: o.updatedAt,
  };
  if (o.defaultSchedule !== undefined) {
    const s = parseScheduleValue(o.defaultSchedule);
    if (!s) return null; // a schedule we cannot read must not silently become "no schedule"
    out.defaultSchedule = s;
  }
  return out;
}

export async function buildChildRulesEvent(p: ChildRulesPayload, railPrivateKey: string, childClientPubkey: string, nowS: number): Promise<NostrEvent> {
  if (!HEX64.test(childClientPubkey) || !Number.isSafeInteger(nowS)) throw new Error('Invalid child rules target');
  // Live rules for THIS dependant only; strip usage metadata.
  const live = p.rules
    .filter(r => r.dependantId === p.dependantId && !(typeof r.tombstonedAt === 'number' && r.tombstonedAt > 0))
    .map(r => { const { lastUsedAt: _u, tombstonedAt: _t, ...rest } = r; void _u; void _t; return rest; });
  const payload = checkPayload({ ...p, rules: live });
  if (!payload) throw new Error('Invalid child rules payload');
  const sk = hexToBytes(railPrivateKey);
  try {
    const railPub = getPublicKey(sk);
    const sealed = await sealVaultPayload(JSON.stringify(payload), {
      activePublicKeyHex: railPub,
      nip44Encrypt: async (pub: string, text: string) => encrypt(text, getConversationKey(sk, pub)),
    }, { recipientPubkey: childClientPubkey });
    if (sealed === null) throw new Error('too-large');
    return finalizeEvent({ kind: KIND, created_at: nowS, tags: [['d', CHILD_RULES_WIRE_D_TAG], ['p', childClientPubkey]], content: sealed }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

export async function openChildRulesEvent(ev: NostrEvent, clientPrivateKey: string, expect: { railPubkey: string; dependantId: string }): Promise<ChildRulesPayload | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX64.test(expect.railPubkey) || !HEX64.test(expect.dependantId)) return null;
    sk = hexToBytes(clientPrivateKey);
    const clientPub = getPublicKey(sk);
    if (!ev || ev.pubkey !== expect.railPubkey || ev.kind !== KIND || typeof ev.content !== 'string'
      || ev.content.length > MAX_ENVELOPE_CHARS || !Array.isArray(ev.tags) || ev.tags.length !== 2
      || ev.tags[0]?.length !== 2 || ev.tags[0][0] !== 'd' || ev.tags[0][1] !== CHILD_RULES_WIRE_D_TAG
      || ev.tags[1]?.length !== 2 || ev.tags[1][0] !== 'p' || ev.tags[1][1] !== clientPub) return null;
    if (!verifyEvent({ id: ev.id, sig: ev.sig, pubkey: ev.pubkey, kind: ev.kind, created_at: ev.created_at,
      tags: ev.tags.map(t => [...t]), content: ev.content })) return null;
    const skl = sk;
    const plaintext = await openVaultPayload(ev.content, {
      nip44Decrypt: async (pub: string, text: string) => decrypt(text, getConversationKey(skl, pub)),
    }, expect.railPubkey, { legacyFallback: false });
    if (plaintext === null) return null;
    const payload = checkPayload(JSON.parse(plaintext));
    if (!payload || payload.dependantId !== expect.dependantId) return null;
    return payload;
  } catch { return null; }
  finally { sk?.fill(0); }
}

/** The payload with the newest `updatedAt` (`current` wins a tie; null-safe). */
export function newerRulesPayload(current: ChildRulesPayload | null, incoming: ChildRulesPayload | null): ChildRulesPayload | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.updatedAt > current.updatedAt ? incoming : current;
}
