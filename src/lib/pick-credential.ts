/**
 * Chooses the single StoredCredential that should be presented in
 * response to an incoming VerifyRequest.
 *
 * Filters out expired, revoked, unparseable, and request-unsatisfying
 * credentials. Among survivors, prefers persona → natural-person,
 * then higher tier, then newer `verifiedAt`.
 */

import { credentialSatisfiesRequest } from 'signet-protocol';
import type { LoginRequest, VerifyRequest } from 'signet-protocol';
import type { StoredCredential } from '../types';

export interface ParsedCredentialEvent {
  id: string;
  kind: number;
  tags: string[][];
  content: string;
  pubkey: string;
  sig: string;
  created_at: number;
}

const VALID_AGE_RANGES = new Set(['0-3', '4-7', '8-12', '13-17', '18+']);

export function parseStoredCredentialEvent(cred: StoredCredential): ParsedCredentialEvent | null {
  try {
    const obj: unknown = JSON.parse(cred.event);
    if (typeof obj !== 'object' || obj === null) return null;
    const e = obj as Record<string, unknown>;
    return {
      id: typeof e.id === 'string' ? e.id : cred.id,
      kind: typeof e.kind === 'number' ? e.kind : 30470,
      tags: Array.isArray(e.tags) ? (e.tags as string[][]) : [],
      content: typeof e.content === 'string' ? e.content : '',
      pubkey: typeof e.pubkey === 'string' ? e.pubkey : '',
      sig: typeof e.sig === 'string' ? e.sig : '',
      created_at: typeof e.created_at === 'number' ? e.created_at : cred.verifiedAt,
    };
  } catch {
    return null;
  }
}

function tierValue(tags: string[][]): number {
  const raw = tags.find(t => t[0] === 'tier')?.[1];
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export function pickCredential(
  credentials: StoredCredential[],
  request: VerifyRequest,
  nowSeconds: number,
): StoredCredential | null {
  interface Candidate {
    cred: StoredCredential;
    tier: number;
  }
  const candidates: Candidate[] = [];
  for (const cred of credentials) {
    if (cred.revokedAt !== undefined) continue;
    if (cred.expiresAt !== undefined && cred.expiresAt < nowSeconds) continue;
    const parsed = parseStoredCredentialEvent(cred);
    if (!parsed) continue;
    if (!credentialSatisfiesRequest(parsed.tags, request.requiredAgeRange, parsed.content, parsed.pubkey)) continue;
    candidates.push({ cred, tier: tierValue(parsed.tags) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const personaRankA = a.cred.keypairType === 'persona' ? 0 : 1;
    const personaRankB = b.cred.keypairType === 'persona' ? 0 : 1;
    if (personaRankA !== personaRankB) return personaRankA - personaRankB;
    if (a.tier !== b.tier) return b.tier - a.tier;
    return b.cred.verifiedAt - a.cred.verifiedAt;
  });
  return candidates[0].cred;
}

export function pickCredentialForSubject(
  credentials: StoredCredential[],
  request: Pick<LoginRequest, 'requiredAgeRange'>,
  subjectPubkey: string,
  nowSeconds: number,
): StoredCredential | null {
  if (!/^[0-9a-f]{64}$/i.test(subjectPubkey)) return null;
  const target = subjectPubkey.toLowerCase();
  const candidates: Array<{ cred: StoredCredential; tier: number }> = [];
  for (const cred of credentials) {
    if (cred.revokedAt !== undefined) continue;
    if (cred.expiresAt !== undefined && cred.expiresAt < nowSeconds) continue;
    const parsed = parseStoredCredentialEvent(cred);
    if (!parsed || parsed.pubkey.toLowerCase() !== target) continue;
    const requiredAgeRange = request.requiredAgeRange;
    if (
      typeof requiredAgeRange === 'string'
      && VALID_AGE_RANGES.has(requiredAgeRange)
      && !credentialSatisfiesRequest(parsed.tags, requiredAgeRange, parsed.content, target)
    ) {
      continue;
    }
    candidates.push({ cred, tier: tierValue(parsed.tags) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    return b.cred.verifiedAt - a.cred.verifiedAt;
  });
  return candidates[0].cred;
}
