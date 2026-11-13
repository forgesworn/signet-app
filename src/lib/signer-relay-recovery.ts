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

export const MAX_CANDIDATES = 8;
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

/** Replace ONLY the `relay=` pairs: the pubkey and every other pair
 *  (including `secret`) stay byte-identical. The new relays go first. */
export function rewriteBunkerRelays(uri: string, relays: readonly string[]): string {
  const q = uri.indexOf('?');
  const base = q < 0 ? uri : uri.slice(0, q);
  const kept = q < 0 ? [] : uri.slice(q + 1).split('&').filter(p => !p.startsWith('relay='));
  const fresh = relays.map(r => `relay=${encodeURIComponent(r)}`);
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
  operatorCredential: readonly string[];
  link: readonly string[];
  /** `preferences.relayUrl` and `preferences.relays`. */
  userRelays: readonly string[];
  /** `defaultRelays()`. */
  defaults: readonly string[];
}

export function collectCandidates(s: CandidateSources): string[] {
  const all = [
    ...normaliseAll(s.operatorReported),
    ...normaliseAll(s.operatorCredential),
    ...normaliseAll(s.link),
    ...normaliseAll(s.userRelays),
    ...normaliseAll(s.defaults),
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
  try {
    const status = await withTimeout(op.getStatus(), timeoutMs);
    if (status.relaysLive && status.relaysLive.length > 0) return [...status.relaysLive];
  } catch { /* fall through to the configured list */ }
  try {
    const cfg = await withTimeout(op.getNetworkConfig(), timeoutMs);
    if (!cfg.trial) return [...cfg.relays];
  } catch { /* silent */ }
  return [];
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
  signerStatus: 'connected' | 'connecting' | 'unavailable' | null;
  /** The unlock key the recovery starts with; null while locked. */
  startKey: string | null;
  /** The unlock key right now (null once locked). */
  currentKey: () => string | null;
  signal: AbortSignal;
  /** Fresh from IndexedDB, decrypted with `startKey`. */
  loadPreferences: () => Promise<{ bunkerUri?: string; relayUrl?: string; relays?: ReadonlyArray<{ url: string; enabled?: boolean }> }>;
  loadClientSecret: () => Promise<string | null>;
  /** The operator channel, waiting up to 10 s for its client; null when none. */
  getOperator: (signal: AbortSignal) => Promise<OperatorChannel | null>;
  defaultRelays: () => string[];
  probeOne: (clientSecretHex: string, master: string) => ProbeOne;
  /** Read-modify-write of the stored link; the caller has checked the key. */
  saveBunkerUri: (uri: string, key: string) => Promise<void>;
  reloadPreferences: (key: string) => Promise<void>;
  retry: () => Promise<void>;
}

export type RecoverOutcome =
  | 'skipped'
  | 'no-link'
  | 'none-answered'
  | 'unchanged'
  | 'aborted'
  | 'recovered';

export async function recoverSignerLink(io: RecoverIo, guard: RecoveryGuard): Promise<RecoverOutcome> {
  if (io.signingMode !== 'bunker' || io.signerStatus !== 'unavailable' || !io.startKey) return 'skipped';
  if (guard.running || guard.done) return 'skipped';
  guard.running = true;
  guard.done = true;
  const key = io.startKey;
  const stillCurrent = () => io.currentKey() === key && !io.signal.aborted;
  let secret: string | null = null;
  try {
    const prefs = await io.loadPreferences();
    if (!stillCurrent()) return 'aborted';
    const link = parseLink(prefs.bunkerUri);
    if (!link || !prefs.bunkerUri) return 'no-link';
    secret = await io.loadClientSecret();
    if (!secret) return 'no-link';
    if (!stillCurrent()) return 'aborted';

    const op = await io.getOperator(io.signal).catch(() => null);
    if (!stillCurrent()) return 'aborted';
    const operatorReported = await resolveOperatorReported(op, link.master);
    if (!stillCurrent()) return 'aborted';

    const userRelays = [
      ...(prefs.relayUrl ? [prefs.relayUrl] : []),
      ...(prefs.relays ?? []).filter(r => r.enabled !== false).map(r => r.url),
    ];
    const candidates = collectCandidates({
      operatorReported,
      operatorCredential: op?.credentialRelays ?? [],
      link: link.relays,
      userRelays,
      defaults: io.defaultRelays(),
    });
    if (candidates.length === 0) return 'none-answered';

    const answering = await probeRelays(candidates, link.master, io.probeOne(secret, link.master), io.signal);
    if (!stillCurrent()) return 'aborted';
    if (answering.length === 0) return 'none-answered';

    const next = composeNewRelays(answering, link.relays);
    if (sameRelayList(next, link.relays)) return 'unchanged';

    // Right before writing: still the unlock this recovery started with?
    if (!stillCurrent()) return 'aborted';
    await io.saveBunkerUri(rewriteBunkerRelays(prefs.bunkerUri, next), key);
    if (!stillCurrent()) return 'aborted';
    await io.reloadPreferences(key);
    if (!stillCurrent()) return 'aborted';
    await io.retry();
    return 'recovered';
  } catch {
    return 'aborted';
  } finally {
    secret = null;
    guard.running = false;
  }
}
