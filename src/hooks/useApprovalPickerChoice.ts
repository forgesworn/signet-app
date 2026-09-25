import { useEffect, useState } from 'react';
import type { SignetIdentity } from '../types';
import { buildGuardianKeypairOptions } from '../lib/auth-selection';
import type { KeypairOption } from '../lib/keypair-policy';
import { ROUTED_APPROVAL_WAIT_MS } from '../lib/await-routed-backend';

/** Shown on a chosen slot whose key is on the paired signer while its route is not back yet. */
export const WAITING_FOR_SIGNER_COPY = 'Waiting for your Heartwood…';
/** Shown once a chosen slot has stayed absent past the bounded wait (gone, or the signer cannot route it). */
export const CHOSEN_UNAVAILABLE_COPY = "This identity isn't available right now. Pick another to continue.";

type GuardianOrDependantSelection =
  | { source: 'guardian'; keypairType: string }
  | { source: 'dependant'; dependantId: string; keypairType: string };

/**
 * One rule for every approval picker (sign-in and NIP-46 connect):
 *
 * - Before the user touches the picker the resolver's default applies, and
 *   follows the list as it settles.
 * - Once they pick, their choice is final. App holds it per request
 *   (`userChoice`), so it survives the remount a lock causes, and no default
 *   or transient list change may swap it for another identity.
 * - A chosen guardian slot that is waiting (its route is not back) or absent
 *   from the list stays chosen and blocks Approve. An absent one reads as
 *   "waiting" for the bounded window, then as plainly unavailable.
 */
export function useApprovalPickerChoice<S extends GuardianOrDependantSelection>(o: {
  identity: SignetIdentity;
  resolvedDefault: S | null;
  /** Keys of the guardian options currently offered (after every filter). */
  offeredGuardianKeys: readonly string[];
  /** Guardian options before the availability/consumer filters, for labelling a missing choice. */
  guardianOptions: readonly KeypairOption[];
  resolvePubkey: (selection: S | null) => string | null;
  userChoice?: { selection: S | null };
  onUserChoice?: (selection: S | null) => void;
  waitingGuardianPubkeys?: readonly string[];
}) {
  const [localChoice, setLocalChoice] = useState<{ selection: S | null } | undefined>(o.userChoice);
  // The prop seeds a remounted page; a pick made here wins from then on.
  const choice = localChoice ?? o.userChoice;
  const selection: S | null = choice ? choice.selection : o.resolvedDefault;
  const setSelection = (next: S | null) => {
    setLocalChoice({ selection: next });
    o.onUserChoice?.(next);
  };

  const guardianKey = selection?.source === 'guardian' ? selection.keypairType : null;
  const chosenGuardianMissing = !!choice
    && guardianKey !== null
    && guardianKey !== 'natural-person'
    && !o.offeredGuardianKeys.includes(guardianKey);

  // Bounded "waiting" for a chosen slot that is absent from the list.
  const [missingLapsedKey, setMissingLapsedKey] = useState<string | null>(null);
  useEffect(() => {
    // Every time the chosen slot comes back or the choice changes, the next
    // absence starts a fresh window — it never inherits an old lapse.
    setMissingLapsedKey(null);
    if (!chosenGuardianMissing || !guardianKey) return;
    const timer = setTimeout(() => setMissingLapsedKey(guardianKey), ROUTED_APPROVAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [chosenGuardianMissing, guardianKey]);
  const missingLapsed = chosenGuardianMissing && missingLapsedKey === guardianKey;

  const selectedGuardianPubkey = guardianKey !== null ? o.resolvePubkey(selection) : null;
  const isWaitingPubkey = (pubkey: string) => !!o.waitingGuardianPubkeys?.includes(pubkey);
  const selectionWaiting = guardianKey !== null && (
    chosenGuardianMissing || (!!selectedGuardianPubkey && isWaitingPubkey(selectedGuardianPubkey))
  );
  const missingChosenOption: KeypairOption | null = chosenGuardianMissing && guardianKey
    ? o.guardianOptions.find(opt => opt.key === guardianKey)
      ?? buildGuardianKeypairOptions(o.identity).find(opt => opt.key === guardianKey)
      ?? null
    : null;

  return {
    selection,
    setSelection,
    /** Approve must stay disabled while true. */
    selectionWaiting,
    isWaitingPubkey,
    missingChosenOption,
    /** Copy for the missing chosen row. */
    missingChosenCopy: missingLapsed ? CHOSEN_UNAVAILABLE_COPY : WAITING_FOR_SIGNER_COPY,
  };
}
