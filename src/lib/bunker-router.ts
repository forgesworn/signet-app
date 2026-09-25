import { BunkerSigningBackend, BunkerRequestTimeoutError } from './signing-backend';
import type { DecryptingSigningBackend } from './signing-backend';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Per-identity routing over one paired Heartwood connection (family-bunker
 * migration §11.1.3). Firmware model (v0.16.0): the `#p` tag on a NIP-46
 * request selects the signing identity (master or registry persona); client
 * authorization is keyed by (master slot, client pubkey), so the one client
 * key bound by the master `connect` can address every persona of the tree.
 * Each route is therefore just a second BunkerSigner addressed to the slot's
 * own pubkey, reusing the same client secret — no extra connect handshake.
 */

export interface HeartwoodCapabilities {
  version: number;
  methods: string[];
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Parse a heartwood_capabilities result payload (string-wrapped JSON). */
export function parseHeartwoodCapabilities(raw: string): HeartwoodCapabilities | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as { version?: unknown; methods?: unknown };
    if (typeof obj.version !== 'number' || !Array.isArray(obj.methods)) return null;
    if (!obj.methods.every((m): m is string => typeof m === 'string')) return null;
    return { version: obj.version, methods: obj.methods };
  } catch {
    return null;
  }
}

/**
 * Rewrite a bunker:// URI to address a different on-device identity. Keeps
 * every query param except the pairing secret (the client is already
 * slot-bound; persona URIs are secret-less by design).
 */
export function buildSlotBunkerUri(baseUri: string, slotPubkeyHex: string): string {
  const pk = (slotPubkeyHex || '').trim().toLowerCase();
  if (!HEX64_RE.test(pk)) throw new Error('Invalid slot pubkey: expected 64-char hex');
  const match = /^bunker:\/\/([0-9a-fA-F]{64})(\?(.*))?$/.exec((baseUri || '').trim());
  if (!match) throw new Error('Invalid bunker URI');
  const params = new URLSearchParams(match[3] ?? '');
  params.delete('secret');
  const qs = params.toString();
  return `bunker://${pk}${qs ? `?${qs}` : ''}`;
}

type MakeBackend = (clientSecretHex: string) => BunkerSigningBackend;

const defaultMakeBackend: MakeBackend = (secret) => new BunkerSigningBackend(secret);

/**
 * A lazily-connecting bunker backend pinned to one slot pubkey. Synchronous
 * to construct (React wiring hands backends around as plain values); the
 * first signing/encryption call opens the underlying NIP-46 connection and
 * verifies the device answers as the expected identity.
 */
export class RoutedBunkerSigningBackend implements DecryptingSigningBackend {
  readonly type = 'bunker' as const;
  readonly activePublicKeyHex: string;
  /** This app's NIP-46 client key — the author of every request this route sends. */
  readonly transportClientPubkeyHex: string;
  private clientSecretHex: string;
  private readonly slotBunkerUri: string;
  private readonly makeBackend: MakeBackend;
  private inner: BunkerSigningBackend | null = null;
  private connecting: Promise<BunkerSigningBackend> | null = null;
  private destroyed = false;

  /** Whether destroy() has been called on this route. Lets the router
   * self-heal by dropping a dead cached route instead of handing callers
   * a permanently-disabled backend (family-bunker §11.1.3 App.tsx effect
   * teardown destroys the backends it created on every lock/dependant switch,
   * but the router's route cache persists across those cycles). */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  constructor(clientSecretHex: string, slotBunkerUri: string, slotPubkeyHex: string, makeBackend: MakeBackend = defaultMakeBackend) {
    this.clientSecretHex = clientSecretHex;
    this.transportClientPubkeyHex = bytesToHex(schnorr.getPublicKey(hexToBytes(clientSecretHex)));
    this.slotBunkerUri = slotBunkerUri;
    this.activePublicKeyHex = slotPubkeyHex.trim().toLowerCase();
    this.makeBackend = makeBackend;
  }

  private ensure(): Promise<BunkerSigningBackend> {
    if (this.destroyed) return Promise.reject(new Error('Backend destroyed'));
    if (this.inner) return Promise.resolve(this.inner);
    if (!this.connecting) {
      const backend = this.makeBackend(this.clientSecretHex);
      this.connecting = backend
        // No connect handshake re-send: the client key is already bound to
        // the master slot; expectedPubkey pins the route to its identity.
        .reconnect(this.slotBunkerUri, 30_000, this.activePublicKeyHex, false)
        .then(() => {
          if (this.destroyed) {
            backend.destroy();
            throw new Error('Backend destroyed');
          }
          this.inner = backend;
          return backend;
        })
        .catch((err) => {
          backend.destroy();
          this.connecting = null; // allow a later retry
          throw err;
        });
    }
    return this.connecting;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    const requested = typeof event.pubkey === 'string' ? event.pubkey.trim().toLowerCase() : '';
    if (requested && requested !== this.activePublicKeyHex) {
      throw new Error('Cannot sign event for a different pubkey.');
    }
    const inner = await this.ensure();
    return inner.signEvent(event);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const inner = await this.ensure();
    return inner.nip44Encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const inner = await this.ensure();
    return inner.nip44Decrypt(senderPubkey, ciphertext);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const inner = await this.ensure();
    return inner.nip04Encrypt(recipientPubkey, plaintext);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const inner = await this.ensure();
    return inner.nip04Decrypt(senderPubkey, ciphertext);
  }

  destroy(): void {
    this.destroyed = true;
    this.connecting = null;
    if (this.inner) {
      this.inner.destroy();
      this.inner = null;
    }
    // Same best-effort caveat as the other backends — drops our reference,
    // does not scrub the original string's backing memory.
    this.clientSecretHex = '0'.repeat(64);
  }
}

/** Per-attempt ceiling on the capabilities probe. BunkerSigner has no
 * request timeout of its own, so without this one lost reply parks the
 * router at "probing" for the rest of the unlock. */
export const PROBE_TIMEOUT_MS = 20_000;

/** Delay before each retry; the last entry repeats for as long as the
 * primary stays connected. */
export const ROUTER_PROBE_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Consecutive error REPLIES (the signer answered, with an error) before the
 * signer is treated as not a Heartwood. Timeouts never count towards this. */
export const MAX_ERROR_REPLIES = 3;

/** Consecutive timeouts (no answer at all) before giving up: a generic
 * bunker that silently ignores unknown methods would otherwise be probed
 * forever. A later reconnect or unlock starts a fresh probe. */
export const MAX_CONSECUTIVE_TIMEOUTS = 5;

class ProbeTimeoutError extends Error {
  constructor() { super('heartwood_capabilities timed out'); }
}

/**
 * Only the SIGNER answering with an error is evidence about what the signer
 * is. nostr-tools' BunkerSigner rejects with the reply's `error` STRING in
 * that case; everything it throws as an Error — a relay publish failure
 * (AggregateError from Promise.any), "signer is not open anymore", our own
 * "Not connected" — is transport, and says nothing about the signer.
 */
export function classifyProbeError(err: unknown): Exclude<RouterProbeOutcome, { kind: 'router' } | { kind: 'unsupported' }> {
  if (typeof err === 'string') return { kind: 'error-reply' };
  if (err instanceof ProbeTimeoutError || err instanceof BunkerRequestTimeoutError) return { kind: 'transient', reason: 'timeout' };
  return { kind: 'transient', reason: 'transport' };
}

export type RouterProbeOutcome =
  | { kind: 'router'; router: BunkerBackendRouter }
  | { kind: 'unsupported' }
  | { kind: 'error-reply' }
  | { kind: 'transient'; reason: 'timeout' | 'transport' };

/**
 * Where per-persona routing stands on the current pairing, for honest UI copy
 * (instead of "no local signing key" while the signer is merely slow):
 * - `probing`     first capabilities probe in flight
 * - `retrying`    the signer has not answered the probe yet; backing off
 * - `ready`       router installed
 * - `unsupported` the signer answered and is not a Heartwood (NP-only), or
 *                 never answered the probe at all after repeated timeouts
 */
export type RouterProbeState = 'probing' | 'retrying' | 'ready' | 'unsupported';

export interface ProbeWithRetryOptions {
  primary: BunkerSigningBackend;
  clientSecretHex: string;
  /** False once this probe has been superseded (generation guard) — the loop
   * stops, and a router it already built is destroyed, never returned. */
  isCurrent: () => boolean;
  onState?: (state: RouterProbeState) => void;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  makeBackend?: MakeBackend;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Probe `heartwood_capabilities`, retrying with backoff for as long as the
 * probe is current and the primary is still connected (a destroyed primary
 * has an empty pubkey). Resolves to the router, or `null` when the signer is
 * definitely not a Heartwood or the probe was superseded / lost its primary.
 */
export async function createRouterWithRetry(opts: ProbeWithRetryOptions): Promise<BunkerBackendRouter | null> {
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : ROUTER_PROBE_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const alive = () => opts.isCurrent() && !!opts.primary.activePublicKeyHex;
  const report = (s: RouterProbeState) => { if (opts.isCurrent()) opts.onState?.(s); };
  let errorReplies = 0;
  let timeouts = 0;
  let attempt = 0;
  report('probing');
  while (alive()) {
    const outcome = await BunkerBackendRouter.probe(opts.primary, opts.clientSecretHex, opts.makeBackend, opts.timeoutMs);
    if (outcome.kind === 'router') {
      if (!opts.isCurrent()) { outcome.router.destroy(); return null; }
      report('ready');
      return outcome.router;
    }
    if (!alive()) return null;
    if (outcome.kind === 'unsupported') { report('unsupported'); return null; }
    if (outcome.kind === 'error-reply') {
      errorReplies++;
      if (errorReplies >= MAX_ERROR_REPLIES) { report('unsupported'); return null; }
    } else {
      errorReplies = 0;
    }
    if (outcome.kind === 'transient' && outcome.reason === 'timeout') {
      timeouts++;
      if (timeouts >= MAX_CONSECUTIVE_TIMEOUTS) { report('unsupported'); return null; }
    } else {
      timeouts = 0;
    }
    report('retrying');
    await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
    attempt++;
  }
  return null;
}

/**
 * Honest copy for "this slot has no local key and no device route right now".
 * The old single line ("no local signing key … connect a signer") was shown
 * for a locked app and a slow probe alike, and sent users hunting for a
 * signer that was already paired.
 */
export function routedSignerUnavailableMessage(input: {
  unlocked: boolean;
  signingMode: string | undefined;
  signerStatus: 'connected' | 'connecting' | 'unavailable' | null;
  routerProbeState: RouterProbeState | null;
}): string {
  if (!input.unlocked) return 'Unlock Signet to sign as this persona — your signer reconnects after unlock.';
  if (input.signingMode === 'bunker') {
    if (input.signerStatus === 'connecting' || (input.signerStatus === 'connected' && input.routerProbeState === null)) {
      return 'Connecting to your signer. Try again in a moment.';
    }
    if (input.signerStatus !== 'connected') {
      return 'Your signer is not reachable right now. Check it is online, then try again.';
    }
    if (input.routerProbeState === 'probing' || input.routerProbeState === 'retrying') {
      return 'Your signer is connected but has not answered for this persona yet. Retrying — try again in a moment.';
    }
    if (input.routerProbeState === 'unsupported') {
      return 'Your signer only signs for one identity. Per-persona signing needs a Heartwood.';
    }
  }
  if (input.signingMode === 'paired-child') {
    // A paired-child install signs through the family signer its guardian
    // set up — never a signer the child is expected to connect or fix.
    if (input.signerStatus === 'connecting' || (input.signerStatus === 'connected' && input.routerProbeState === null)) {
      return 'Connecting to your family signer. Try again in a moment.';
    }
    if (input.signerStatus !== 'connected') {
      return "Your family signer isn't reachable right now. Your keys live on your guardian's device, so try again once it is online.";
    }
    if (input.routerProbeState === 'probing' || input.routerProbeState === 'retrying') {
      return 'Your family signer is connected but has not answered for this persona yet. Try again in a moment.';
    }
    if (input.routerProbeState === 'unsupported') {
      return 'Your family signer can only sign as your main identity. Ask your guardian about signing as this persona.';
    }
    return "This persona's key lives on your guardian's device, and it isn't reachable for this persona right now. Try again in a moment.";
  }
  return 'This persona has no local signing key on this device. Connect a signer that supports per-persona keys.';
}

/**
 * Hands out per-slot bunker backends over one Heartwood pairing. Created by
 * probing heartwood_capabilities on the already-connected primary backend;
 * a null router means "generic bunker — NP-only, keep legacy behaviour".
 * destroy() tears down the routes it created but never the primary (App.tsx
 * owns that lifecycle).
 */
export class BunkerBackendRouter {
  readonly primary: BunkerSigningBackend;
  readonly capabilities: HeartwoodCapabilities;
  private clientSecretHex: string;
  private readonly makeBackend: MakeBackend;
  private readonly routes = new Map<string, RoutedBunkerSigningBackend>();
  private destroyed = false;

  private constructor(primary: BunkerSigningBackend, clientSecretHex: string, capabilities: HeartwoodCapabilities, makeBackend: MakeBackend) {
    this.primary = primary;
    this.clientSecretHex = clientSecretHex;
    this.capabilities = capabilities;
    this.makeBackend = makeBackend;
  }

  static async create(primary: BunkerSigningBackend, clientSecretHex: string, makeBackend: MakeBackend = defaultMakeBackend): Promise<BunkerBackendRouter | null> {
    const outcome = await BunkerBackendRouter.probe(primary, clientSecretHex, makeBackend);
    return outcome.kind === 'router' ? outcome.router : null;
  }

  /**
   * One capabilities probe, with the failure KIND kept rather than collapsed
   * to `null` — a caller that retries needs to tell "this is not a Heartwood"
   * (a definite answer; retrying cannot change it) from "no answer yet"
   * (timed out, not connected — worth another go).
   */
  static async probe(
    primary: BunkerSigningBackend,
    clientSecretHex: string,
    makeBackend: MakeBackend = defaultMakeBackend,
    timeoutMs: number = PROBE_TIMEOUT_MS,
  ): Promise<RouterProbeOutcome> {
    let raw: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([
        // The backend's own timeout also drops BunkerSigner's orphaned
        // listener; the race below is a backstop for backends without one.
        primary.request('heartwood_capabilities', [], timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs + 1_000);
        }),
      ]);
    } catch (err) {
      return classifyProbeError(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const caps = parseHeartwoodCapabilities(raw);
    if (!caps || !caps.methods.includes('sign_event')) return { kind: 'unsupported' };
    return { kind: 'router', router: new BunkerBackendRouter(primary, clientSecretHex, caps, makeBackend) };
  }

  backendFor(slotPubkeyHex: string | undefined | null): DecryptingSigningBackend | null {
    if (this.destroyed) return null;
    const pk = (slotPubkeyHex || '').trim().toLowerCase();
    if (!HEX64_RE.test(pk)) return null;
    if (pk === this.primary.activePublicKeyHex.toLowerCase()) return this.primary;
    let route = this.routes.get(pk);
    if (route?.isDestroyed) {
      // Cached route was destroyed by a consumer (e.g. App.tsx's backend
      // effect teardown on lock/dependant-switch) — drop it and mint a
      // fresh one instead of handing back a permanently-dead backend.
      this.routes.delete(pk);
      route = undefined;
    }
    if (!route) {
      let uri: string;
      try {
        uri = buildSlotBunkerUri(this.primary.bunkerUri, pk);
      } catch {
        return null;
      }
      route = new RoutedBunkerSigningBackend(this.clientSecretHex, uri, pk, this.makeBackend);
      this.routes.set(pk, route);
    }
    return route;
  }

  destroy(): void {
    this.destroyed = true;
    this.routes.forEach((r) => r.destroy());
    this.routes.clear();
    this.clientSecretHex = '0'.repeat(64);
  }
}

/**
 * The Natural Person's device-signing backend. Thin alias for the generic slot
 * resolver — kept because "never write `bunkerBackend ?? nip07Backend ??
 * backends?.naturalPerson` again, use `npBunkerBackend`" is a rule with call
 * sites all over App.tsx.
 */
export function resolveNpBunkerBackend(
  primary: BunkerSigningBackend | null,
  router: BunkerBackendRouter | null,
  npPubkeyHex: string | undefined | null,
): DecryptingSigningBackend | null {
  return resolveSlotBunkerBackend(primary, router, npPubkeyHex);
}

/**
 * Resolve the device-signing backend for ONE slot pubkey.
 *
 * On a family bunker the primary pairing is bound to the master/tree-root
 * pubkey, and every owner slot (NP, persona, extras, Pro) is a derived route
 * with a DIFFERENT pubkey (an earlier hardware finding). Signing a slot's
 * surfaces through the primary would sign as the wrong identity and leak the
 * never-shown root — so every slot-signing seam in App.tsx must resolve through
 * this, never `bunkerBackend` directly.
 *
 * Rule:
 * - no primary, or primary not yet connected (its pubkey is only known after
 *   `reconnect` resolves) → `null`. Handing out an unconnected primary is not
 *   harmless: `BunkerSigningBackend` queues requests before connect, so the
 *   The cross-device sync rails / audit inbox would fire NIP-44 requests at whatever the
 *   primary turns out to be — on the family bunker that is the master, and
 *   on 0.16.0 firmware each such request can occupy the device's 30-second
 *   approval loop ahead of our own `connect` (an earlier hardware-bench run).
 * - slot pubkey unknown (an nsec-imported / NIP-07 identity and a paired-child
 *   stub all have an empty persona pubkey) → `null`. Never the primary: on a
 *   family bunker that is the master.
 * - primary bound to the slot itself (legacy NP-only `bunker://`; paired-child,
 *   where the identity IS the dependant the guardian phone serves) → the
 *   primary.
 * - primary bound to some OTHER pubkey → the router's route for that slot;
 *   `null` when there is no usable router (capabilities probe pending or
 *   failed). Never the master.
 */
export function resolveSlotBunkerBackend(
  primary: BunkerSigningBackend | null,
  router: BunkerBackendRouter | null,
  slotPubkeyHex: string | undefined | null,
): DecryptingSigningBackend | null {
  if (!primary) return null;
  const primaryPk = (primary.activePublicKeyHex || '').trim().toLowerCase();
  if (!primaryPk) return null; // not connected yet — nothing may address it
  const slot = (slotPubkeyHex || '').trim().toLowerCase();
  // An unknown slot pubkey resolves to `null`, NEVER the primary. A slot with
  // no pubkey is a real shape, not just "identity still loading": an
  // nsec-imported or NIP-07 identity and a paired-child stub all carry
  // `persona.publicKey === ''`. On a family bunker the primary is the master,
  // so collapsing an unknown slot onto it would hand out exactly the key this
  // resolver exists to withhold.
  if (!slot) return null;
  if (primaryPk === slot) return primary;
  return router?.backendFor(slot) ?? null;
}

/**
 * Which backend serves this app's own NIP-46 SERVER role — the identity a
 * generic `nostrconnect://` pairing binds to (spec §8).
 *
 * It is the backend of `primaryKeypair`, not always the Natural Person. A
 * pairing made while the real identity is dormant must not bind the remote app
 * to the real-name pubkey: if it did, activating the legal name later would
 * leak it to every app paired before. Existing real-name users are unaffected —
 * their primary IS the natural person.
 *
 * There is deliberately NO cross-slot fallback. Serving a persona-primary
 * identity with the NP key would reintroduce exactly the leak this exists to
 * prevent, so an unservable primary resolves to `null` and the server simply
 * has no owner route until a backend for that slot exists.
 *
 * Per-slot owner routes (`persona-bunker-routes.ts`) are unchanged: they are
 * built from the individual slot backends and are unaffected by which slot is
 * primary.
 */
export function resolveServerTransportBackend(input: {
  primaryKeypair: 'natural-person' | 'persona';
  /** Device route for the NP slot — `resolveNpBunkerBackend`'s output. */
  npBunkerBackend: DecryptingSigningBackend | null;
  /** Device route for the persona slot — `resolveSlotBunkerBackend`'s output. */
  personaBunkerBackend: DecryptingSigningBackend | null;
  /** Browser-extension backend, if connected. Holds exactly one key. */
  nip07Backend: DecryptingSigningBackend | null;
  localNaturalPerson: DecryptingSigningBackend | null;
  localPersona: DecryptingSigningBackend | null;
}): DecryptingSigningBackend | null {
  const {
    primaryKeypair, npBunkerBackend, personaBunkerBackend,
    nip07Backend, localNaturalPerson, localPersona,
  } = input;

  const wanted = primaryKeypair === 'persona' ? localPersona : localNaturalPerson;
  const routed = primaryKeypair === 'persona' ? personaBunkerBackend : npBunkerBackend;
  if (routed) return routed;

  // A NIP-07 extension holds one key. Serve from it only when that key IS the
  // primary slot's key — matched on the pubkey, never assumed from the mode.
  if (nip07Backend && wanted) {
    const ext = (nip07Backend.activePublicKeyHex || '').trim().toLowerCase();
    const slot = (wanted.activePublicKeyHex || '').trim().toLowerCase();
    if (ext && ext === slot) return nip07Backend;
  }
  // A NIP-07 install has no local backends at all; accept the extension as the
  // primary slot's key when there is nothing to contradict it.
  if (nip07Backend && !localNaturalPerson && !localPersona) return nip07Backend;

  return wanted;
}
