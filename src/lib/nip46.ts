/**
 * NIP-46 Remote Signer for MySignet
 *
 * Handles signing requests from websites via Nostr relay.
 * The app listens for requests, prompts the user, signs with their key.
 */

import { RelayClient } from 'signet-protocol';
import type { UnsignedEvent } from 'signet-protocol';
import type { SigningBackend } from './signing-backend';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  getConversationKey,
  encrypt as nip44EncryptRaw,
  decrypt as nip44DecryptRaw,
} from 'nostr-tools/nip44';
import { sanitizeDisplayName } from './text-sanitize';
import { MAX_NIP46_CONTENT, MAX_NIP46_PARAMS } from './nip46-server';
import { isValidRelayUrl } from './relay-url';
import type { ConnectedClient } from '../types';

/**
 * Input bounds for untrusted nostrconnect:// parsing (security audit
 * 2026-06-15). A genuine URI is short; oversized values are parse-time DoS.
 */
const MAX_NOSTRCONNECT_URI_LEN = 8192;
const MAX_METADATA_JSON_LEN = 4096;

/**
 * NIP-44 v2 encrypt — delegates to the tested nostr-tools implementation.
 * Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
 */
export async function nip44Encrypt(privateKey: string, theirPubkey: string, plaintext: string): Promise<string> {
  const privBytes = hexToBytes(privateKey);
  try {
    // Derive conversation key via ECDH + HKDF-SHA256 ("nip44-v2" salt)
    const conversationKey = getConversationKey(privBytes, theirPubkey);
    return nip44EncryptRaw(plaintext, conversationKey);
  } finally {
    // Zeroize private key bytes from memory
    privBytes.fill(0);
  }
}

/**
 * NIP-44 v2 decrypt — delegates to the tested nostr-tools implementation.
 * The private-key bytes are zeroised after use.
 */
export async function nip44Decrypt(privateKey: string, theirPubkey: string, ciphertext: string): Promise<string> {
  const privBytes = hexToBytes(privateKey);
  try {
    const conversationKey = getConversationKey(privBytes, theirPubkey);
    return nip44DecryptRaw(ciphertext, conversationKey);
  } finally {
    privBytes.fill(0);
  }
}

export interface NIP46Request {
  id: string;
  method: string;
  params: string[];
}

export interface NIP46Response {
  id: string;
  result?: string;
  error?: string;
}

export interface SigningRequest {
  id: string;
  method: string;
  origin: string;
  params: string[];
  timestamp: number;
}

export interface NostrConnectRequest {
  clientPubkey: string;    // ephemeral pubkey from the website (64-char hex)
  relayUrl: string;        // relay to respond through
  relayUrls: string[];      // ordered, valid relay candidates from the URI
  secret: string;          // one-time secret echoed back to complete nostrconnect pairing
  appName: string;         // from metadata.name
  appUrl?: string;         // from metadata.url
}

/** Build the persisted owner-route client record created by explicit NostrConnect approval. */
export function buildConnectedClientFromNostrConnect(
  request: NostrConnectRequest,
  nowS = Math.floor(Date.now() / 1000),
): ConnectedClient {
  return {
    clientPubkey: request.clientPubkey.toLowerCase(),
    appName: request.appName,
    appUrl: request.appUrl,
    connectedAt: nowS,
    lastSeenAt: nowS,
    allowAlways: true,
  };
}

/**
 * Parse a NIP-46 request from an encrypted event content
 */
export function parseNIP46Request(content: string): NIP46Request | null {
  // Bound the payload before JSON.parse — content arrives from a relay and an
  // oversized blob is a parse-time DoS (security audit 2026-06-15).
  if (typeof content !== 'string' || content.length > MAX_NIP46_CONTENT) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.method !== 'string' || !Array.isArray(obj.params)) return null;
    if (obj.params.length > MAX_NIP46_PARAMS) return null;
    if (!obj.params.every((p: unknown) => typeof p === 'string')) return null;
    return { id: obj.id, method: obj.method, params: obj.params as string[] };
  } catch {
    return null;
  }
}

/**
 * Build a NIP-46 response
 */
export function buildNIP46Response(id: string, result?: string, error?: string): string {
  const response: NIP46Response = { id };
  if (result !== undefined) response.result = result;
  if (error !== undefined) response.error = error;
  return JSON.stringify(response);
}

/**
 * Supported NIP-46 methods
 */
export const SUPPORTED_METHODS = [
  'connect',
  'get_public_key',
  'sign_event',
  'ping',
  'switch_relays',
  'logout',
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
] as const;

export type SupportedMethod = typeof SUPPORTED_METHODS[number];

export function isSupportedMethod(method: string): method is SupportedMethod {
  return (SUPPORTED_METHODS as readonly string[]).includes(method);
}

/** Parse a nostrconnect:// URI into a structured request */
export function parseNostrConnectURI(uri: string): NostrConnectRequest | null {
  // Bound the whole URI before any parsing — it arrives from a URL param /
  // relay and an oversized value is a parse-time DoS (security audit
  // 2026-06-15). A real nostrconnect URI is short (pubkey + relay + metadata).
  if (typeof uri !== 'string' || uri.length > MAX_NOSTRCONNECT_URI_LEN) return null;
  if (!uri.startsWith('nostrconnect://')) return null;
  try {
    // Replace scheme so URL parser can handle it
    const url = new URL(uri.replace('nostrconnect://', 'https://'));
    const clientPubkey = url.hostname;
    const relayUrls = url.searchParams.getAll('relay')
      .map(relay => relay.trim())
      .filter((relay, idx, arr) => relay.length > 0 && arr.indexOf(relay) === idx && isValidRelayUrl(relay));
    const relayUrl = relayUrls[0];
    const secret = url.searchParams.get('secret');
    const metadataStr = url.searchParams.get('metadata');
    if (!clientPubkey || !relayUrl || !secret) return null;
    if (!/^[0-9a-f]{64}$/i.test(clientPubkey)) return null;
    let appName = 'Unknown App';
    let appUrl: string | undefined;
    if (metadataStr && metadataStr.length <= MAX_METADATA_JSON_LEN) {
      try {
        const meta: unknown = JSON.parse(metadataStr);
        if (typeof meta === 'object' && meta !== null) {
          const m = meta as Record<string, unknown>;
          if (typeof m.name === 'string') {
            // Strip control + bidi / invisible chars the same way other
            // attacker-controlled display strings are sanitised (url-auth,
            // pairing-uri). Prevents `"\u202e"` etc. reaching the modal.
            const safe = sanitizeDisplayName(m.name, 100);
            if (safe.length > 0) appName = safe;
          }
          if (typeof m.url === 'string') {
            // Only accept https (or ws-adjacent http://localhost for dev)
            // and canonicalise to `origin` so attackers can't slip a
            // Unicode-homograph-laden path through.
            try {
              const u = new URL(m.url);
              if (u.protocol === 'https:' || ((u.protocol === 'http:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
                appUrl = u.origin.slice(0, 200);
              }
            } catch { /* invalid URL — leave appUrl undefined */ }
          }
        }
      } catch {
        // Invalid metadata JSON — use defaults
      }
    }
    if (!metadataStr) {
      const nameParam = url.searchParams.get('name');
      if (nameParam) {
        const safe = sanitizeDisplayName(nameParam, 100);
        if (safe.length > 0) appName = safe;
      }
      const urlParam = url.searchParams.get('url');
      if (urlParam) {
        try {
          const u = new URL(urlParam);
          if (u.protocol === 'https:' || ((u.protocol === 'http:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
            appUrl = u.origin.slice(0, 200);
          }
        } catch { /* invalid URL — leave appUrl undefined */ }
      }
    }
    return { clientPubkey, relayUrl, relayUrls, secret, appName, appUrl };
  } catch {
    return null;
  }
}

/** Send NIP-46 connect response — publishes kind 24133 event with encrypted pubkey */
export async function sendConnectResponse(
  request: NostrConnectRequest,
  backend: SigningBackend,
  relayUrl: string = request.relayUrl,
  assertCurrent?: () => Promise<void>,
): Promise<boolean> {
  const responseId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const responseJson = JSON.stringify({ id: responseId, result: request.secret });

  const encrypted = await backend.nip44Encrypt(request.clientPubkey, responseJson);

  const event: UnsignedEvent = {
    kind: 24133,
    pubkey: backend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', request.clientPubkey]],
    content: encrypted,
  };
  const signed = await backend.signEvent(event);

  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    await assertCurrent?.();
    const result = await relay.publish(signed);
    await assertCurrent?.();
    return result.ok;
  } finally {
    relay.disconnect();
  }
}
