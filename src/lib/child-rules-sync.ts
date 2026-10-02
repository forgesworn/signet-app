/**
 * Guardian self-sync rail for ChildRules (child-direct Heartwood pairing,
 * spec §5.2). Same shape as `grants-sync.ts`: kind-30078 replaceable event,
 * vault envelope sealed to self, LWW per rule id on
 * `max(updatedAt, tombstonedAt)`, tombstones carried, no information-free
 * publish. Timestamps are milliseconds.
 */
import type { UnsignedEvent } from 'signet-protocol';
import type { ChildRule } from '../types/child-rules';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { sealVaultPayload, openVaultPayloadOrThrow } from './vault-envelope';
import { parseChildRuleRecord } from './child-rules-wire';

export const CHILD_RULES_SYNC_D_TAG = 'signet:child-rules';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;
const MAX_RULES = 5000;

const effectiveTime = (r: ChildRule): number => Math.max(r.updatedAt, r.tombstonedAt ?? 0);

/** Key-sorted JSON without `lastUsedAt` (device-local usage metadata). */
function canonicalRuleJson(r: ChildRule): string {
  const { lastUsedAt: _u, ...rest } = r; void _u;
  return JSON.stringify(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))));
}

/**
 * Deterministic winner of two versions of one rule: later `max(updatedAt,
 * tombstonedAt)`; on a tie a tombstone, else the lexicographically larger
 * canonical JSON. Returns 'local' | 'remote' | 'same'.
 */
function pick(l: ChildRule, r: ChildRule): 'local' | 'remote' | 'same' {
  const lt = effectiveTime(l), rt = effectiveTime(r);
  if (rt !== lt) return rt > lt ? 'remote' : 'local';
  const lTomb = !!l.tombstonedAt, rTomb = !!r.tombstonedAt;
  if (lTomb !== rTomb) return rTomb ? 'remote' : 'local';
  const lj = canonicalRuleJson(l), rj = canonicalRuleJson(r);
  if (lj === rj) return 'same';
  return rj > lj ? 'remote' : 'local';
}

/**
 * LWW per id (see `pick`); `lastUsedAt` merges as the max of both sides.
 * `changed` is true when the merged set differs from `local`.
 */
export function mergeChildRules(local: ChildRule[], remote: ChildRule[]): { merged: ChildRule[]; changed: boolean } {
  const byId = new Map<string, ChildRule>();
  for (const l of local) byId.set(l.id, l);
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l) { byId.set(r.id, r); changed = true; continue; }
    const winner = pick(l, r) === 'remote' ? r : l;
    const used = Math.max(l.lastUsedAt ?? 0, r.lastUsedAt ?? 0);
    const next: ChildRule = used > 0 ? { ...winner, lastUsedAt: used } : winner;
    if (winner !== l || next.lastUsedAt !== l.lastUsedAt) { byId.set(r.id, next); changed = true; }
  }
  return { merged: Array.from(byId.values()), changed };
}

/**
 * True when `local` holds something `remote` lacks: an id it has no version of,
 * or a version that beats the remote's. Ignores `lastUsedAt`. Publishing on
 * mere difference could overwrite a richer remote and flap.
 */
export function isRulesRicherThan(local: ChildRule[], remote: ChildRule[]): boolean {
  const remoteById = new Map(remote.map(r => [r.id, r]));
  for (const l of local) {
    const r = remoteById.get(l.id);
    if (!r || pick(l, r) === 'local') return true;
  }
  return false;
}

export interface ParsedChildRules { rules: ChildRule[]; /** entries dropped as unparseable or over the cap */ dropped: number; }

export function parseChildRulesPayloadDetailed(raw: string): ParsedChildRules | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V || !Array.isArray(p.rules)) return null;
  const out: ChildRule[] = [];
  let dropped = Math.max(0, p.rules.length - MAX_RULES);
  for (const item of p.rules.slice(0, MAX_RULES)) {
    const rule = parseChildRuleRecord(item);
    if (rule) out.push(rule); else dropped++;
  }
  return { rules: out, dropped };
}

export function parseChildRulesPayload(raw: string): ChildRule[] | null {
  return parseChildRulesPayloadDetailed(raw)?.rules ?? null;
}

export async function publishChildRulesSync(
  rules: ChildRule[],
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
): Promise<boolean> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return false;
  // Never publish an information-free record: zero rules AND zero tombstones.
  if (rules.length === 0) return false;
  const encrypted = await sealVaultPayload(JSON.stringify({ v: SCHEMA_V, rules }), backend);
  if (encrypted === null) return false;
  const event: UnsignedEvent = {
    kind: SYNC_KIND,
    pubkey: backend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', CHILD_RULES_SYNC_D_TAG]],
    content: encrypted,
  };
  const signed = await backend.signEvent(event);
  return publishToRelays(signed, targets);
}

export async function fetchChildRulesSync(
  authorPubkey: string,
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
  sinceCreatedAt?: number,
  cache?: SyncDecryptCache,
): Promise<{ rules: ChildRule[]; createdAt: number; eventId: string; reachableRelays: number; partial?: boolean } | null | 'unreachable' | 'unusable'> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return 'unreachable';
  if (!/^[0-9a-f]{64}$/i.test(authorPubkey)) return null;

  const { event: latest, reachableRelays } = await fetchNewestFromRelays(
    { kinds: [SYNC_KIND], authors: [authorPubkey], '#d': [CHILD_RULES_SYNC_D_TAG], limit: 1 },
    targets,
    authorPubkey,
  );
  if (reachableRelays === 0) return 'unreachable';
  if (!latest) return null;
  if (sinceCreatedAt !== undefined && latest.created_at <= sinceCreatedAt) return null;
  try {
    const plaintext = await readSyncPlaintext(cache, latest, () => openVaultPayloadOrThrow(latest.content, backend, authorPubkey));
    const parsed = parseChildRulesPayloadDetailed(plaintext);
    // A record that exists but cannot be read must never be published over.
    if (!parsed) return 'unusable';
    return { rules: parsed.rules, createdAt: latest.created_at, eventId: latest.id, reachableRelays, partial: parsed.dropped > 0 };
  } catch {
    return 'unusable';
  }
}
