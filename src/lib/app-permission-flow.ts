/**
 * The pure decisions behind `?action=app-permission` on the phone that
 * receives it: what a URL is, and which flow (if any) may answer it.
 * App.tsx holds the state and the effects; nothing here touches React.
 */
import { parseAppPermissionRequest, APP_PERMISSION_ACTION, type AppPermissionRefusal, type AppPermissionRequest } from './app-permission';

export type AppPermissionUrl =
  | { kind: 'not-ours' }
  | { kind: 'refused'; reason: AppPermissionRefusal }
  | { kind: 'request'; request: AppPermissionRequest };

/**
 * `not-ours` for any query that is not `action=app-permission` (so a caller
 * can fall through to the next URL carrier). Any other outcome is a
 * consumed link: a request to show, or a refusal that is dropped.
 */
export function classifyAppPermissionSearch(search: string, nowS: number = Math.floor(Date.now() / 1000)): AppPermissionUrl {
  if (!search) return { kind: 'not-ours' };
  let action: string | null;
  try { action = new URLSearchParams(search).get('action'); } catch { return { kind: 'not-ours' }; }
  if (action !== APP_PERMISSION_ACTION) return { kind: 'not-ours' };
  const parsed = parseAppPermissionRequest(search, nowS);
  return parsed.ok ? { kind: 'request', request: parsed.request } : { kind: 'refused', reason: parsed.reason };
}

export type AppPermissionRefusalKind = 'legacy-paired-child' | 'dependant-on-guardian' | 'persona-not-on-device' | 'child-mode';

export type AppPermissionRoute =
  /** An adult signs as one of their own personas. */
  | { mode: 'adult'; persona: string }
  /** A child phone paired straight to the Heartwood: the guardian decides. */
  | { mode: 'child-direct'; persona: string }
  | { mode: 'refused'; reason: AppPermissionRefusalKind };

export interface AppPermissionRouteInput {
  /** The template's pubkey, lowercase hex. */
  persona: string;
  /** Preferences must already be loaded: callers never ask before then (R-33). */
  signingMode: string | undefined;
  childDirect: boolean;
  /** Owner personas that may sign here (default persona, extras, the real identity only when activated). */
  ownerPersonas: readonly string[];
  /** Every key a dependant holds, wherever it is signed. */
  dependantPersonas: readonly string[];
  /** A direct-paired child's own personas. */
  childPersonas: readonly string[];
  /** A guardian has handed this phone to a child (child mode): their own keys are not on offer. */
  guardianActingAsChild?: boolean;
}

const has = (list: readonly string[], pk: string) => list.some(p => p.toLowerCase() === pk);

/** D9: which flow, or a plain refusal. */
export function routeAppPermission(i: AppPermissionRouteInput): AppPermissionRoute {
  const persona = i.persona.toLowerCase();
  if (i.signingMode === 'paired-child') {
    if (!i.childDirect) return { mode: 'refused', reason: 'legacy-paired-child' };
    return has(i.childPersonas, persona)
      ? { mode: 'child-direct', persona }
      : { mode: 'refused', reason: 'persona-not-on-device' };
  }
  if (has(i.ownerPersonas, persona)) {
    return i.guardianActingAsChild ? { mode: 'refused', reason: 'child-mode' } : { mode: 'adult', persona };
  }
  if (has(i.dependantPersonas, persona)) return { mode: 'refused', reason: 'dependant-on-guardian' };
  return { mode: 'refused', reason: 'persona-not-on-device' };
}
