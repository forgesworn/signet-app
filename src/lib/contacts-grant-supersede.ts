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

/**
 * Grant ids on `directoryId` that are ACTIVE (not revoked), belong to the
 * same `appPubkey` (compared case-insensitively — pubkeys are hex and case
 * carries no meaning), and are not `excludeGrantId` itself (the grant being
 * approved, so a re-check after minting never supersedes its own row).
 */
export function supersededGrantIds(
  grants: readonly AppGrantV2[],
  appPubkey: string,
  directoryId: string,
  excludeGrantId?: string,
): string[] {
  const targetApp = appPubkey.toLowerCase();
  return grants
    .filter((g) => (
      !g.revokedAt
      && g.directoryId === directoryId
      && g.appPubkey.toLowerCase() === targetApp
      && g.grantId !== excludeGrantId
    ))
    .map((g) => g.grantId);
}
