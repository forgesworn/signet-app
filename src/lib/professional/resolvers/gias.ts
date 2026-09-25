/**
 * GIAS resolver — England & Wales schools.
 * Source: dfe-digital.github.io/gias-data/schools/<URN>.json
 * Upstream refresh: daily. Client TTL: 24h (enforced by caller/dispatcher).
 *
 * Spec: the internal Pro-surface architecture design doc, §5.3
 */

import type { ProfessionResolver, RegulatedEntityRecord } from '../types';
import { normaliseHost } from '../signet-json';
import { MAX_REGISTRY_FETCH_BYTES } from '../constants';

const GIAS_BASE = 'https://dfe-digital.github.io/gias-data/schools';

/** Strip protocol and www. from a website URL; return bare hostname or null. */
function normWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return normaliseHost(url.hostname);
  } catch {
    return null;
  }
}

export const giasResolver: ProfessionResolver = {
  professionKind: 'school',
  jurisdictions: ['england-wales', 'england', 'wales'],

  /**
   * A GIAS URN is exactly 6 digits.
   * Note: 6-digit SRA firm numbers also match — disambiguation is handled
   * at the profession-declare level in onboarding, not here.
   */
  matches(identifier: string): boolean {
    return /^\d{6}$/.test(identifier);
  },

  async resolve(identifier: string): Promise<RegulatedEntityRecord | null> {
    const url = `${GIAS_BASE}/${identifier}.json`;
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GIAS fetch failed for URN ${identifier}: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (text.length > MAX_REGISTRY_FETCH_BYTES) {
      throw new Error(`GIAS response for URN ${identifier} exceeds size limit (${text.length} bytes)`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = JSON.parse(text) as Record<string, any>;

    const status: string =
      typeof data['establishmentStatus'] === 'object' && data['establishmentStatus'] !== null
        ? String(data['establishmentStatus']['name'] ?? 'Unknown')
        : 'Unknown';

    const phase: string =
      typeof data['phaseOfEducation'] === 'object' && data['phaseOfEducation'] !== null
        ? String(data['phaseOfEducation']['name'] ?? '')
        : '';

    const tags: string[] = [];
    if (phase) tags.push(phase);
    if (typeof data['typeOfEstablishment'] === 'object' && data['typeOfEstablishment'] !== null) {
      const t = String(data['typeOfEstablishment']['name'] ?? '');
      if (t) tags.push(t);
    }

    return {
      professionKind: 'school',
      jurisdiction: 'england-wales',
      registry: 'GIAS',
      identifier,
      identifierKind: 'URN',
      name: String(data['establishmentName'] ?? ''),
      status,
      website: normWebsite(data['website']),
      inferredCandidateWebsite: null,
      postcode: String(data['postcode'] ?? ''),
      locality: String(data['town'] ?? ''),
      tags,
      fetchedAt: new Date().toISOString(),
    };
  },
};
