import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
/** A peer chooses its wire request ID; it cannot choose a cross-identity storage key. */
export function contactExchangeKey(request: { id: string; from: string; to: string }): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
    'signet:contact-exchange-storage:v1', request.from, request.to, request.id,
  ])))).slice(0, 32);
}
