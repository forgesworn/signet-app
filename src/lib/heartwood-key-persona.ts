/**
 * A persona whose key is a separate identity on the paired Heartwood (another
 * master slot, typically an nsec imported onto the device), not derived from
 * this tree and never on the phone.
 *
 * Firmware model: client authorisation is per (master slot, client pubkey),
 * and the `#p` tag selects the identity. The phone's client key, bound on the
 * tree's master by the original pairing, is a stranger to any other master
 * (`sign_event` is denied, no card). Binding it there needs a `connect` that
 * carries THAT master's pairing secret, which comes from a bunker QR Sapwood
 * makes with "It will sign as" set to that identity. After that, the router's
 * ordinary per-pubkey route (`backendFor`) signs as the persona with the same
 * client key, so nothing else about signing changes.
 */
import { verifyEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { BunkerSigningBackend, DecryptingSigningBackend } from './signing-backend';

const HEX64_RE = /^[0-9a-f]{64}$/;

/** NIP-42 AUTH kind, addressed to a relay that cannot exist: a signed copy is useless to anyone. */
export const HEARTWOOD_KEY_CHECK_KIND = 22242;
export const HEARTWOOD_KEY_CHECK_RELAY = 'wss://heartwood-check.invalid';

export interface ParsedHeartwoodKeyUri {
  pubkey: string;
  relays: string[];
}

/** A bunker:// URI from Sapwood for one identity: endpoint pubkey, at least one wss relay, and a pairing secret. */
export function parseHeartwoodKeyUri(raw: string): ParsedHeartwoodKeyUri | null {
  const m = /^bunker:\/\/([0-9a-fA-F]{64})\?(.+)$/.exec((raw || '').trim());
  if (!m) return null;
  const params = new URLSearchParams(m[2]);
  const relays = params.getAll('relay').map(r => r.trim()).filter(r => /^wss:\/\//i.test(r));
  if (relays.length === 0) return null;
  if (!(params.get('secret') ?? '').trim()) return null;
  return { pubkey: m[1].toLowerCase(), relays };
}

export class HeartwoodKeyMismatchError extends Error {
  constructor(readonly expected: string, readonly got: string) {
    super('Your Heartwood answered as a different key than the QR code names.');
    this.name = 'HeartwoodKeyMismatchError';
  }
}

export interface BindHeartwoodKeyDeps {
  /** A fresh backend on the phone's EXISTING client secret (never a new one). */
  makeBinder: () => BunkerSigningBackend;
  /** The router's per-pubkey route: the backend the app will sign with afterwards. */
  routeFor: (pubkey: string) => DecryptingSigningBackend | null;
  timeoutMs: number;
  now?: () => number;
  randomHex?: () => string;
}

export function buildHeartwoodKeyCheckEvent(pubkey: string, nowSec: number, challenge: string): UnsignedEvent {
  return {
    kind: HEARTWOOD_KEY_CHECK_KIND,
    pubkey,
    created_at: nowSec,
    tags: [['relay', HEARTWOOD_KEY_CHECK_RELAY], ['challenge', challenge]],
    content: '',
  } as UnsignedEvent;
}

/**
 * Bind the phone's client key on the identity the URI names, then prove the
 * route the app will use signs as it. Returns the identity's pubkey. Nothing
 * is published: the check event is signed, verified and dropped.
 */
export async function bindHeartwoodKey(bunkerUri: string, deps: BindHeartwoodKeyDeps): Promise<string> {
  const parsed = parseHeartwoodKeyUri(bunkerUri);
  if (!parsed) throw new Error('That isn\'t a bunker:// code with a relay and a pairing secret.');
  const { pubkey } = parsed;

  const binder = deps.makeBinder();
  try {
    await binder.connect(bunkerUri.trim(), deps.timeoutMs);
    const got = (binder.activePublicKeyHex || '').toLowerCase();
    if (got !== pubkey) throw new HeartwoodKeyMismatchError(pubkey, got);
  } finally {
    binder.destroy();
  }

  const route = deps.routeFor(pubkey);
  if (!route) throw new Error('Your Heartwood connection isn\'t ready. Try again in a moment.');
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const challenge = deps.randomHex?.() ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const signed: NostrEvent = await route.signEvent(buildHeartwoodKeyCheckEvent(pubkey, nowSec, challenge));
  if ((signed.pubkey || '').toLowerCase() !== pubkey) throw new HeartwoodKeyMismatchError(pubkey, signed.pubkey || '');
  if (!verifyEvent(signed as Parameters<typeof verifyEvent>[0])) throw new Error('Your Heartwood\'s signature didn\'t check out.');
  return pubkey;
}

export function isHex64(s: string): boolean {
  return HEX64_RE.test(s);
}
