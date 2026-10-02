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

/**
 * Whether a NIP-46 `error` string from the signer is its VERDICT on the
 * request (denied, card timed out, not authorised for this client, busy, or
 * must be approved at the device) rather than an operational failure. The
 * Heartwood sends only the message on the wire, never the code, so this
 * matches its refusal strings (heartwood-esp32 `nip46_handler.rs` / `relay.rs`
 * / `escalate.rs`). Everything else — "decryption failed", "signing failed",
 * "bad event format", "unknown method", "…; send the request again" — is NOT
 * a refusal: it keeps the normal backoff rather than stopping every vault job
 * for the unlock behind a "hasn't approved" line that would not be true.
 */
export function isSignerRefusalMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const m = message.trim().toLowerCase();
  return m === 'user denied' || m === 'timeout' || m === 'unauthorised' || m === 'unauthorized'
    || m.startsWith('signer is busy') || m.includes('must be approved at the device');
}

export function isVaultApprovalError(err: unknown): boolean {
  return err instanceof Error && (err as { vaultApproval?: unknown }).vaultApproval === true;
}

/** The one quiet line App shows once usePrivateVaults reports `needsApproval`. */
export const PRIVATE_VAULT_NEEDS_APPROVAL_COPY = "Your Heartwood hasn't approved private backups yet.";
/** Re-runs the backup jobs once; the user should expect cards on the device. */
export const PRIVATE_VAULT_APPROVE_LABEL = 'Approve on Heartwood';
export const PRIVATE_VAULT_APPROVAL_DISMISS_LABEL = 'Dismiss';
