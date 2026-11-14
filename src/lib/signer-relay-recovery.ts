/**
 * Find the Heartwood again when the owner-mode signer link goes deaf.
 *
 * The link (`AppPreferences.bunkerUri`, `bunker://<master>?relay=…&secret=…`)
 * keeps the relays it was paired on. When the device stops listening there
 * (a dead relay, a Sapwood reorder, a low-heap device keeping only its first
 * relay live) the link stays deaf and re-pairing would mint a new client key.
 *
 * The rule everything rests on: a relay goes into the link ONLY after the
 * Heartwood has answered on it over NIP-46, as the link's own master pubkey,
 * to this install's existing client key. Every list below is only a source of
 * CANDIDATES. Nothing from a sign-in request, QR, site, contact or other
 * outside input ever enters one.
 *
 * All I/O is injected so the orchestration is testable; `App.tsx` holds only
 * the glue. The probe itself lives in `signer-relay-probe.ts`.
 */
import { isValidRelayUrl } from './relay-url';

export const MAX_CANDIDATES = 10;
/** At most this many candidates from any one source, so a long operator
 *  credential can't crowd out the link's own relays or the defaults. */
export const MAX_PER_SOURCE = 3;
export const MAX_LINK_RELAYS = 5;
export const PROBE_TIMEOUT_MS = 8_000;
export const OPERATOR_QUERY_TIMEOUT_MS = 8_000;

const HEX64 = /^[0-9a-f]{64}$/;

/** Validate (wss://, ws:// only for loopback) and normalise (lowercase scheme
 *  and host, drop one trailing slash). `null` for anything else. */
export function normaliseRelay(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 512 || !isValidRelayUrl(t)) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if (u.username || u.password || !u.hostname) return null;
  const href = u.href;
  return href.endsWith('/') ? href.slice(0, -1) : href;
}

function normaliseAll(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const r of list ?? []) {
    const n = normaliseRelay(r);
    if (n) out.push(n);
  }
  return out;
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
}

// ─── The link ───────────────────────────────────────────────────────────────

export interface ParsedLink {
  /** The link's master pubkey, lowercase 64 hex. */
  master: string;
  /** The link's current relays, validated and normalised, in order. */
  relays: string[];
}

export function parseLink(uri: string | undefined | null): ParsedLink | null {
  if (typeof uri !== 'string' || !uri.startsWith('bunker://')) return null;
  const q = uri.indexOf('?');
  const master = (q < 0 ? uri.slice('bunker://'.length) : uri.slice('bunker://'.length, q)).toLowerCase();
  if (!HEX64.test(master)) return null;
  const relays: string[] = [];
  if (q >= 0) {
    for (const pair of uri.slice(q + 1).split('&')) {
      if (!pair.startsWith('relay=')) continue;
      const v = new URLSearchParams(pair).get('relay');
      const n = v === null ? null : normaliseRelay(v);
      if (n) relays.push(n);
    }
  }
  return { master, relays: dedupe(relays) };
}

/** `encodeURIComponent` leaves `! ~ * ' ( )` bare, but nostr-tools' bunker
 *  regex (`[?\/\w:.=&%-]*`) rejects them, so they are percent-encoded too. */
function encodeRelayParam(relay: string): string {
  return encodeURIComponent(relay).replace(/[!~*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The shape nostr-tools' `parseBunkerInput` accepts for a `bunker://` URI. */
const BUNKER_URI_SHAPE = /^bunker:\/\/([0-9a-f]{64})\??([?\/\w:.=&%-]*)$/;

/** True when `uri` is one the reconnect will parse back to this master and
 *  exactly these relays (in order). Never write a link that fails this. */
export function linkRoundTrips(uri: string, master: string, relays: readonly string[]): boolean {
  if (!BUNKER_URI_SHAPE.test(uri)) return false;
  const back = parseLink(uri);
  return !!back && back.master === master && sameRelayList(back.relays, relays);
}

/** Replace ONLY the `relay=` pairs: the pubkey and every other pair
 *  (including `secret`) stay byte-identical. The new relays go first. */
export function rewriteBunkerRelays(uri: string, relays: readonly string[]): string {
  const q = uri.indexOf('?');
  const base = q < 0 ? uri : uri.slice(0, q);
  const kept = q < 0 ? [] : uri.slice(q + 1).split('&').filter(p => !p.startsWith('relay='));
  const fresh = relays.map(r => `relay=${encodeRelayParam(r)}`);
  return `${base}?${[...fresh, ...kept].join('&')}`;
}

/** The new relay set: answering relays first (candidate order), then the old
 *  relays that did not answer (one failed probe is weak evidence a relay is
 *  gone), at most `MAX_LINK_RELAYS`. */
export function composeNewRelays(answering: readonly string[], oldRelays: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of [...answering, ...oldRelays]) {
    if (!out.includes(r)) out.push(r);
  }
  return out.slice(0, MAX_LINK_RELAYS);
}

export function sameRelayList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

// ─── Candidates ─────────────────────────────────────────────────────────────

export interface CandidateSources {
  /** Operator-reported relays, already gated on the device matching the link. */
  operatorReported: readonly string[];
  /** The operator credential's relays, already gated on the device matching
   *  the link (the same rule as `operatorReported`). */
  operatorCredential: readonly string[];
  link: readonly string[];
  /** `preferences.relayUrl` and `preferences.relays`. */
  userRelays: readonly string[];
  /** `defaultRelays()`. */
  defaults: readonly string[];
}

/** Sources in order: operator-reported, the link's current relays, the
 *  operator credential's, the user's, the defaults. At most `MAX_PER_SOURCE`
 *  from each (validated, normalised, deduped), then deduped across sources
 *  and capped at `MAX_CANDIDATES`. */
export function collectCandidates(s: CandidateSources): string[] {
  const take = (list: readonly string[]) => dedupe(normaliseAll(list)).slice(0, MAX_PER_SOURCE);
  const all = [
    ...take(s.operatorReported),
    ...take(s.link),
    ...take(s.operatorCredential),
    ...take(s.userRelays),
    ...take(s.defaults),
  ];
  return dedupe(all).slice(0, MAX_CANDIDATES);
}

export interface OperatorChannel {
  /** The operator credential's device (master) pubkey. */
  deviceHex: string;
  /** The operator credential's own relays. */
  credentialRelays: readonly string[];
  /** `get_status`; `relaysLive` when the device reports it. */
  getStatus: () => Promise<{ relaysLive?: readonly string[] }>;
  /** `get_network_config`. */
  getNetworkConfig: () => Promise<{ relays: readonly string[]; trial: boolean }>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** What the device says it listens on, only when the operator client's device
 *  is the link's master. `relays_live` is preferred; else the configured list
 *  in its order, skipped while a trial is live. Any error, timeout or
 *  delegated-operator refusal gives `[]` silently. */
export async function resolveOperatorReported(
  op: OperatorChannel | null,
  master: string,
  timeoutMs: number = OPERATOR_QUERY_TIMEOUT_MS,
): Promise<string[]> {
  if (!op || op.deviceHex.toLowerCase() !== master.toLowerCase()) return [];
  // Both reads start together under ONE deadline, so a deaf operator channel
  // costs `timeoutMs`, not twice that. `relays_live` still wins.
  const status = withTimeout(op.getStatus(), timeoutMs).catch(() => null);
  const config = withTimeout(op.getNetworkConfig(), timeoutMs).catch(() => null);
  const s = await status;
  if (s?.relaysLive && s.relaysLive.length > 0) return [...s.relaysLive];
  const cfg = await config;
  return cfg && !cfg.trial ? [...cfg.relays] : [];
}

// ─── Probe orchestration ────────────────────────────────────────────────────

/** Ask the Heartwood on ONE relay; resolve with the pubkey it replied with. */
export type ProbeOne = (relay: string, signal: AbortSignal) => Promise<string>;

/** Probe every relay in parallel. A relay ANSWERS only when the reply arrives
 *  within `timeoutMs` and equals `master` (case-insensitive). Returns the
 *  answering relays in input order. Aborting `signal` aborts every probe. */
export async function probeRelays(
  relays: readonly string[],
  master: string,
  probeOne: ProbeOne,
  signal?: AbortSignal,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<string[]> {
  const want = master.toLowerCase();
  const results = await Promise.all(relays.map(async (relay) => {
    if (signal?.aborted) return false;
    const ctl = new AbortController();
    const onOuter = () => ctl.abort();
    signal?.addEventListener('abort', onOuter, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ctl.abort(); reject(new Error('timeout')); }, timeoutMs);
      });
      const reply = await Promise.race([probeOne(relay, ctl.signal), timedOut]);
      return !ctl.signal.aborted && typeof reply === 'string' && reply.trim().toLowerCase() === want;
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
      ctl.abort(); // closes anything the probe still holds
    }
  }));
  return relays.filter((_, i) => results[i]);
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/** One-run-per-unlock state, held in a ref by the caller. Reset on lock;
 *  `done` is cleared by a manual Retry (re-arm). */
export interface RecoveryGuard {
  running: boolean;
  done: boolean;
}

export function newRecoveryGuard(): RecoveryGuard {
  return { running: false, done: false };
}

export interface RecoverIo {
  signingMode: string | undefined;
  /** The LIVE signer status (a ref read, not a render-time snapshot). */
  getSignerStatus: () => 'connected' | 'connecting' | 'unavailable' | null;
  /** The unlock key the recovery starts with; null while locked. */
  startKey: string | null;
  /** The unlock key right now (null once locked). */
  currentKey: () => string | null;
  /** Bumped on every lock and unlock. A recovery belongs to ONE generation. */
  unlockGeneration: () => number;
  signal: AbortSignal;
  /** ONE raw read of the stored preferences: `prefs.bunkerUri` decrypted with
   *  `startKey`, `rawBunkerUri` exactly as stored (the compare-and-swap key). */
  loadPreferences: () => Promise<{
    prefs: { bunkerUri?: string; relayUrl?: string; relays?: ReadonlyArray<{ url: string; enabled?: boolean }> };
    rawBunkerUri: string | undefined;
  }>;
  loadClientSecret: () => Promise<string | null>;
  /** The operator channel, waiting up to 10 s for its client; null when none. */
  getOperator: (signal: AbortSignal) => Promise<OperatorChannel | null>;
  defaultRelays: () => string[];
  probeOne: (clientSecretHex: string, master: string) => ProbeOne;
  /** Encrypt the new URI with the unlock key (PBKDF2 can't run inside an IDB
   *  transaction, so it is done before the swap). */
  encryptUri: (uri: string, key: string) => Promise<string>;
  /** ONE compare-and-swap: replace the stored ciphertext only if it still
   *  equals `expectedCiphertext` and the mode is still bunker. */
  swapBunkerUri: (expectedCiphertext: string, newCiphertext: string) => Promise<boolean>;
  reloadPreferences: (key: string) => Promise<void>;
  retry: () => Promise<void>;
  /** Told when a real run starts and ends (drives the banner copy). */
  onRunning?: (running: boolean) => void;
}

export type RecoverOutcome =
  | 'skipped'
  | 'no-link'
  | 'none-answered'
  | 'unchanged'
  | 'unusable'
  | 'aborted'
  | 'recovered';

// A generic (non-Heartwood) bunker is accepted as is: the probe leans on a
// Heartwood fact (an authorised client's `get_public_key` is auto-approved).
// A bunker that prompts for it, refuses it or stays silent simply does not
// answer, so nothing is written. It fails safe.
export async function recoverSignerLink(io: RecoverIo, guard: RecoveryGuard): Promise<RecoverOutcome> {
  if (io.signingMode !== 'bunker' || io.getSignerStatus() !== 'unavailable' || !io.startKey) return 'skipped';
  if (guard.running || guard.done) return 'skipped';
  guard.running = true;
  guard.done = true;
  io.onRunning?.(true);
  const key = io.startKey;
  const startGen = io.unlockGeneration();
  // Still THIS unlock's failed reconnect: same key and unlock generation, not
  // aborted, and the signer is STILL unavailable (a manual retry or another
  // path may have connected it meanwhile).
  const live = () =>
    io.currentKey() === key
    && io.unlockGeneration() === startGen
    && !io.signal.aborted
    && io.getSignerStatus() === 'unavailable';
  let secret: string | null = null;
  try {
    const stored = await io.loadPreferences();
    if (!live()) return 'aborted';
    const prefs = stored.prefs;
    const rawUri = stored.rawBunkerUri;
    const link = parseLink(prefs.bunkerUri);
    if (!link || !prefs.bunkerUri || !rawUri) return 'no-link';
    secret = await io.loadClientSecret();
    if (!secret) return 'no-link';
    if (!live()) return 'aborted';

    const userRelays = [
      ...(prefs.relayUrl ? [prefs.relayUrl] : []),
      ...(prefs.relays ?? []).filter(r => r.enabled !== false).map(r => r.url),
    ];
    const defaults = io.defaultRelays();
    const probeOne = io.probeOne(secret, link.master);

    const probed = new Set<string>();
    const answered = new Set<string>();
    const settling: Promise<void>[] = [];
    // The whole run probes at most MAX_CANDIDATES relays: each probe tells one
    // more relay that this client key talks to this master. `relays` is in
    // priority order, so a full budget drops the tail.
    const launch = (relays: readonly string[]) => {
      const fresh = relays.filter(r => !probed.has(r)).slice(0, Math.max(0, MAX_CANDIDATES - probed.size));
      if (fresh.length === 0) return;
      fresh.forEach(r => probed.add(r));
      settling.push(probeRelays(fresh, link.master, probeOne, io.signal)
        .then(a => { a.forEach(r => answered.add(r)); }));
    };

    // The non-operator candidates start AT ONCE, in parallel with the
    // operator read (which can cost its whole deadline when that channel is
    // deaf too).
    const first = collectCandidates({ operatorReported: [], operatorCredential: [], link: link.relays, userRelays, defaults });
    launch(first);
    let order = first;
    try {
      const op = await io.getOperator(io.signal).catch(() => null);
      if (live()) {
        const reported = await resolveOperatorReported(op, link.master);
        if (live()) {
          // The credential's relays follow the same device rule as the
          // operator-reported ones.
          const credentialRelays = op && op.deviceHex.toLowerCase() === link.master ? op.credentialRelays : [];
          order = collectCandidates({
            operatorReported: reported,
            operatorCredential: credentialRelays,
            link: link.relays,
            userRelays,
            defaults,
          });
          launch(order);
        }
      }
    } catch { /* operator trouble never blocks the probes already running */ }
    // The run ends when every started probe has settled.
    await Promise.all(settling);
    if (!live()) return 'aborted';

    const answering = dedupe([...order, ...first]).filter(r => answered.has(r));
    if (answering.length === 0) return 'none-answered';

    const next = composeNewRelays(answering, link.relays);
    if (sameRelayList(next, link.relays)) {
      // The device answered on the link's own relays: the unlock failure was
      // transient. Nothing to write; one retry reconnects.
      await io.retry();
      return 'unchanged';
    }

    // Never write a link the reconnect would fail to parse.
    const newUri = rewriteBunkerRelays(prefs.bunkerUri, next);
    if (!linkRoundTrips(newUri, link.master, next)) return 'unusable';

    const ciphertext = await io.encryptUri(newUri, key);
    // Right before writing: still this unlock, still unavailable?
    if (!live()) return 'aborted';
    if (!(await io.swapBunkerUri(rawUri, ciphertext))) return 'aborted';
    // The new link is stored: keep React state in step with it whenever this
    // is still the same unlock key, even if the signer status moved on. Only
    // the retry needs the full live() check.
    if (io.currentKey() !== key) return 'aborted';
    await io.reloadPreferences(key);
    if (!live()) return 'aborted';
    await io.retry();
    return 'recovered';
  } catch {
    return 'aborted';
  } finally {
    secret = null;
    guard.running = false;
    io.onRunning?.(false);
  }
}
