import type { AppPreferences } from '../types';
import { isValidRelayUrl } from './relay-url';

const FIELDS = ['theme', 'securityTier', 'relayUrl', 'relays', 'blurIdentityNames', 'defaultBlossomUrl',
  'requireNpConfirmation', 'preferPersonaForSignIns', 'preferredPersonaPubkey'] as const;
export type PortableSettings = Pick<AppPreferences, typeof FIELDS[number]>;
export function portableSettingsValues(prefs: AppPreferences): PortableSettings {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS) if (prefs[field] !== undefined) out[field] = prefs[field];
  return out as PortableSettings;
}
export function parsePortableSettings(raw: string): { v: 1; updatedAt: number; values: PortableSettings } | null {
  if (raw.length > 32000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.updatedAt !== 'number' || !Number.isSafeInteger(v.updatedAt) || v.updatedAt < 0
    || !v.values || typeof v.values !== 'object' || Array.isArray(v.values)) return null;
  const p = v.values as Record<string, unknown>;
  if (!['system', 'light', 'dark'].includes(p.theme as string)) return null;
  if (p.securityTier !== undefined && !['basic', 'standard', 'expert'].includes(p.securityTier as string)) return null;
  for (const field of ['blurIdentityNames', 'requireNpConfirmation', 'preferPersonaForSignIns']) {
    if (p[field] !== undefined && typeof p[field] !== 'boolean') return null;
  }
  if (p.preferredPersonaPubkey !== undefined && (typeof p.preferredPersonaPubkey !== 'string' || !/^[a-f0-9]{64}$/.test(p.preferredPersonaPubkey))) return null;
  if (p.relayUrl !== undefined && (typeof p.relayUrl !== 'string' || p.relayUrl.length > 2048 || !isValidRelayUrl(p.relayUrl))) return null;
  if (p.relays !== undefined && (!Array.isArray(p.relays) || p.relays.length > 16 || p.relays.some(r => !r
    || typeof r.url !== 'string' || r.url.length > 2048 || !isValidRelayUrl(r.url)
    || typeof r.enabled !== 'boolean' || typeof r.read !== 'boolean' || typeof r.write !== 'boolean'))) return null;
  if (p.defaultBlossomUrl !== undefined) {
    if (typeof p.defaultBlossomUrl !== 'string' || p.defaultBlossomUrl.length > 2048) return null;
    if (p.defaultBlossomUrl !== '') {
      try { if (new URL(p.defaultBlossomUrl).protocol !== 'https:') return null; } catch { return null; }
    }
  }
  return { v: 1, updatedAt: v.updatedAt, values: portableSettingsValues(p as unknown as AppPreferences) };
}
