/**
 * Contacts v2 app grants — same-app, same-directory supersede.
 *
 * When an app is approved a fresh grant on a directory it already holds an
 * ACTIVE grant on, the old grant(s) are disconnected once the new grant's
 * pairing code is confirmed (see `handleApproveContactsGrantV2` /
 * `applyContactsGrantCodeExit` in App.tsx). This module holds the one pure
 * decision — which existing grant ids a new approval would replace — so the
 * cap check and the code-exit teardown both read the same rule.
 *
 * Pure: no React, storage or clock.
 */
import type { AppGrantV2 } from '../types';

/** The picker's key for one directory choice: a directory plus the identity
 *  (persona) that owns it, since one `'owner'` directory can be offered once
 *  per persona. Shared by the approve screen and App so both key alike. */
export function grantOptionKey(target: { directoryId: string; ownerIdentityPubkey?: string }): string {
  return `${target.directoryId}/${(target.ownerIdentityPubkey ?? '').toLowerCase()}`;
}

/**
 * Grant ids that are ACTIVE (not revoked), on the same directory AND owner
 * identity as `target` (approving an app for persona B must never touch its
 * grant for persona A), belong to the same `appPubkey` (compared
 * case-insensitively — pubkeys are hex and case carries no meaning), and are
 * not `excludeGrantId` itself (the grant being approved).
 */
export function supersededGrantIds(
  grants: readonly AppGrantV2[],
  appPubkey: string,
  target: { directoryId: string; ownerIdentityPubkey?: string },
  excludeGrantId?: string,
): string[] {
  const targetApp = appPubkey.toLowerCase();
  const targetKey = grantOptionKey(target);
  return grants
    .filter((g) => (
      !g.revokedAt
      && grantOptionKey(g) === targetKey
      && g.appPubkey.toLowerCase() === targetApp
      && g.grantId !== excludeGrantId
    ))
    .map((g) => g.grantId);
}
