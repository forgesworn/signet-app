/**
 * Child side of the child-direct Heartwood pairing (spec §4 steps 2 and 5,
 * amendments A2/A3). Relay and signer are injected so the sequence is testable:
 *
 *   fresh client keypair → nostrconnect:// on every Heartwood relay (the
 *   guardian mints on hwRelays[0]) → start listening for the Heartwood's
 *   connect ACK → publish the pairing request on the rail relay → show the
 *   out-of-band check words → wait for the guardian's reply → wait for the
 *   handshake, whose `get_public_key` must equal the offered PERSONA.
 *
 * Nothing is persisted here; the caller saves the record only on success.
 */
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { AutonomyStage } from '../types/dependants';
import {
  buildChildPairRequestEvent, newPairCode, openChildPairReplyEvent, pairCheckWords, pairReplyDTag,
  type ChildPairOffer, type ChildPairReply,
} from './child-pair-wire';
import { generateBunkerClientSecret } from './signing-backend';

/**
 * Whole-run budget. Longer than the plan's 120 s: the guardian must compare
 * four words out loud before minting (A3). Still inside the code's 600 s TTL.
 */
export const CHILD_PAIR_RUN_TIMEOUT_MS = 300_000;

export type ChildDirectPairErrorCode = 'timeout' | 'publish' | 'refused' | 'signer' | 'cancelled';

export class ChildDirectPairError extends Error {
  readonly code: ChildDirectPairErrorCode;
  readonly reason?: string;
  constructor(code: ChildDirectPairErrorCode, reason?: string) {
    super(`child pairing failed: ${code}${reason ? ` (${reason})` : ''}`);
    this.name = 'ChildDirectPairError';
    this.code = code;
    this.reason = reason;
  }
}

export interface ChildDirectPairingDeps {
  publish(event: NostrEvent, relays: string[]): Promise<{ ok: boolean; message: string }>;
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
  /**
   * Wait for the Heartwood's nostrconnect ACK and pin `get_public_key` to
   * `expectedPubkey`. Resolves with the secret-free bunker:// URI used for
   * every later reconnect; rejects on mismatch, timeout or abort.
   */
  handshake(clientPrivateKey: string, nostrconnectUri: string, expectedPubkey: string, timeoutMs: number, signal: AbortSignal): Promise<string>;
  nowS(): number;
}

export interface ChildDirectPairingResult {
  clientKeypair: { publicKey: string; privateKey: string };
  bunkerUri: string;
  personas: ChildPairReply['personas'];
  stage: AutonomyStage;
}

export function buildChildNostrConnectUri(clientPubkey: string, hwRelays: string[], secret: string): string {
  const p = new URLSearchParams();
  for (const r of hwRelays) p.append('relay', r);
  p.set('secret', secret);
  p.set('name', 'My Signet');
  return `nostrconnect://${clientPubkey}?${p.toString()}`;
}

/** Secret-free bunker URI to the bound persona, for `reconnect` on later starts. */
export function directBunkerUri(personaPubkey: string, hwRelays: string[]): string {
  const p = new URLSearchParams();
  for (const r of hwRelays) p.append('relay', r);
  return `bunker://${personaPubkey}?${p.toString()}`;
}

export async function runChildDirectPairing(
  offer: ChildPairOffer,
  deps: ChildDirectPairingDeps,
  opts: { onCheckWords(words: string[]): void; timeoutMs?: number; signal?: AbortSignal },
): Promise<ChildDirectPairingResult> {
  const timeoutMs = opts.timeoutMs ?? CHILD_PAIR_RUN_TIMEOUT_MS;
  const clientPriv = generateBunkerClientSecret();
  const clientPub = getPublicKey(hexToBytes(clientPriv));
  const nostrconnect = buildChildNostrConnectUri(clientPub, offer.hwRelays, newPairCode());

  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // One failure channel for timeout / abort, raced against every wait below.
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChildDirectPairError('timeout')), timeoutMs);
    const onAbort = () => reject(new ChildDirectPairError('cancelled'));
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort);
  });
  stopped.catch(() => { /* observed via the races below */ });

  try {
    // Listen for the ACK first: the guardian mints as soon as the words match.
    const handshake = deps.handshake(clientPriv, nostrconnect, offer.persona, timeoutMs, inner.signal);
    handshake.catch(() => { /* observed below */ });

    const reply = new Promise<ChildPairReply>((resolve) => {
      unsubscribe = deps.subscribe(
        [{ kinds: [30078], authors: [offer.rail], '#d': [pairReplyDTag(offer.code)], '#p': [clientPub], since: deps.nowS() - 60 }],
        [offer.relay],
        (ev) => {
          void openChildPairReplyEvent(ev, clientPriv, { code: offer.code, railPubkey: offer.rail })
            .then((r) => { if (r) resolve(r); });
        },
      );
    });

    const createdAt = deps.nowS();
    const reqEvent = await buildChildPairRequestEvent(
      { v: 1, code: offer.code, nostrconnect, clientPubkey: clientPub, createdAt }, clientPriv, offer.rail);
    const pub = await Promise.race([deps.publish(reqEvent, [offer.relay]), stopped]);
    if (!pub.ok) throw new ChildDirectPairError('publish', pub.message);
    opts.onCheckWords(pairCheckWords(offer.code, clientPub));

    const answer = await Promise.race([reply, stopped]);
    if (!answer.ok) throw new ChildDirectPairError('refused', answer.reason ?? 'other');

    let bunkerUri: string;
    try {
      bunkerUri = await Promise.race([handshake, stopped]);
    } catch (err) {
      if (err instanceof ChildDirectPairError) throw err;
      throw new ChildDirectPairError('signer');
    }
    return { clientKeypair: { publicKey: clientPub, privateKey: clientPriv }, bunkerUri, personas: answer.personas, stage: answer.stage };
  } catch (err) {
    inner.abort();
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
    (unsubscribe as (() => void) | null)?.();
  }
}

/**
 * The pubkey the paired-child signer must answer as (`get_public_key`).
 * Direct mode: the bound PERSONA — the dependant's real-identity slot is
 * dormant and not what the Heartwood slot is bound to. Legacy phone pairing:
 * the dependant pubkey, as before. A direct record missing its persona pins
 * '' so every connect fails closed.
 */
export function pairedChildSignerPubkey(record: { dependantPubkey: string; mode?: 'phone' | 'heartwood-direct'; personaPubkey?: string }): string {
  if (record.mode === 'heartwood-direct') return record.personaPubkey ?? '';
  return record.dependantPubkey;
}
