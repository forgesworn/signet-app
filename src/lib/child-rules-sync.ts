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

/**
 * LWW per id on `max(updatedAt, tombstonedAt)`. A tie goes to the side with a
 * tombstone (revocation is sticky). `changed` is true when the merged set
 * differs from `local` (a remote record was added or won).
 */
export function mergeChildRules(local: ChildRule[], remote: ChildRule[]): { merged: ChildRule[]; changed: boolean } {
  const byId = new Map<string, ChildRule>();
  for (const l of local) byId.set(l.id, l);
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l) { byId.set(r.id, r); changed = true; continue; }
    const rt = effectiveTime(r), lt = effectiveTime(l);
    if (rt > lt || (rt === lt && !!r.tombstonedAt && !l.tombstonedAt)) { byId.set(r.id, r); changed = true; }
  }
  return { merged: Array.from(byId.values()), changed };
}

export function parseChildRulesPayload(raw: string): ChildRule[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V || !Array.isArray(p.rules)) return null;
  const out: ChildRule[] = [];
  for (const item of p.rules.slice(0, MAX_RULES)) {
    const rule = parseChildRuleRecord(item);
    if (rule) out.push(rule);
  }
  return out;
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
): Promise<{ rules: ChildRule[]; createdAt: number; eventId: string; reachableRelays: number } | null | 'unreachable'> {
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
    const rules = parseChildRulesPayload(plaintext);
    if (!rules) return null;
    return { rules, createdAt: latest.created_at, eventId: latest.id, reachableRelays };
  } catch {
    return null;
  }
}
