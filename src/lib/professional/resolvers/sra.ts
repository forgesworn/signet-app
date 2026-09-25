/**
 * SRA Solicitor-firm resolver.
 *
 * Access-terms policy (spec §12 Q2):
 *   The SRA Data Sharing API (Azure API Management) is described as free public access.
 *   Registration for a subscription key may be required. If SRA's published terms preclude
 *   direct client-side calls from a third-party app, the fallback is a Signet-hosted mirror
 *   that caches SRA data server-side and re-serves it under Signet's own agreed terms.
 *
 *   Env vars (set in .env.local, never committed):
 *     VITE_SRA_API_KEY    — Ocp-Apim-Subscription-Key for direct API access. If absent,
 *                            falls back to VITE_SRA_MIRROR_URL.
 *     VITE_SRA_MIRROR_URL — Base URL of Signet-hosted SRA mirror (optional).
 *
 *   If neither is set, resolve() throws (caller should surface onboarding error to user).
 */
import type { ProfessionResolver, RegulatedEntityRecord } from '../types';
import { MAX_REGISTRY_FETCH_BYTES } from '../constants';

const SRA_BASE = 'https://sra-prod-apim.developer.azure-api.net/v1/organisations';

// SRA firm numbers are typically 5–7 digit numeric strings.
// The matches() predicate excludes 6-digit numbers because they collide with GIAS URNs.
// In practice, disambiguation is by professionKind declared at onboarding — professionKind-first
// dispatch means matches() is only a sanity check, never the sole dispatch criterion.
const SRA_ID_RE = /^\d{5,7}$/;

interface SRAFirmResponse {
  id: string;
  name: string;
  status: string;
  address?: { postcode?: string; town?: string };
  website?: string;
}

function normaliseDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return url.host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function mapStatus(status: string): 'Active' | 'Inactive' {
  return status === 'Authorised' ? 'Active' : 'Inactive';
}

export class SRAResolver implements ProfessionResolver {
  readonly professionKind = 'solicitor-firm' as const;
  readonly jurisdictions: import('../types').Jurisdiction[] = ['england-wales'];

  matches(identifier: string): boolean {
    return SRA_ID_RE.test(identifier);
  }

  async resolve(identifier: string): Promise<RegulatedEntityRecord | null> {
    const apiKey = import.meta.env.VITE_SRA_API_KEY ?? '';
    const mirrorUrl = import.meta.env.VITE_SRA_MIRROR_URL ?? '';

    let url: string;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (apiKey) {
      url = `${SRA_BASE}/${encodeURIComponent(identifier)}`;
      headers['Ocp-Apim-Subscription-Key'] = apiKey;
    } else if (mirrorUrl) {
      url = `${mirrorUrl.replace(/\/$/, '')}/${encodeURIComponent(identifier)}`;
    } else {
      throw new Error('SRA resolver: no API key or mirror URL configured. Set VITE_SRA_API_KEY or VITE_SRA_MIRROR_URL.');
    }

    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`SRA API error: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_REGISTRY_FETCH_BYTES) {
      throw new Error(`SRA response for ${identifier} exceeds size limit (${text.length} bytes)`);
    }
    const data = JSON.parse(text) as SRAFirmResponse;

    return {
      professionKind: 'solicitor-firm',
      jurisdiction: 'england-wales',
      registry: 'SRA',
      identifier: data.id,
      identifierKind: 'SRA-FirmNumber',
      name: data.name,
      status: mapStatus(data.status),
      website: normaliseDomain(data.website),
      inferredCandidateWebsite: null,
      postcode: data.address?.postcode ?? '',
      locality: data.address?.town ?? '',
      tags: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}
