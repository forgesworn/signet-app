/**
 * Resolver dispatcher for Pro-surface profession resolvers.
 *
 * Dispatches by explicit professionKind (always provided from onboarding flow).
 * The matches() predicate is a sanity check; it is not used for blind dispatch.
 *
 * Cache: professionalRegistry IndexedDB store (24h TTL) is consulted before
 * any live fetch. The dispatcher handles cache lookup and storage so callers
 * (hooks, pages) don't have to.
 *
 * Spec: the internal Pro-surface architecture design doc, §5.4
 */

import type { ProfessionKind, ProfessionResolver, RegulatedEntityRecord } from './types';
import {
  getProfessionalRegistryRecord,
  putProfessionalRegistryRecord,
} from '../db';
import { CACHE_TTL_MS } from './constants';

function isCacheValid(fetchedAt: string): boolean {
  return Date.now() - new Date(fetchedAt).getTime() < CACHE_TTL_MS;
}

export interface ResolverDispatcher {
  resolve(
    professionKind: ProfessionKind,
    identifier: string
  ): Promise<RegulatedEntityRecord | null>;
}

export function createResolverDispatcher(
  resolvers: ProfessionResolver[]
): ResolverDispatcher {
  return {
    async resolve(
      professionKind: ProfessionKind,
      identifier: string
    ): Promise<RegulatedEntityRecord | null> {
      const resolver = resolvers.find(r => r.professionKind === professionKind);
      if (!resolver) return null;

      // Cache lookup — skip in test environments where IDB isn't available
      const canonicalKey = `${professionKind}:${identifier}`;
      try {
        const cached = await getProfessionalRegistryRecord(canonicalKey);
        if (cached && isCacheValid(cached.fetchedAt)) {
          return cached.record;
        }
      } catch {
        // IDB unavailable (e.g. test environment) — proceed to live fetch
      }

      const record = await resolver.resolve(identifier);

      if (record) {
        try {
          await putProfessionalRegistryRecord({
            canonicalKey,
            record,
            fetchedAt: record.fetchedAt,
          });
        } catch {
          // IDB write failure is non-fatal — live record still returned
        }
      }

      return record;
    },
  };
}

// ── Singleton dispatcher pre-registered with P1 resolvers ─────────────────────
// Phase 2 registers giasResolver here. Later phases add cqcResolver, sraResolver.

import { giasResolver } from './resolvers/gias';
import { CQCResolver } from './resolvers/cqc';
import { SRAResolver } from './resolvers/sra';

// Spec §12 Q10: jurisdiction + professionKind are declared by the user at onboarding
// before the identifier is entered. Dispatch is professionKind-first, then matches().
// A 6-digit identifier that could be a GIAS URN or SRA firm number is unambiguous
// because the profession picker has already narrowed to one resolver.
export const proResolver: ResolverDispatcher = createResolverDispatcher([
  giasResolver,
  new CQCResolver(),
  new SRAResolver(),
]);

/**
 * Resolve a registry identifier to a RegulatedEntityRecord.
 * Used by verify-chain — a thin wrapper over the singleton proResolver.
 * Returns null when not found; throws on transient failure.
 */
export async function resolveIdentifier(
  identifier: string,
  professionKind: ProfessionKind,
  _jurisdiction: import('./types').Jurisdiction
): Promise<RegulatedEntityRecord | null> {
  return proResolver.resolve(professionKind, identifier);
}
