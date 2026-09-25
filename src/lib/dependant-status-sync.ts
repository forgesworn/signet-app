/**
 * Per-dependant status-sync rail.
 *
 * Guardian publishes a NIP-44-encrypted kind-30078 replaceable event
 * carrying the dependant's current `autonomyStage`. Signer is the
 * guardian's per-dependant endpoint keypair — the same
 * cryptographic identity the child already trusts for every NIP-46
 * envelope. Recipient is the child's transport pubkey (bound at pair
 * time). The child subscribes on unlock, decrypts, and caches the
 * stage locally so the home surface can render dormant UX pre-emptively
 * when `stage === 'full-control'`.
 *
 * See the 2026-04-22 child-stage-awareness holodeck for the full
 * options analysis and per-persona reasoning:
 *   docs/reports/2026-04-22-child-stage-awareness-holodeck.md
 *
 * **Privacy invariant.** The payload carries `{v, stage, updatedAt,
 * guardianName?}` only. No content, origins, or history. An attacker
 * observing the relay sees an encrypted blob of ~150 bytes between two
 * known pubkeys — the same leakage profile as every sign_event
 * envelope the family-bunker already produces.
 *
 * **Forward compatibility.** Unknown stage tokens parse to a sentinel
 * and callers default to dormant. Payload version `v: 1`; anything
 * else is ignored.
 */

import type { UnsignedEvent } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import type { AutonomyStage } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';

const SYNC_D_TAG = 'signet:dependant-status';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;

const KNOWN_STAGES: readonly AutonomyStage[] = [
  'full-control',
  'request-approve',
  'autonomous-alerts',
  'autonomous-logging',
  'full-autonomy',
];

/** On-wire payload. Versioned so new fields don't silently degrade old readers. */
export interface DependantStatusPayload {
  v: number;
  stage: AutonomyStage;
  updatedAt: number;
  guardianName?: string;
}

export interface DependantStatusParams {
  /**
   * The child device's NIP-46 transport pubkey. Payload is NIP-44-
   * encrypted to this key. Must be 64-char hex.
   */
  childTransportPubkey: string;
  /** Stage the guardian is announcing. */
  stage: AutonomyStage;
  /** Unix seconds — the moment the stage actually changed on the guardian. */
  updatedAt: number;
  /**
   * Optional guardian display name, surfaced in the child's dormant
   * copy. Omit when sensitive.
   */
  guardianName?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Publish a status record. Signer is the guardian's per-dependant
 * endpoint backend; it encrypts to the child's transport pubkey using
 * the (endpoint-privkey, child-transport-pubkey) NIP-44 pair.
 *
 * Returns true on relay acceptance. False results are not fatal — the
 * event is replaceable, so the next publish overwrites.
 */
export async function publishDependantStatus(
  params: DependantStatusParams,
  endpointBackend: DecryptingSigningBackend,
  relayUrl: string,
): Promise<boolean> {
  if (!isValidRelayUrl(relayUrl)) return false;
  if (!HEX64.test(params.childTransportPubkey)) return false;

  const payload: DependantStatusPayload = {
    v: SCHEMA_V,
    stage: params.stage,
    updatedAt: params.updatedAt,
  };
  if (params.guardianName) payload.guardianName = params.guardianName;

  const ciphertext = await endpointBackend.nip44Encrypt(
    params.childTransportPubkey,
    JSON.stringify(payload),
  );

  const event: UnsignedEvent = {
    kind: SYNC_KIND,
    pubkey: endpointBackend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', SYNC_D_TAG],
      ['p', params.childTransportPubkey.toLowerCase()],
    ],
    content: ciphertext,
  };
  const signed = await endpointBackend.signEvent(event);

  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const result = await relay.publish(signed);
    return result.ok;
  } catch {
    return false;
  } finally {
    relay.disconnect();
  }
}

/**
 * Fetch the latest status event addressed TO the child. Returns null
 * when no event exists, the relay is unreachable, or decryption /
 * validation fails. Caller treats null as a cache miss and the dormant
 * default applies per OQ1-139.
 */
export async function fetchDependantStatus(
  endpointPubkey: string,
  childTransportBackend: DecryptingSigningBackend,
  relayUrl: string,
  sinceCreatedAt?: number,
): Promise<{ payload: DependantStatusPayload; createdAt: number } | null> {
  if (!isValidRelayUrl(relayUrl)) return null;
  if (!HEX64.test(endpointPubkey)) return null;

  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const events = await relay.fetch([{
      kinds: [SYNC_KIND],
      authors: [endpointPubkey.toLowerCase()],
      '#d': [SYNC_D_TAG],
      limit: 1,
    } as never]);
    if (events.length === 0) return null;

    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (sinceCreatedAt !== undefined && latest.created_at <= sinceCreatedAt) {
      return null;
    }
    const plaintext = await childTransportBackend.nip44Decrypt(
      endpointPubkey.toLowerCase(),
      latest.content,
    );
    const payload = parseDependantStatusPayload(plaintext);
    if (!payload) return null;
    return { payload, createdAt: latest.created_at };
  } catch {
    return null;
  } finally {
    relay.disconnect();
  }
}

/**
 * Parse + shape-check a decrypted payload. Returns null on any
 * malformation — caller falls back to dormant (conservative default).
 */
export function parseDependantStatusPayload(raw: string): DependantStatusPayload | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v !== SCHEMA_V) return null;
  if (typeof p.stage !== 'string') return null;
  if (!KNOWN_STAGES.includes(p.stage as AutonomyStage)) return null;
  if (typeof p.updatedAt !== 'number' || p.updatedAt <= 0) return null;

  const out: DependantStatusPayload = {
    v: SCHEMA_V,
    stage: p.stage as AutonomyStage,
    updatedAt: p.updatedAt,
  };
  if (typeof p.guardianName === 'string') {
    // Strip control / bidi characters; cap at 64 chars. Matches the
    // pairing-URI input-sanitisation policy.
    // eslint-disable-next-line no-control-regex
    const clean = p.guardianName.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').slice(0, 64).trim();
    if (clean) out.guardianName = clean;
  }
  return out;
}

/**
 * Extract the endpoint pubkey from a stored pairing URI. The URI is
 * always `bunker://<hex64>?...`; we slice the authority rather than
 * re-running the full pairing-URI parser to avoid a cycle (this module
 * is imported by the sync hook, which runs before identity validation).
 */
export function extractEndpointPubkey(bunkerUri: string): string | null {
  if (typeof bunkerUri !== 'string') return null;
  if (bunkerUri.slice(0, 9).toLowerCase() !== 'bunker://') return null;
  const afterScheme = bunkerUri.slice('bunker://'.length);
  const qIdx = afterScheme.indexOf('?');
  if (qIdx < 0) return null;
  const candidate = afterScheme.slice(0, qIdx).toLowerCase();
  return HEX64.test(candidate) ? candidate : null;
}

export { KNOWN_STAGES };
