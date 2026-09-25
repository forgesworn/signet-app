import type { DependantIdentity } from '../types';
import { sanitizeDisplayName } from './text-sanitize';

/**
 * Build a NEWLY tree-derived, persona-first dependant record (spec §7.6).
 *
 * The entered name names the child's FIRST PERSONA; the Natural Person slot is
 * derived and stored but left unnamed and dormant. `id` is therefore the
 * persona pubkey — every surface that keys on `id` (paired-child record, audit
 * `d` tag, add-dependant callback, child settings, policy-compiler slot map,
 * bunker routes) binds to the persona while the real identity sleeps, which is
 * the same protection §8 already gives the owner.
 *
 * Both keys are retained; the derivation tokens are unchanged, so a later
 * Heartwood re-enrolment of `dependant-N-np` / `dependant-N-persona` is an
 * idempotent no-op. Pure — the caller supplies the derived keypairs from either
 * the guardian mnemonic or the device derive.
 *
 * Imported dependants do NOT come through here: `importDependant` keeps its
 * NP-keyed `id` and its `natural-person` primary, and lifts to active.
 *
 * `enteredName` is sanitised and capped at 100 chars here, matching every other
 * dependant-name write path (`addDependant`, `updateDependantPersonaName`,
 * `activateDependantNaturalPerson`) so a control/bidi character cannot enter the
 * record through this door alone.
 */
export function buildPersonaFirstDependant(args: {
  guardianPubkey: string;
  enteredName: string;
  dateOfBirth?: string;
  derivationPath: string;
  naturalPerson: { publicKey: string; privateKey: string };
  persona: { publicKey: string; privateKey: string };
  createdAt: number;
}): DependantIdentity {
  const name = sanitizeDisplayName(args.enteredName, 100);
  return {
    id: args.persona.publicKey,
    guardianPubkey: args.guardianPubkey,
    displayName: name,
    dateOfBirth: args.dateOfBirth,
    naturalPerson: { ...args.naturalPerson, displayName: '' },
    persona: { ...args.persona, displayName: name },
    derivationPath: args.derivationPath,
    createdAt: args.createdAt,
    autonomyStage: 'full-control',
    primaryKeypair: 'persona',
    naturalPersonActive: false,
  };
}
