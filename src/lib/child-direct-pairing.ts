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
  buildChildPairRequestEvent, newPairCode, openChildPairReplyEvent, pairCheckWords, pairReplyDTag, parseChildPairUri, CHILD_PAIR_TTL_S,
  type ChildPairOffer, type ChildPairReply,
} from './child-pair-wire';
import { eventMatchesFilter } from './child-pair-tap';
import { BunkerPubkeyMismatchError, generateBunkerClientSecret } from './signing-backend';

/**
 * Whole-run budget. Longer than the plan's 120 s: the guardian must compare
 * four words out loud before minting (A3). Still inside the code's 600 s TTL.
 */
export const CHILD_PAIR_RUN_TIMEOUT_MS = 300_000;

/**
 * A28: the whole run is bounded by min(300 s, what is left of the code's
 * 600 s TTL). Zero when the code has already expired.
 */
export function childPairRunTimeoutMs(offerT: number, nowS: number): number {
  const leftMs = (offerT + CHILD_PAIR_TTL_S - nowS) * 1000;
  return Math.max(0, Math.min(CHILD_PAIR_RUN_TIMEOUT_MS, leftMs));
}

/**
 * `signer`: the Heartwood answered as the WRONG identity (a real pubkey
 * mismatch). `device-unreachable`: it did not answer this phone at all, even
 * though the guardian's reply proved the slot exists.
 */
export type ChildDirectPairErrorCode = 'timeout' | 'publish' | 'refused' | 'signer' | 'device-unreachable' | 'cancelled';

/**
 * After a valid ok reply the Heartwood's ACK was sent before the guardian
 * replied, so a handshake still silent this long afterwards missed it (a
 * socket that went quiet without closing, e.g. a screen-off throttle).
 */
export const CHILD_PAIR_ACK_GRACE_MS = 20_000;

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
  /**
   * Recovery when `handshake` fails for a reason other than a pubkey mismatch
   * (the ACK is ephemeral and can be missed): connect as an ordinary bunker
   * client to `personaPubkey` on `relays` with the same client key, pinning
   * `get_public_key`. Rejects with `BunkerPubkeyMismatchError` on a wrong identity.
   */
  connectPaired?(clientPrivateKey: string, personaPubkey: string, relays: string[], timeoutMs: number, signal: AbortSignal): Promise<string>;
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

/**
 * The child's end of a tap pairing: the Bluetooth link to the phone it tapped
 * (a `ChildPairTap`). The offer arrives over it, the request goes out over it,
 * and events from it feed the same reply handler as a relay's.
 */
export interface ChildTapChannel {
  onOffer(handler: (uri: string) => void): () => void;
  onEvent(handler: (event: NostrEvent) => void): () => void;
  sendEvent(event: NostrEvent): Promise<boolean>;
  /** Close the link and stop NFC. */
  end(): void;
}

/**
 * Wait for the tapped guardian's `signet-child:` offer and parse it with the
 * same strict parser the QR path uses. Rejects `cancelled` on abort,
 * `timeout` if none arrives in time, `refused` ('bad-offer') on a URI that
 * does not parse or is not fresh.
 */
export function awaitTapOffer(
  channel: Pick<ChildTapChannel, 'onOffer'>, nowS: () => number, opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ChildPairOffer> {
  return new Promise<ChildPairOffer>((resolve, reject) => {
    let stop: (() => void) | null = null;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (finish: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      stop?.();
      finish();
    };
    const onAbort = () => done(() => reject(new ChildDirectPairError('cancelled')));
    if (opts.signal?.aborted) { reject(new ChildDirectPairError('cancelled')); return; }
    opts.signal?.addEventListener('abort', onAbort);
    timer = setTimeout(() => done(() => reject(new ChildDirectPairError('timeout'))), opts.timeoutMs ?? CHILD_PAIR_RUN_TIMEOUT_MS);
    stop = channel.onOffer(uri => {
      const offer = parseChildPairUri(uri, nowS());
      done(() => (offer ? resolve(offer) : reject(new ChildDirectPairError('refused', 'bad-offer'))));
    });
    // The offer may have been replayed synchronously, before `stop` was set.
    if (finished) stop();
  });
}

/**
 * `publish`/`subscribe` for a tap pairing. The request goes over the link
 * (relays ignored). The reply is awaited on the link AND on the offer's relay,
 * because the guardian falls back to the relay if its link has dropped by
 * reply time; the first valid reply wins and a duplicate is harmless.
 */
export function childTapDeps(
  base: Pick<ChildDirectPairingDeps, 'subscribe'>,
  channel: Pick<ChildTapChannel, 'onEvent' | 'sendEvent'>,
): Pick<ChildDirectPairingDeps, 'publish' | 'subscribe'> {
  return {
    async publish(event) {
      const acked = await channel.sendEvent(event).catch(() => false);
      return acked ? { ok: true, message: 'link' } : { ok: false, message: 'link' };
    },
    subscribe(filters, relays, onEvent) {
      const stopLink = channel.onEvent(ev => { if (filters.some(f => eventMatchesFilter(ev, f))) onEvent(ev); });
      const stopRelay = base.subscribe(filters, relays, onEvent);
      return () => { stopLink(); stopRelay(); };
    },
  };
}

export async function runChildDirectPairing(
  offer: ChildPairOffer,
  deps: ChildDirectPairingDeps,
  opts: {
    onCheckWords(words: string[]): void; timeoutMs?: number; signal?: AbortSignal;
    /** `'tap'`: the guardian confirms on its own screen, so no check words are shown here. */
    via?: 'tap' | 'qr';
    /** The request has been delivered; the guardian now decides. */
    onRequestSent?(): void;
  },
): Promise<ChildDirectPairingResult> {
  const timeoutMs = opts.timeoutMs ?? childPairRunTimeoutMs(offer.t, deps.nowS());
  // A28: never start on a code with no time left (the guardian would refuse it anyway).
  if (timeoutMs <= 0) throw new ChildDirectPairError('timeout');
  const clientPriv = generateBunkerClientSecret();
  const clientPub = getPublicKey(hexToBytes(clientPriv));
  const nostrconnect = buildChildNostrConnectUri(clientPub, offer.hwRelays, newPairCode());

  const startedAt = Date.now();
  const inner = new AbortController();
  // The first handshake has its own signal so a silent one can be retired
  // without ending the whole run.
  const firstHandshake = new AbortController();
  const onOuterAbort = () => inner.abort();
  inner.signal.addEventListener('abort', () => firstHandshake.abort());
  opts.signal?.addEventListener('abort', onOuterAbort);
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

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
    const handshake = deps.handshake(clientPriv, nostrconnect, offer.persona, timeoutMs, firstHandshake.signal);
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
    if (opts.via !== 'tap') opts.onCheckWords(pairCheckWords(offer.code, clientPub));
    opts.onRequestSent?.();

    const answer = await Promise.race([reply, stopped]);
    if (!answer.ok) throw new ChildDirectPairError('refused', answer.reason ?? 'other');

    let bunkerUri: string;
    try {
      // With a fallback to hand over to, a handshake silent this long after a
      // valid reply is treated as a missed ACK rather than waited on to the end.
      const grace = deps.connectPaired
        ? new Promise<never>((_, reject) => {
          graceTimer = setTimeout(() => { firstHandshake.abort(); reject(new Error('connect ACK missed')); }, CHILD_PAIR_ACK_GRACE_MS);
        })
        : null;
      grace?.catch(() => { /* observed via the race below */ });
      bunkerUri = await Promise.race(grace ? [handshake, grace, stopped] : [handshake, stopped]);
    } catch (err) {
      if (err instanceof ChildDirectPairError) throw err;
      if (opts.signal?.aborted || inner.signal.aborted) throw new ChildDirectPairError('cancelled');
      if (err instanceof BunkerPubkeyMismatchError) throw new ChildDirectPairError('signer');
      if (!deps.connectPaired) throw new ChildDirectPairError('device-unreachable');
      // The reply proved the slot exists: connect as an ordinary bunker client.
      const leftMs = timeoutMs - (Date.now() - startedAt);
      if (leftMs <= 0) throw new ChildDirectPairError('timeout');
      try {
        bunkerUri = await Promise.race([deps.connectPaired(clientPriv, offer.persona, offer.hwRelays, leftMs, inner.signal), stopped]);
      } catch (err2) {
        if (err2 instanceof ChildDirectPairError) throw err2;
        if (err2 instanceof BunkerPubkeyMismatchError) throw new ChildDirectPairError('signer');
        if (opts.signal?.aborted || inner.signal.aborted) throw new ChildDirectPairError('cancelled');
        throw new ChildDirectPairError('device-unreachable');
      }
    } finally {
      clearTimeout(graceTimer);
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
