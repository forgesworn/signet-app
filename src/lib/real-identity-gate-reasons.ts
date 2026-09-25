/**
 * Reason lines for the `RequireRealIdentity` interstitial when the gated
 * feature belongs to a DEPENDANT rather than the owner (spec §7.3, §7.6).
 *
 * Pure so the wording is pinned by a test. The owner's lines stay inline in
 * App.tsx — they predate this and did not need naming.
 */
export function dependantGateReason(
  feature: 'get-verified' | 'venue-entry',
  dependantName: string,
): string {
  switch (feature) {
    case 'get-verified':
      return `Getting verified attaches ${dependantName}’s legal name to their Signet, so it needs their real identity.`;
    case 'venue-entry':
      return `A venue reads ${dependantName}’s legal name at the door, so venue entry needs their real identity.`;
  }
}
