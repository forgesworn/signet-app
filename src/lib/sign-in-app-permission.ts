import type { NostrEvent } from 'signet-protocol';
import { validateAppPermissionTemplate, type AppPermissionTemplate } from './app-permission';
import { sanitizeDisplayName } from './text-sanitize';

/** Optional Sign in with Signet extension. Never carries family/age information. */
export interface SignInAppPermission {
  v: 1;
  permission: 'online-play';
  appId: string;
  installKey: string;
  validFrom: number;
  validUntil: number;
  reason: string;
}
export type SignInAppPermissionResult =
  | { v: 1; permission: 'online-play'; status: 'approved'; event: NostrEvent }
  | { v: 1; permission: 'online-play'; status: 'declined' };

export function encodeAppPermission(value: SignInAppPermission | SignInAppPermissionResult): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function permissionTemplate(request: SignInAppPermission, persona: string): AppPermissionTemplate {
  return { kind: 30420, pubkey: persona, content: '', tags: [
    ['d', request.appId], ['p', request.installKey], ['valid_from', String(request.validFrom)],
    ['valid_until', String(request.validUntil)], ['v', '1'], ['role', 'player'], ['expiration', String(request.validUntil)],
  ] };
}

/** Validate the full statement parameters, rather than treating a kind number as consent. */
export function parseSignInAppPermission(raw: string, nowS = Math.floor(Date.now() / 1000)): SignInAppPermission | null {
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || value.permission !== 'online-play') return null;
    const keys = ['v', 'permission', 'appId', 'installKey', 'validFrom', 'validUntil', 'reason'];
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) return null;
    if (typeof value.appId !== 'string' || typeof value.installKey !== 'string'
      || !Number.isSafeInteger(value.validFrom) || !Number.isSafeInteger(value.validUntil) || value.validUntil <= nowS) return null;
    if (typeof value.reason !== 'string' || !value.reason.trim() || [...value.reason].length > 200) return null;
    const reason = sanitizeDisplayName(value.reason, 200);
    if (!reason) return null;
    const request = { ...value, reason } as SignInAppPermission;
    // Only the picker knows the persona. Validate the parameters against a
    // distinct placeholder here; approval validates again with the actual key.
    const placeholder = request.installKey === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const checked = validateAppPermissionTemplate(permissionTemplate(request, placeholder), { nowS, checkTime: true });
    return checked.ok ? request : null;
  } catch { return null; }
}
