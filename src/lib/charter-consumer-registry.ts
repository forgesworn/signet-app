/**
 * Charter consumer registry — Phase 1 (alpha).
 *
 * A static map of `consumer-name → app-pubkey` used as the NIP-44 recipient
 * when a parent publishes a Charter clause (kind 31000) to a consumer's
 * relays. The consumer's app keypair is bundle-embedded on the consumer
 * side (a public-shaped secret per the spec — clause content is parental
 * schedule data, not high-entropy secrets) and persistent across the
 * lifetime of that bundle release.
 *
 * Spec: the internal charter-schedule-clause spec
 * §"Discovery — how signet-app learns the consumer's app pubkey (P1)" —
 * "A static map `consumer-name → app-pubkey` lives in signet-app source
 * (`src/lib/charter-consumer-registry.ts` or similar). AxeNStax-only in
 * alpha; adding a second consumer is a code change. Cheap, doesn't
 * generalise, sufficient for P1."
 *
 * Discovery for second-and-later consumers (manifest event / URL-auth
 * echo-back / Forgesworn-controlled registry) is grant-fundable phase
 * work — pick when there's a real second consumer driving the
 * requirement.
 *
 * Rotation: if a consumer's app private key leaks, the consumer publishes
 * a new keypair (new bundle release) and the entry below is updated.
 * Existing kind-31000 events remain encrypted to the old key and become
 * unreadable to the new key — parents republish their clauses to the
 * new pubkey. Rare event; acceptable cost.
 */

/** A registered Charter consumer's app keypair entry. */
export interface CharterConsumer {
  /** Stable identifier (human-readable, used as the registry key). */
  name: string;
  /** Display label (UI surface text — may diverge from `name`). */
  label: string;
  /** Consumer's app pubkey (lowercase hex, NIP-44 recipient). */
  pubkey: string;
}

/**
 * Phase 1 registry. AxeNStax-only in alpha. Adding a second consumer is
 * a code change to this file.
 *
 * Provenance for each entry should reference the consumer-side document
 * that records key generation, persistence rationale, and the rotation
 * procedure.
 */
export const CHARTER_CONSUMERS: readonly CharterConsumer[] = [
  {
    name: 'axenstax',
    label: 'AxeNStax (alpha)',
    // Provenance: AxeNStax repo at
    // `docs/integrations/signet/2026-05-09-charter-app-keypair.md`.
    // npub: npub1hu2m2hnnqgydcls5nwdhnyyv3kqavaw8g5rrcqsykepgmrrrn8qsrldfl4
    pubkey: 'bf15b55e730208dc7e149b9b79908c8d81d675c745063c0204b6428d8c6399c1',
  },
] as const;

/** Look up a registered consumer by its stable name. */
export function getCharterConsumer(name: string): CharterConsumer | null {
  return CHARTER_CONSUMERS.find((c) => c.name === name) ?? null;
}

/**
 * Reverse lookup — given an inbound event's `pubkey` (the recipient on a
 * publish, or the sender on a self-report), return the registered
 * consumer if one matches. Hex comparison is case-insensitive.
 */
export function getCharterConsumerByPubkey(pubkey: string): CharterConsumer | null {
  const lc = pubkey.toLowerCase();
  return CHARTER_CONSUMERS.find((c) => c.pubkey === lc) ?? null;
}

/** Quick membership check — useful when filtering inbound events. */
export function isRegisteredCharterConsumer(pubkey: string): boolean {
  return getCharterConsumerByPubkey(pubkey) !== null;
}
