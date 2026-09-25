import type { SignetIdentity, ExtraPersona } from '../types/identity';
import type { DependantIdentity } from '../types/dependants';

/**
 * Pure key-strippers used after a Heartwood family-bunker enrolment
 * (§11.1.2) verifies that the device derived the SAME pubkeys the app
 * already has on file. Once verified, the app no longer needs the
 * corresponding private keys locally — the Heartwood device re-derives
 * them on demand via `heartwood_derive_persona`.
 *
 * `verifiedTokens` is the exact set of derivation tokens (the same
 * `EnrolmentSlot.token` values `buildEnrolmentPlan`/`enrolSlot` use —
 * `'natural-person'`, `'persona'`, `'professional'`, an extra's
 * `derivationName`, a dependant's `${derivationPath}-np`/`-persona`, or a
 * dep-extra's `derivationName`) that a Heartwood device round-tripped and
 * verified THIS RUN. It is an additional AND-filter on top of the
 * existing keep-rules below — a slot's privateKey is only ever emptied
 * when BOTH "this slot is tree-derived" AND "this slot's token verified"
 * hold. A slot that never verified (missing-pubkey, cross-device-merged
 * mid-ceremony, or simply not in a zero-slot/partial plan) keeps its
 * private key untouched, regardless of shape.
 *
 * Only TREE-DERIVED keys are ever eligible for stripping:
 * - Imported extras (`derivationName === ''`, `imported: true`) and
 *   mirror extras (`derivationName === ''`, not imported) did NOT come
 *   from the mnemonic tree — stripping their private key would make
 *   them unrecoverable. Left completely unchanged.
 * - Dependant transport keys (`bunkerEndpoint`, `appBunkerEndpoint`)
 *   are fresh per-device randomness, not tree-derived. Left untouched.
 * - Avatar/contact-avatar keys are device-local Blossom blob keys, not
 *   tree-derived. Left untouched (never referenced below, so spreads
 *   preserve them automatically).
 */

const DEPENDANT_PATH_RE = /^dependant-\d+$/;

/** After durable deletion succeeds, drop secrets from the existing objects too,
 * including nested objects retained by old render closures. This deliberately
 * mutates sensitive fields; immutable strings already copied elsewhere cannot
 * be zeroised by JavaScript. Never call before the rollback boundary. */
export function clearMigratedKeyReferences(identity: SignetIdentity, dependants: DependantIdentity[], verifiedTokens: ReadonlySet<string>): Set<string> {
  const removed = new Set<string>();
  const clearSlot = (old: { publicKey: string; privateKey: string }, next: { privateKey: string }) => {
    if (next.privateKey === '') {
      old.privateKey = '';
      removed.add(old.publicKey);
    }
  };
  const clearRecord = (old: SignetIdentity | DependantIdentity, next: SignetIdentity | DependantIdentity) => {
    clearSlot(old.naturalPerson, next.naturalPerson);
    clearSlot(old.persona, next.persona);
    old.extraPersonas?.forEach((extra, i) => clearSlot(extra, next.extraPersonas![i]));
  };
  const next = stripIdentityKeys(identity, verifiedTokens);
  identity.mnemonic = next.mnemonic;
  clearRecord(identity, next);
  if (identity.professionalPersona && next.professionalPersona) clearSlot(identity.professionalPersona, next.professionalPersona);
  for (const dep of dependants) {
    const stripped = stripDependantKeys(dep, verifiedTokens);
    if (stripped) clearRecord(dep, stripped);
  }
  return removed;
}

/** True when an extra-persona-shaped slot came from the mnemonic tree. */
function isTreeDerivedExtra(derivationName: string): boolean {
  return derivationName !== '';
}

function stripExtraPersona(extra: ExtraPersona, verifiedTokens: ReadonlySet<string>): ExtraPersona {
  if (!isTreeDerivedExtra(extra.derivationName)) return extra;
  if (!verifiedTokens.has(extra.derivationName)) return extra;
  return { ...extra, privateKey: '' };
}

/**
 * Strip everything the tree can re-derive AND that verified this run.
 * Keeps imported/mirror extras' keys — they are NOT tree-derived and
 * would be unrecoverable — and keeps any tree-derived slot whose token
 * is absent from `verifiedTokens`.
 */
export function stripIdentityKeys(identity: SignetIdentity, verifiedTokens: ReadonlySet<string>): SignetIdentity {
  return {
    ...identity,
    // Mnemonic re-derives every tree-derived slot, so it's only safe to
    // drop once at least one slot has actually verified against the
    // device — an empty set means nothing round-tripped, so nothing is
    // stripped, including the mnemonic.
    mnemonic: verifiedTokens.size > 0 ? '' : identity.mnemonic,
    naturalPerson: verifiedTokens.has('natural-person')
      ? { ...identity.naturalPerson, privateKey: '' }
      : identity.naturalPerson,
    persona: verifiedTokens.has('persona') ? { ...identity.persona, privateKey: '' } : identity.persona,
    professionalPersona: identity.professionalPersona
      ? (verifiedTokens.has('professional')
          ? { ...identity.professionalPersona, privateKey: '' }
          : identity.professionalPersona)
      : identity.professionalPersona,
    extraPersonas: identity.extraPersonas?.map((extra) => stripExtraPersona(extra, verifiedTokens)),
  };
}

/**
 * Returns the stripped record for a tree-derived dependant with at least
 * one verified token; returns null when either the dependant is imported
 * (derivationPath doesn't match `dependant-N`) OR none of its tokens
 * verified this run — in both cases leave the record untouched, do not
 * save. Fields whose own token didn't verify are left as-is even when
 * the dependant overall has SOME verified tokens (partial strip).
 */
export function stripDependantKeys(
  dep: DependantIdentity,
  verifiedTokens: ReadonlySet<string>,
): DependantIdentity | null {
  if (!DEPENDANT_PATH_RE.test(dep.derivationPath)) return null;

  const npToken = `${dep.derivationPath}-np`;
  const personaToken = `${dep.derivationPath}-persona`;
  const hasVerifiedExtra = (dep.extraPersonas ?? []).some(
    (extra) => isTreeDerivedExtra(extra.derivationName) && verifiedTokens.has(extra.derivationName),
  );
  const hasAnyVerified = verifiedTokens.has(npToken) || verifiedTokens.has(personaToken) || hasVerifiedExtra;
  if (!hasAnyVerified) return null;

  return {
    ...dep,
    naturalPerson: verifiedTokens.has(npToken) ? { ...dep.naturalPerson, privateKey: '' } : dep.naturalPerson,
    persona: verifiedTokens.has(personaToken) ? { ...dep.persona, privateKey: '' } : dep.persona,
    extraPersonas: dep.extraPersonas?.map((extra) => stripExtraPersona(extra, verifiedTokens)),
  };
}
