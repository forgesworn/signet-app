/**
 * Signet Credential Presentation Protocol
 *
 * Re-exports types and validation from signet-protocol.
 * Adds BroadcastChannel transport (browser-specific, stays in app).
 */

export {
  parseVerifyRequest,
  buildVerifyResponse,
  credentialSatisfiesRequest,
  VALID_AGE_RANGES,
} from 'signet-protocol';
export type { VerifyRequest, VerifyResponse } from 'signet-protocol';

import type { VerifyResponse } from 'signet-protocol';

/**
 * Send response via BroadcastChannel (same-device flow).
 * Browser-specific — not part of the protocol library.
 */
export function sendResponseViaBroadcast(response: VerifyResponse): void {
  const channel = new BroadcastChannel('signet-verify-' + response.requestId);
  channel.postMessage(response);
  channel.close();
}
