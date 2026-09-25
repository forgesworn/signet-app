import type { ProfessionResolver, RegulatedEntityRecord } from '../types';
import { MAX_REGISTRY_FETCH_BYTES } from '../constants';

// Spec §12 Q3: opt-in partner code. Default off.
function partnerCodeParam(): string {
  const code = import.meta.env.VITE_CQC_PARTNER_CODE ?? '';
  return code ? `?partnerCode=${encodeURIComponent(code)}` : '';
}

// CQC provider ID pattern: alphanumeric (e.g. 'RXL') or numeric with dashes (e.g. '1-123456789').
// Excludes 6-digit GIAS URNs (pure 6-digit numeric).
const CQC_ID_RE = /^(?:[A-Z]{2,}[0-9A-Z]*|[0-9]+-[0-9]+)$/i;

interface CQCResponse {
  providerId: string;
  name: string;
  registrationStatus: string;
  mainAddress?: { postalCode?: string; town?: string };
  website?: string;
  odsCode?: string;
  type?: string;
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

function mapStatus(registrationStatus: string): 'Active' | 'Inactive' {
  return registrationStatus === 'Registered' ? 'Active' : 'Inactive';
}

export class CQCResolver implements ProfessionResolver {
  readonly professionKind = 'gp-practice' as const;
  readonly jurisdictions: import('../types').Jurisdiction[] = ['england'];

  matches(identifier: string): boolean {
    return CQC_ID_RE.test(identifier) && !/^\d{6}$/.test(identifier);
  }

  async resolve(identifier: string): Promise<RegulatedEntityRecord | null> {
    const url = `https://api.cqc.org.uk/public/v1/providers/${encodeURIComponent(identifier)}${partnerCodeParam()}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CQC API error: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_REGISTRY_FETCH_BYTES) {
      throw new Error(`CQC response for ${identifier} exceeds size limit (${text.length} bytes)`);
    }
    const data = JSON.parse(text) as CQCResponse;

    // Spec §12 Q4: NHS ODS cross-check is display-only — surface as tag.
    const tags: string[] = [];
    if (data.odsCode) tags.push(`nhs-ods:${data.odsCode}`);
    if (data.type) tags.push(data.type);

    return {
      professionKind: 'gp-practice',
      jurisdiction: 'england',
      registry: 'CQC',
      identifier: data.providerId,
      identifierKind: 'CQC-ProviderID',
      name: data.name,
      status: mapStatus(data.registrationStatus),
      website: normaliseDomain(data.website),
      inferredCandidateWebsite: null,
      postcode: data.mainAddress?.postalCode ?? '',
      locality: data.mainAddress?.town ?? '',
      tags,
      fetchedAt: new Date().toISOString(),
    };
  }
}
