/**
 * NIP-46 server-side primitives — pure helpers.
 *
 * Run alongside the bunker server loop (see `useBunkerServer.ts`). These
 * helpers do no I/O; they parse, validate, and shape the encrypted
 * envelope ↔ NIP-46 request / response conversions. The React hook
 * owns the WebSocket, the approval UI queue, and the IndexedDB writes.
 */

import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';

/**
 * Caps on inbound NIP-46 envelope size (security audit 2026-06-15). The
 * encrypted `content` arrives over the bunker-serve websocket from any relay
 * client; without a bound, a multi-megabyte frame forces a large NIP-44 decrypt
 * + JSON.parse per message (memory/CPU DoS on the signing device). 128 KB is
 * generous headroom over any realistic sign_event template / gift-wrap.
 */
export const MAX_NIP46_CONTENT = 128 * 1024;
/** Max params array length in a NIP-46 request (sign_event uses 1; nip44 uses 2). */
export const MAX_NIP46_PARAMS = 16;

/** A parsed NIP-46 inbound request. */
export interface InboundNIP46Request {
  /** Client-supplied request id, echoed back in the response. */
  id: string;
  /** Request method (sign_event, nip44_encrypt, etc.). */
  method: string;
  /** Raw string params; caller validates per-method shape. */
  params: string[];
  /** The client's (sender) pubkey — extracted from the envelope. */
  clientPubkey: string;
}

/**
 * Attempt to extract a NIP-46 request from a received kind-24133 event.
 * Returns null for anything that doesn't decrypt or doesn't parse as a
 * well-formed request.
 *
 * Safe to call with untrusted relay input — the NIP-44 decrypt + shape
 * checks are the gate. A relay forging a malformed envelope cannot do
 * more than make this return null.
 */
export async function parseInboundRequest(
  event: NostrEvent,
  backend: DecryptingSigningBackend,
): Promise<InboundNIP46Request | null> {
  if (event.kind !== 24133) return null;
  if (typeof event.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(event.pubkey)) {
    return null;
  }
  // Bound the encrypted payload BEFORE the expensive NIP-44 decrypt — an
  // oversized frame from a hostile relay/client must not be able to force a
  // large decrypt + parse (DoS). See MAX_NIP46_CONTENT.
  if (typeof event.content !== 'string' || event.content.length > MAX_NIP46_CONTENT) {
    return null;
  }

  // Decrypt the envelope content with the active backend's private key.
  let plaintext: string;
  try {
    plaintext = await backend.nip44Decrypt(event.pubkey, event.content);
  } catch {
    return null;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(plaintext); }
  catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64) return null;
  if (typeof p.method !== 'string' || p.method.length === 0 || p.method.length > 64) return null;
  if (!Array.isArray(p.params)) return null;
  if (p.params.length > MAX_NIP46_PARAMS) return null;
  if (!p.params.every((x): x is string => typeof x === 'string')) return null;

  return {
    id: p.id,
    method: p.method,
    params: p.params,
    clientPubkey: event.pubkey.toLowerCase(),
  };
}

/** Response envelope — matches NIP-46 spec. */
export interface NIP46Response {
  id: string;
  result?: string;
  error?: string;
}

/**
 * Build the signed kind-24133 response event that publishes back to
 * the client. The content is NIP-44-encrypted to `clientPubkey`.
 *
 * The caller publishes the returned event to the relay the client
 * specified in its nostrconnect://.
 */
export async function buildResponseEvent(
  response: NIP46Response,
  clientPubkey: string,
  backend: DecryptingSigningBackend,
): Promise<NostrEvent> {
  const encrypted = await backend.nip44Encrypt(clientPubkey, JSON.stringify(response));
  const template: UnsignedEvent = {
    kind: 24133,
    pubkey: backend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPubkey]],
    content: encrypted,
  };
  return backend.signEvent(template);
}

/**
 * Parse a sign_event request's first param into a validated event
 * template. Returns null when the payload isn't a plausible
 * UnsignedEvent.
 *
 * This is a belt-and-braces check — the backend's signEvent will
 * also validate — but we want a shape check before we prompt the
 * user, so the approval modal shows meaningful data.
 */
export function parseSignEventTemplate(raw: string): UnsignedEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  // Kind must be a non-negative integer within Nostr's documented range.
  // Rejects NaN, Infinity, negative numbers, and extreme future values that
  // could be used to bias scope inference or spam the audit log.
  if (typeof e.kind !== 'number' || !Number.isInteger(e.kind)) return null;
  if (e.kind < 0 || e.kind > 65535) return null;
  if (typeof e.content !== 'string') return null;
  // `created_at` must be a positive finite integer. Loose validation here;
  // the caller applies a stricter window check against wall-clock time
  // before prompting the user (see useBunkerServer handleInboundEvent).
  if (typeof e.created_at !== 'number' || !Number.isFinite(e.created_at) || e.created_at <= 0) return null;
  if (!Array.isArray(e.tags)) return null;
  for (const tag of e.tags) {
    if (!Array.isArray(tag)) return null;
    for (const t of tag) if (typeof t !== 'string') return null;
  }
  const pubkey = typeof e.pubkey === 'string' ? e.pubkey : '';
  return {
    kind: e.kind,
    pubkey,
    created_at: e.created_at,
    tags: e.tags as string[][],
    content: e.content,
  };
}

/** A short human-readable description of an event template for the approval modal. */
export function describeEventTemplate(template: UnsignedEvent): string {
  const kind = template.kind;
  // Well-known kinds get friendly labels; everything else falls back
  // to "kind N".
  const friendly = {
    0: 'profile update',
    1: 'note',
    3: 'contact list',
    4: 'encrypted DM',
    5: 'deletion',
    7: 'reaction',
    1059: 'gift-wrapped message',
    21235: 'venue entry',
    21236: 'sign-in challenge',
    24133: 'NIP-46 request',
    27235: 'NIP-98 HTTP auth',
    30078: 'app state',
    30470: 'identity credential',
  }[kind];
  return friendly ? `${friendly} (kind ${kind})` : `kind ${kind} event`;
}
