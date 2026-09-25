/**
 * Relay Publishing for Signet Presentation Protocol
 *
 * All events are NIP-17 gift-wrapped (kind 1059) before publishing.
 * This hides sender, recipient, timestamps, content, and tags from
 * relay operators and third parties.
 */

import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { buildVerifyEventTemplate, buildRejectionEventTemplate, buildAuthResponseEventTemplate, verifyAgeRangeProof } from 'signet-protocol';
import type { VerifyResponse } from 'signet-protocol';
import type { SigningBackend } from './signing-backend';
import { signEvent } from 'signet-protocol';
import { nip44Encrypt } from './nip46';
import { isValidRelayUrl } from './relay-url';
import { generateSecretKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Auth response payload published via relay (cross-device flow).
 *
 * Defined locally because npm-published signet-protocol 1.6.0 still carries
 * the older `pubkey + signature` shape from before the kind-21236 refactor
 * (commit e7c3f55). The source repo (../signet) has the new shape but the
 * npm release is pinned behind it. Keeping a local type avoids the drift
 * until the protocol publishes a release that includes this change.
 */
export interface AuthResponse {
  type: 'signet-auth-response';
  requestId: string;
  /** Signed kind-21236 event — the cryptographic proof. */
  authEvent: {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
    sig: string;
  };
  /** Optional credential (attached for signet-login-request flows). */
  credential?: {
    id: string;
    kind: number;
    pubkey: string;
    tags: string[][];
    content: string;
    sig: string;
    created_at: number;
  };
  /**
   * Optional persona handle, set when the user approved with shareHandle === true
   * and a non-NP keypair was selected. Mirrors the `&display_name=` query param
   * appended to redirect-back URLs by `buildAuthCallbackUrl`. Omitted entirely
   * when not shared (do not set to '' or null).
   */
  displayName?: string;
  /**
   * Optional `bunker://` URI to this device's own NIP-46 server, minted with a
   * one-shot pairing secret. Set on the relay/QR flow when the bunker server is
   * enabled, so the consumer can upgrade its auth-only EphemeralSigner to a live
   * signer that passes through to this device's backend — the cross-device
   * equivalent of the redirect flow's `&bunker=` callback param. The stale npm
   * builder JSON-stringifies the whole response, so it rides the gift-wrap with
   * no wire change.
   */
  bunkerUri?: string;
}

// ── Gift Wrap (NIP-17 / NIP-59) ──────────────────────────────────────────────

/**
 * Compute a NIP-01 event ID: SHA-256 of the canonical JSON serialization.
 */
function computeEventId(event: UnsignedEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

/**
 * Gift-wrap timestamp. NIP-59 suggests randomising into the past for timing
 * privacy, but the Signet auth consumer (signet-verify) subscribes for the
 * response with `since = now - 60s` and listens live — so a wrap dated more than
 * ~60s in the past, OR in the future (relay-rejected), is never delivered: the
 * response publishes, the phone shows "approved", but the consumer's
 * subscription never matches and sign-in silently stalls. Stay inside that
 * window: 0-30s in the past, never in the future. (Widening this needs the
 * consumer's `since` widened in lockstep — see signet-verify.)
 */
function randomTimestamp(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 30);
}

/**
 * Gift-wrap an unsigned event using NIP-17 (kind 1059).
 *
 * Steps:
 * 1. Create a "rumor" — the inner event with computed ID but no signature.
 * 2. Create a "seal" (kind 13) — NIP-44 encrypt the rumor with the sender's key.
 * 3. Create a "wrap" (kind 1059) — NIP-44 encrypt the seal with an ephemeral key.
 *
 * Works with both LocalSigningBackend (has private key) and BunkerSigningBackend
 * (delegates sign + encrypt to the remote signer).
 *
 * Exported so modules outside this file (audit log, future NIP-17 emitters)
 * can reuse the single gift-wrap implementation instead of forking it.
 */
export async function giftWrap(
  innerEvent: UnsignedEvent,
  recipientPubkey: string,
  backend: SigningBackend,
): Promise<NostrEvent> {
  // Step 1: Create rumor (unsigned event with ID)
  const rumor = {
    ...innerEvent,
    id: computeEventId(innerEvent),
  };

  // Step 2: Create seal — NIP-44 encrypt rumor, sign with sender
  const encryptedRumor = await backend.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));

  const sealTemplate: UnsignedEvent = {
    kind: 13,
    pubkey: backend.activePublicKeyHex,
    created_at: randomTimestamp(),
    tags: [],
    content: encryptedRumor,
  };
  const seal = await backend.signEvent(sealTemplate);

  // Step 3: Create wrap — NIP-44 encrypt seal, sign with ephemeral key.
  // ephSk must be zeroed even if an inner operation throws — any branch that
  // exits this function must pass through the finally below. (The hex-string
  // alias ephSkHex cannot be zeroed — JS strings are immutable — but
  // clearing the backing Uint8Array at least removes the contiguous
  // key-bytes slot that nip44Encrypt / signEvent re-derive internally.)
  const ephSk = generateSecretKey();
  try {
    const ephPkHex = bytesToHex(schnorr.getPublicKey(ephSk));
    const ephSkHex = bytesToHex(ephSk);

    const encryptedSeal = await nip44Encrypt(ephSkHex, recipientPubkey, JSON.stringify(seal));

    const wrapTemplate: UnsignedEvent = {
      kind: 1059,
      pubkey: ephPkHex,
      created_at: randomTimestamp(),
      tags: [['p', recipientPubkey]],
      content: encryptedSeal,
    };

    return await signEvent(wrapTemplate, ephSkHex);
  } finally {
    ephSk.fill(0);
  }
}

// ── Transport ─────────────────────────────────────────────────────────────────

// Relay-URL validation lives in ./relay-url (single source of truth). Re-exported
// here so existing importers (e.g. audit.ts) keep working unchanged; also used
// internally by the publish guards below.
export { isValidRelayUrl };

/**
 * Publish a signed event to a relay via ephemeral WebSocket and wait for
 * the relay's NIP-01 / NIP-20 `OK` frame.
 *
 *   relay → `["OK", <event-id>, <true|false>, <human-readable-reason>]`
 *
 * Returns:
 *   - `true` if a matching `OK ... true` arrives within the timeout
 *   - `false` if the relay sends `OK ... false`, the WebSocket errors, the
 *     socket closes before any matching OK arrives, or no OK arrives within
 *     `RELAY_PUBLISH_TIMEOUT_MS`
 *
 * Previously this function resolved `true` 1 s after `onopen` regardless of
 * what the relay returned — so an `OK ... false` (rate-limited, AUTH
 * required, malformed event, blacklisted pubkey, etc.) looked identical to
 * acceptance. Callers that branched on the boolean (auth-response retry UX
 * at `App.tsx:1838`, the Connections approval card, audit publishing) silently
 * treated rejections as successes.
 */
const RELAY_PUBLISH_TIMEOUT_MS = 10_000;

export function publishToRelay(signedEvent: NostrEvent, relayUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      resolve(false);
      return;
    }

    const finish = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch { /* already closing */ }
      clearTimeout(timeout);
      resolve(ok);
    };

    const timeout = setTimeout(() => finish(false), RELAY_PUBLISH_TIMEOUT_MS);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(['EVENT', signedEvent]));
      } catch {
        finish(false);
      }
    };

    ws.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof msg.data === 'string' ? msg.data : String(msg.data));
      } catch {
        return; // malformed frame — ignore, keep waiting for OK or timeout
      }
      // Only act on `["OK", <our-event-id>, <bool>, <reason?>]`. NOTICE,
      // EOSE, and EVENT subscription replies are ignored — we never sent
      // a REQ on this socket so they shouldn't arrive, but be defensive.
      if (!Array.isArray(parsed) || parsed[0] !== 'OK') return;
      if (parsed[1] !== signedEvent.id) return;
      finish(parsed[2] === true);
    };

    ws.onerror = () => finish(false);
    // If the relay closes the socket before sending an OK frame for our
    // event, treat as failure. NIP-20-compliant relays always send OK
    // before closing; a close-without-OK is either a non-compliant relay
    // or a transport drop, both of which we should report as failure
    // rather than silently assume success.
    ws.onclose = () => finish(false);
  });
}

// ── Internal: gift-wrap and publish ───────────────────────────────────────────

/**
 * Gift-wrap (NIP-17 / NIP-59) and publish. `recipientPubkey` is required —
 * publishing user attestations or auth responses without an envelope key
 * would expose pubkey → tier and pubkey → origin correlations to anyone
 * scanning the relay, which we explicitly refuse to do (relay-encryption
 * privacy guarantee).
 */
async function signAndPublish(
  inner: UnsignedEvent,
  relayUrl: string,
  backend: SigningBackend,
  recipientPubkey: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(recipientPubkey)) return false;
  const wrapped = await giftWrap(inner, recipientPubkey, backend);
  return publishToRelay(wrapped, relayUrl);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Publish a verification response to a Nostr relay, gift-wrapped (kind 1059)
 * to `recipientPubkey`. Returns false if `recipientPubkey` is missing or
 * malformed — we refuse to publish cleartext credentials to a relay.
 */
export async function publishVerifyResponseToRelay(
  response: VerifyResponse,
  relayUrl: string,
  backend: SigningBackend,
  recipientPubkey: string,
): Promise<boolean> {
  if (!relayUrl || !isValidRelayUrl(relayUrl)) return false;

  // Pre-publish ZKP verification — runs BEFORE the try/catch so errors propagate.
  // Legacy credentials (no zk-age tag) pass through unchanged.
  const tags = response.credential.tags;
  const hasZkAge = tags.some(t => t[0] === 'zk-age' && t[1] === '1');
  if (hasZkAge) {
    const ageRange = tags.find(t => t[0] === 'age-range')?.[1];
    if (!ageRange) throw new Error('credential-zkp-invalid');
    try {
      const content = JSON.parse(response.credential.content) as { rangeProof?: unknown };
      if (!content.rangeProof || typeof content.rangeProof !== 'object') throw new Error('credential-zkp-invalid');
      if (!verifyAgeRangeProof(content.rangeProof as Parameters<typeof verifyAgeRangeProof>[0], ageRange, response.subjectPubkey)) {
        throw new Error('credential-zkp-invalid');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'credential-zkp-invalid') throw err;
      throw new Error('credential-zkp-invalid');
    }
  }

  try {
    const inner = buildVerifyEventTemplate(response, backend.activePublicKeyHex);
    return await signAndPublish(inner, relayUrl, backend, recipientPubkey);
  } catch {
    return false;
  }
}

/**
 * Publish a verification rejection to a Nostr relay, gift-wrapped (kind 1059)
 * to `recipientPubkey`. Returns false if `recipientPubkey` is missing or
 * malformed — see `publishVerifyResponseToRelay`.
 */
export async function publishVerifyRejectionToRelay(
  requestId: string,
  relayUrl: string,
  backend: SigningBackend,
  recipientPubkey: string,
): Promise<boolean> {
  if (!relayUrl || !isValidRelayUrl(relayUrl)) return false;

  try {
    const inner = buildRejectionEventTemplate(requestId, backend.activePublicKeyHex);
    return await signAndPublish(inner, relayUrl, backend, recipientPubkey);
  } catch {
    return false;
  }
}

// The reason publishAuthResponseToRelay last swallowed (typically the gift-wrap
// NIP-44 encrypt / sign step throwing). Read+cleared by the caller (doPublish)
// so the failed-approve UI can show the REAL cause instead of a misleading
// relay-host failure. Kept as a boolean-returning contract because callers and
// the test suite depend on it.
let lastAuthPublishError: string | null = null;
export function getLastAuthPublishError(): string | null {
  const e = lastAuthPublishError;
  lastAuthPublishError = null;
  return e;
}

/**
 * Publish an auth response to a Nostr relay, gift-wrapped (kind 1059) to
 * `recipientPubkey`. Returns false if `recipientPubkey` is missing or
 * malformed — see `publishVerifyResponseToRelay`.
 */
export async function publishAuthResponseToRelay(
  response: AuthResponse,
  relayUrl: string,
  backend: SigningBackend,
  recipientPubkey: string,
): Promise<boolean> {
  if (!relayUrl || !isValidRelayUrl(relayUrl)) return false;

  try {
    // Cast: the installed npm builder has the pre-21236-refactor type signature
    // but the implementation just JSON-stringifies the response, so the runtime
    // shape we pass is accepted verbatim. See the AuthResponse comment above.
    const inner = buildAuthResponseEventTemplate(response as unknown as Parameters<typeof buildAuthResponseEventTemplate>[0], backend.activePublicKeyHex);
    return await signAndPublish(inner, relayUrl, backend, recipientPubkey);
  } catch (e) {
    // Capture (don't rethrow — the boolean contract is tested) so doPublish can
    // show the REAL reason. The gift-wrap NIP-44 encrypt / sign step is the
    // usual culprit behind a swallowed "failed to approve". No console output
    // in production (project convention) — the message is surfaced to the UI
    // via lastAuthPublishError above.
    lastAuthPublishError = e instanceof Error ? e.message : String(e);
    return false;
  }
}
