/**
 * Plain wording for the raw strings a remote signer (a Heartwood over NIP-46)
 * hands back when it will not, or cannot yet, answer. The approval screens
 * used to show these verbatim, so a child whose Heartwood was holding the
 * one-time on-board press saw a bare red "timeout".
 *
 * Anything not recognised passes through unchanged: a message that is already
 * a sentence written for the user must never be rewritten.
 */
export const SIGNER_TIMEOUT_COPY =
  "Your family's Heartwood didn't answer in time. If it's showing a card, press its button, then try again.";
export const SIGNER_DENIED_COPY = 'Your Heartwood turned that down, so nothing was signed.';
export const SIGNER_BUSY_COPY = 'Your Heartwood is busy with another request. Give it a moment, then try again.';
export const SIGNER_NEEDS_DEVICE_COPY = 'This needs approving on your Heartwood first. Press its button, then try again.';

/** The message `BunkerRequestTimeoutError` carries: `<method> timed out`. */
const OWN_TIMEOUT = /^[a-z0-9_]+ timed out$/i;

export function friendlySignerMessage(message: string): string {
  const m = message.trim().toLowerCase();
  if (m === 'timeout' || OWN_TIMEOUT.test(m)) return SIGNER_TIMEOUT_COPY;
  if (m === 'user denied') return SIGNER_DENIED_COPY;
  if (m.startsWith('signer is busy')) return SIGNER_BUSY_COPY;
  if (m.includes('must be approved at the device')) return SIGNER_NEEDS_DEVICE_COPY;
  return message;
}

/** Message for an approval that threw: `Error.message` mapped, else the caller's fallback. */
export function friendlyApprovalError(e: unknown): string {
  if (e instanceof Error) return friendlySignerMessage(e.message);
  if (e == null) return 'Failed to approve — please try again';
  return friendlySignerMessage('Failed to approve: ' + String(e));
}
