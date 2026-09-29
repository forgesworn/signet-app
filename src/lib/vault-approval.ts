/**
 * A vault request the signer ANSWERED with a refusal: denied on the device,
 * its approval card timed out, the device was busy (too many cards waiting),
 * or it asked for an out-of-band approval. Distinct from a transport failure
 * (relay unreachable, no reply at all), which is worth retrying on a timer —
 * retrying a refusal only puts the same card back up, so usePrivateVaults
 * stops and waits for the user instead.
 *
 * Kept out of heartwood-vault.ts so the hook can recognise it without pulling
 * that lazily loaded module into the main bundle.
 */
export class VaultApprovalError extends Error {
  readonly vaultApproval = true as const;
}

export function isVaultApprovalError(err: unknown): boolean {
  return err instanceof Error && (err as { vaultApproval?: unknown }).vaultApproval === true;
}

/** The one quiet line App shows once usePrivateVaults reports `needsApproval`. */
export const PRIVATE_VAULT_NEEDS_APPROVAL_COPY = "Your Heartwood hasn't approved private backups yet.";
/** Re-runs the backup jobs once; the user should expect cards on the device. */
export const PRIVATE_VAULT_APPROVE_LABEL = 'Approve on Heartwood';
export const PRIVATE_VAULT_APPROVAL_DISMISS_LABEL = 'Dismiss';
