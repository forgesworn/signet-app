// Background roster-watch hook for promoting pending self-cert credentials.
// Spec: 2026-04-25-pro-surface-architecture-design.md §6.10.5

import { useCallback } from 'react';
import { fetchEvents } from '../lib/relay-service';
import { updateCredential } from '../lib/db';
import { PRO_ROLE_ANCHOR, PRO_ROSTER } from '../lib/professional/kinds';
import { verifiedAuthoredEvent } from '../lib/event-verify';
import type { StoredCredential } from '../types';

export interface PromotionCheckInput {
  issuerProPubkey: string;
  claimedFirm: string;
  claimedRole: string;
  anchorFound: boolean;
  /** All lead pubkeys from headPubkeys (normalised from signet.json). */
  leadPubkeys: string[];
  /** Member pubkeys collected from the union of all latest rosters. */
  rosterMemberPubkeys: string[];
  /** Delegate pubkeys collected from delegate tags across all latest rosters. */
  delegatePubkeys: string[];
  /** @deprecated Use leadPubkeys[0] instead. Kept for backward compat with existing tests. */
  headPubkey?: string | null;
}

/**
 * Pure eligibility check — exported for unit testing.
 * Returns 'confirmed' when all three conditions pass (spec §6.10.5 steps 3–6):
 *   1. A kind-30201 anchor exists for the claimed firm.
 *   2. That anchor has at least one lead pubkey (the lead is signed on-chain).
 *   3. The issuer's Pro persona pubkey appears in the member union across all rosters.
 * Otherwise returns 'pending'.
 *
 * Callers must NOT pass 'expired-pending' credentials here — filter to
 * verifierStatus === 'pending' before calling.
 */
export function checkPromotionEligibility(input: PromotionCheckInput): 'confirmed' | 'pending' {
  if (!input.anchorFound) return 'pending';
  // Support both leadPubkeys array (new) and headPubkey (legacy compat)
  const hasLead = (input.leadPubkeys && input.leadPubkeys.length > 0) ||
    (input.headPubkey != null && input.headPubkey !== '');
  if (!hasLead) return 'pending';
  if (!input.rosterMemberPubkeys.includes(input.issuerProPubkey)) return 'pending';
  return 'confirmed';
}

/**
 * useRosterWatch — runs on each unlock + on demand.
 * For each pending self-cert credential, queries the relay for the firm's
 * kind-30201 anchor and kind-30202 roster. Promotes to confirmed when the
 * chain is complete. Writes back to IDB.
 * Spec §6.10.5.
 *
 * Only promotes — never lapses. Lapse is handled by sweepLapsedCredentials
 * in useCredentials. Credentials with verifierStatus === 'expired-pending'
 * are explicitly skipped.
 */
export function useRosterWatch(
  proPersonaPubkey: string | null,
  credentials: StoredCredential[],
  encryptionKey: string | null,
  onCredentialUpdated: (updated: StoredCredential) => void,
) {
  const runPromotionCheck = useCallback(async () => {
    if (!proPersonaPubkey || !encryptionKey) return;

    // Only check pending self-cert credentials — skip confirmed and lapsed.
    const pending = credentials.filter(
      (c) => c.verifierStatus === 'pending' && c.pendingIssuedAt !== undefined,
    );
    if (pending.length === 0) return;

    for (const cred of pending) {
      let event: { tags: string[][] };
      try {
        event = JSON.parse(cred.event) as { tags: string[][] };
      } catch {
        continue;
      }
      const claimedFirm = event.tags.find(t => t[0] === 'claimed-firm')?.[1];
      const claimedRole = event.tags.find(t => t[0] === 'claimed-role')?.[1];
      if (!claimedFirm || !claimedRole) continue;

      // Step 3: fetch kind-30201 anchor events for this firm identifier.
      // The firm identifier is the d-tag value in role-anchor events.
      let leadPubkeys: string[] = [];
      let anchorFound = false;
      try {
        const anchors = await fetchEvents([{
          kinds: [PRO_ROLE_ANCHOR],
          '#d': [claimedFirm],
          limit: 1,
        }]);
        const anchor = anchors[0] ?? null;
        if (anchor) {
          anchorFound = true;
          const anchorTags = (anchor as unknown as { tags: string[][] }).tags;
          // Collect all head-pubkey tags (multi-lead support — spec §3.5.2).
          const headPubkeyTags = anchorTags
            .filter(t => t[0] === 'head-pubkey' && typeof t[1] === 'string')
            .map(t => t[1]);
          if (headPubkeyTags.length > 0) {
            leadPubkeys = headPubkeyTags;
          } else {
            // Also check content JSON for headPubkey (role-anchor.ts may put it there).
            try {
              const content = JSON.parse((anchor as unknown as { content: string }).content) as { headPubkey?: string; headPubkeys?: string[] };
              if (content.headPubkeys && content.headPubkeys.length > 0) {
                leadPubkeys = content.headPubkeys;
              } else if (content.headPubkey) {
                leadPubkeys = [content.headPubkey];
              }
            } catch {
              // Leave leadPubkeys empty.
            }
          }
        }
      } catch {
        // Relay unavailable — stay pending.
        continue;
      }

      // Step 5: for each lead, fetch their latest kind-30202 roster.
      // Collect member pubkeys and delegate pubkeys from the union of all rosters.
      let rosterMemberPubkeys: string[] = [];
      let delegatePubkeys: string[] = [];
      if (leadPubkeys.length > 0) {
        for (const lp of leadPubkeys) {
          try {
            const rosters = await fetchEvents([{
              kinds: [PRO_ROSTER],
              authors: [lp],
              '#d': [claimedFirm],
              limit: 1,
            }]);
            // Verify signature + author match — a hostile relay can return
            // arbitrary `pubkey` despite the `authors:` filter.
            const roster = verifiedAuthoredEvent(rosters[0] as unknown as { pubkey: string; sig: string; id: string } | undefined, lp);
            if (roster) {
              const rosterTags = (roster as unknown as { tags: string[][] }).tags;
              const pTagMembers = rosterTags
                .filter(t => t[0] === 'p')
                .map(t => t[1]);
              if (pTagMembers.length > 0) {
                rosterMemberPubkeys = [...new Set([...rosterMemberPubkeys, ...pTagMembers])];
              } else {
                try {
                  const content = JSON.parse((roster as unknown as { content: string }).content) as { members?: string[] };
                  const contentMembers = content.members ?? [];
                  rosterMemberPubkeys = [...new Set([...rosterMemberPubkeys, ...contentMembers])];
                } catch {
                  // Leave empty for this roster.
                }
              }
              // Collect delegate pubkeys from delegate tags (spec §3.5.3).
              const delegateTags = rosterTags
                .filter(t => t[0] === 'delegate' && typeof t[1] === 'string')
                .map(t => t[1]);
              delegatePubkeys = [...new Set([...delegatePubkeys, ...delegateTags])];
            }
          } catch {
            // Relay unavailable for this lead — continue; other leads may still have rosters.
          }
        }
      }

      const status = checkPromotionEligibility({
        issuerProPubkey: proPersonaPubkey,
        claimedFirm,
        claimedRole,
        anchorFound,
        leadPubkeys,
        rosterMemberPubkeys,
        delegatePubkeys,
      });

      if (status === 'confirmed') {
        const updated: StoredCredential = {
          ...cred,
          verifierStatus: 'confirmed',
          confirmationAt: Math.floor(Date.now() / 1000),
        };
        await updateCredential(updated, encryptionKey);
        onCredentialUpdated(updated);
      }
      // If 'pending': no write-back — roster watch only promotes, never lapses.
    }
  }, [proPersonaPubkey, credentials, encryptionKey, onCredentialUpdated]);

  return { runPromotionCheck };
}
