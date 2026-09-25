// Cold-start sub-role self-cert event builder and lapse check.
// Spec: 2026-04-25-pro-surface-architecture-design.md §6.10.4, §6.10.6
// State machine spec: 2026-03-25-signet-iq-redesign-spec.md (Credential States)

import { PRO_CREDENTIAL } from './kinds';

/** Lapse window in days — canonical per §6.10.6. */
export const SELF_CERT_LAPSE_DAYS = 30;

/**
 * Sub-role tokens that MAY self-cert. Lead roles are explicitly absent.
 * Spec §6.10.2.
 */
export const SUB_ROLE_TOKENS = [
  'form-tutor',
  'class-teacher',
  'nqt',
  'practice-gp',
  'nurse',
  'associate',
  'paralegal',
  'trainee-solicitor',
] as const;

export type SubRoleToken = typeof SUB_ROLE_TOKENS[number];

export interface SelfCertParams {
  recipientPubkey: string;
  credentialType: string;
  claimedFirm: string;
  claimedFirmKind: string;
  claimedRole: SubRoleToken;
  /** Unix seconds — stamped once at issuance; lapse clock. */
  pendingIssuedAt: number;
}

/**
 * Build a kind-29999 EventTemplate for a self-cert credential.
 * The event is unsigned — the caller signs it via the Pro persona backend.
 * Spec §6.10.4.
 */
export function buildSelfCertCredentialEvent(params: SelfCertParams): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: PRO_CREDENTIAL,
    created_at: params.pendingIssuedAt,
    tags: [
      ['p', params.recipientPubkey],
      ['credential-type', params.credentialType],
      ['self-cert', 'true'],
      ['claimed-firm', params.claimedFirm],
      ['claimed-firm-kind', params.claimedFirmKind],
      ['claimed-role', params.claimedRole],
      ['pending-issued-at', String(params.pendingIssuedAt)],
    ],
    content: '',
  };
}

/**
 * Compute whether a pending credential has lapsed.
 * Returns 'pending' or 'expired-pending'.
 * Input: pendingIssuedAt (unix seconds), nowMs (Date.now() in ms).
 * Spec §6.10.6.
 */
export function computeLapseStatus(
  pendingIssuedAt: number,
  nowMs: number,
): 'pending' | 'expired-pending' {
  const daysElapsed = (nowMs / 1000 - pendingIssuedAt) / 86400;
  return daysElapsed >= SELF_CERT_LAPSE_DAYS ? 'expired-pending' : 'pending';
}
