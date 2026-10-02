/**
 * Child-direct Permissions page helpers (spec §9.3, §9.4) — pure.
 *
 * Blocking an app is two effects (A7/A11): a `{persona:'*', scope:'*',
 * target, decision:'deny'}` rule, and the app id in the rules payload's
 * `disconnectedApps`. The list is DERIVED from those rules
 * (`disconnectedAppsFromRules`), so it syncs across guardian devices with the
 * rules self-rail and needs no store of its own.
 */
import type { AutonomyStage, DependantIdentity } from '../types';
import type { ChildRule, ChildRuleTarget } from '../types/child-rules';
import type { ConnectedChildApp } from './child-activity';
import { appTarget, childRuleId, isLiveRule, kindFromScope, normaliseAppId, siteTarget } from './child-rules';
import { SCOPE_KINDS } from './policy-compiler';
import { isDependantNaturalPersonActive } from './identity-display';
import { CHILD_PERMISSIONS_COPY as COPY } from './child-device-copy';

/** Wire cap on `disconnectedApps` (child-rules-wire MAX_DISCONNECTED). */
export const DISCONNECTED_APPS_MAX = 64;

const isAppBlockRule = (r: ChildRule): boolean =>
  r.decision === 'deny' && r.scope === '*' && r.persona === '*' && r.target.startsWith('app:');

/** App ids blocked by a live `*`-scope, `*`-persona deny rule; newest first, capped at 64. */
export function disconnectedAppsFromRules(rules: ChildRule[], nowMs: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const live = rules.filter(r => isAppBlockRule(r) && isLiveRule(r, nowMs)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of live) {
    const id = r.target.slice(4);
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= DISCONNECTED_APPS_MAX) break;
  }
  return out;
}

/** The rule target a connected app is blocked on: `site:<origin>` for a site, `app:<id>` otherwise. */
export function blockTargetFor(app: Pick<ConnectedChildApp, 'appId' | 'kind' | 'url'>): ChildRuleTarget | null {
  if (app.kind === 'site') {
    const origin = app.appId.startsWith('site:') ? app.appId.slice(5) : (app.url ?? '');
    return siteTarget(origin);
  }
  if (!app.appId || app.appId.startsWith('site:')) return null;
  return appTarget(app.appId);
}

/**
 * Rules to save for "Block this app": the `*`-scope deny rule, plus a
 * tombstone for every live allow rule on the same target. A `site:` deny at
 * `*` persona sits below an exact-persona allow in `findRule`'s precedence,
 * so the allows are withdrawn rather than left to outrank the block.
 * Null when the app has no blockable target.
 */
export function blockAppRules(dependantId: string, app: ConnectedChildApp, existing: ChildRule[], nowMs: number): ChildRule[] | null {
  const target = blockTargetFor(app);
  if (!target) return null;
  const dep = dependantId.toLowerCase();
  const id = childRuleId(dep, '*', '*', target);
  const prior = existing.find(r => r.id === id);
  const deny: ChildRule = {
    id, dependantId: dep, persona: '*', scope: '*', target, decision: 'deny',
    ...(app.label ? { label: app.label.slice(0, 100) } : {}),
    createdAt: prior?.createdAt ?? nowMs,
    updatedAt: nowMs,
  };
  const withdrawn = existing
    .filter(r => r.dependantId.toLowerCase() === dep && r.id !== id && r.decision === 'allow'
      && r.target === target && isLiveRule(r, nowMs))
    .map(r => ({ ...r, tombstonedAt: nowMs, updatedAt: nowMs }));
  return [deny, ...withdrawn];
}

/** Is this connected app blocked (listed as disconnected, or a live `*`-scope deny on its target)? */
export function isAppBlocked(app: ConnectedChildApp, rules: ChildRule[], disconnectedApps: string[], nowMs: number): boolean {
  if (app.kind !== 'site' && disconnectedApps.some(a => normaliseAppId(a) === normaliseAppId(app.appId))) return true;
  const target = blockTargetFor(app);
  if (!target) return false;
  const key = target.startsWith('app:') ? target : target.toLowerCase();
  return rules.some(r => r.decision === 'deny' && r.scope === '*' && r.persona === '*' && isLiveRule(r, nowMs)
    && (r.target.startsWith('app:') ? r.target : r.target.toLowerCase()) === key);
}

/** Human name for a rule's scope: `*` → every type, `kind:<n>` → "Other type (n)". */
export function ruleTypeName(scope: string): string {
  if (scope === '*') return COPY.everyType;
  const n = kindFromScope(scope);
  if (n !== null) return COPY.otherType(n);
  return COPY.scopeName[scope] ?? scope;
}

/** Relay AUTH — the child's app signs it for itself; not a scope. */
const RELAY_AUTH_KIND = 22242;

/**
 * "Allowed types on the Heartwood": the compiled ceiling as human names, one
 * per scope (a kind takes the first scope that lists it), then relay sign-in,
 * then every unclassified kind as "Other type (n)". An empty ceiling at
 * full-autonomy means every type.
 */
export function ceilingTypeNames(kinds: number[], stage: AutonomyStage): string[] {
  if (kinds.length === 0) return stage === 'full-autonomy' ? [COPY.everyType] : [];
  const names: string[] = [];
  const add = (s: string) => { if (!names.includes(s)) names.push(s); };
  const others: number[] = [];
  let relayAuth = false;
  for (const k of [...kinds].sort((a, b) => a - b)) {
    if (k === RELAY_AUTH_KIND) { relayAuth = true; continue; }
    const scope = Object.keys(SCOPE_KINDS).find(s => SCOPE_KINDS[s].includes(k));
    if (scope) add(COPY.scopeName[scope] ?? scope);
    else others.push(k);
  }
  if (relayAuth) add(COPY.relaySignIn);
  for (const k of others) add(COPY.otherType(k));
  return names;
}

/** The child's personas a guardian manages on the phone: default persona, the real identity once active, visible extras. */
export function permissionPersonas(dep: DependantIdentity): { pubkey: string; name: string }[] {
  const out: { pubkey: string; name: string }[] = [];
  // A51: a persona removed from the phone is no longer managed there (never the bound one).
  const bound = (dep.childDevice?.boundPersona ?? '').toLowerCase();
  const removed = new Set((dep.childDevice?.removedPersonas ?? []).map(k => k.toLowerCase()).filter(k => k !== bound));
  const put = (pk: string | undefined, name: string | undefined) => {
    const p = (pk ?? '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(p) && !removed.has(p) && !out.some(x => x.pubkey === p)) out.push({ pubkey: p, name: name || dep.displayName });
  };
  put(dep.persona?.publicKey, dep.persona?.displayName);
  if (isDependantNaturalPersonActive(dep)) put(dep.naturalPerson?.publicKey, dep.naturalPerson?.displayName);
  for (const x of dep.extraPersonas ?? []) if (!x.hidden) put(x.publicKey, x.displayName);
  return out;
}
