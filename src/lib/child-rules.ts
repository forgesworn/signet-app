/**
 * ChildRule helpers (child-direct Heartwood pairing, spec §5.1) — pure.
 * Rules are keyed by a deterministic id so the same decision made on two
 * guardian devices converges on one record.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ChildRule, ChildRuleTarget } from '../types/child-rules';
import type { RememberedGrant } from '../types/grants';
import { safeOriginForGrant } from './scope-inference';

const HEX64 = /^[0-9a-f]{64}$/;

/** sha256('signet:child-rule:v1:' + dep|persona|scope|target), first 32 hex, inputs lowercased. */
export function childRuleId(dependantId: string, persona: string, scope: string, target: string): string {
  const text = `signet:child-rule:v1:${dependantId}|${persona}|${scope}|${target}`.toLowerCase();
  return bytesToHex(sha256(new TextEncoder().encode(text))).slice(0, 32);
}

/** `site:<origin>` for an https (or localhost) origin, else null. */
export function siteTarget(origin: string): ChildRuleTarget | null {
  const safe = safeOriginForGrant(origin);
  return safe ? (`site:${safe}` as ChildRuleTarget) : null;
}

export function appTarget(appId: string): ChildRuleTarget {
  return `app:${appId}` as ChildRuleTarget;
}

export function peerTarget(hex: string): ChildRuleTarget | null {
  const h = (hex ?? '').toLowerCase();
  return HEX64.test(h) ? (`peer:${h}` as ChildRuleTarget) : null;
}

/** Not tombstoned and not expired. `nowMs` is milliseconds. */
export function isLiveRule(r: ChildRule, nowMs: number): boolean {
  if (typeof r.tombstonedAt === 'number' && r.tombstonedAt > 0) return false;
  if (typeof r.expiresAt === 'number' && r.expiresAt > 0 && r.expiresAt <= nowMs) return false;
  return true;
}

/**
 * Best matching live rule. Precedence: exact persona + exact target, then
 * `*` persona + exact target, then exact persona + `*` target, then `*` + `*`.
 * Within a level, `deny` wins. `targets` are the request's candidate targets
 * (e.g. its app and its site).
 */
export function findRule(
  rules: ChildRule[],
  q: { persona: string; scope: string; targets: ChildRuleTarget[]; nowMs: number },
): ChildRule | null {
  const persona = q.persona.toLowerCase();
  const wanted = new Set<string>(q.targets.map(t => t.toLowerCase()));
  const live = rules.filter(r => r.scope === q.scope && isLiveRule(r, q.nowMs));
  const levels: Array<(r: ChildRule) => boolean> = [
    r => r.persona.toLowerCase() === persona && wanted.has(r.target.toLowerCase()),
    r => r.persona === '*' && wanted.has(r.target.toLowerCase()),
    r => r.persona.toLowerCase() === persona && r.target === '*',
    r => r.persona === '*' && r.target === '*',
  ];
  for (const level of levels) {
    const hits = live.filter(level);
    if (hits.length === 0) continue;
    return hits.find(r => r.decision === 'deny') ?? hits[0];
  }
  return null;
}

/**
 * One-off copy of a dependant's live phone-served grants into ChildRules
 * (`persona '*'`, `site:` / `peer:` target from `origin`). Legacy grant times
 * are seconds; rules are milliseconds. Unmappable origins are skipped.
 */
export function rulesFromLegacyGrants(dependantId: string, grants: RememberedGrant[], nowMs: number): ChildRule[] {
  const dep = dependantId.toLowerCase();
  const out: ChildRule[] = [];
  for (const g of grants) {
    if (g.dependantId.toLowerCase() !== dep) continue;
    if (typeof g.tombstonedAt === 'number' && g.tombstonedAt > 0) continue;
    if (typeof g.expiresAt === 'number' && g.expiresAt > 0 && g.expiresAt * 1000 <= nowMs) continue;
    const target = /^https?:/i.test(g.origin) ? siteTarget(g.origin) : peerTarget(g.origin);
    if (!target) continue;
    out.push({
      id: childRuleId(dep, '*', g.scope, target),
      dependantId: dep,
      persona: '*',
      scope: g.scope,
      target,
      decision: g.decision,
      ...(g.schedule ? { schedule: g.schedule } : {}),
      createdAt: g.decidedAt * 1000,
      updatedAt: g.decidedAt * 1000,
      ...(typeof g.expiresAt === 'number' && g.expiresAt > 0 ? { expiresAt: g.expiresAt * 1000 } : {}),
      ...(typeof g.lastUsedAt === 'number' ? { lastUsedAt: g.lastUsedAt * 1000 } : {}),
    });
  }
  return out;
}
