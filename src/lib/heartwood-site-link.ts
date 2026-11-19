/**
 * "Straight to my Heartwood" for sign-in, asked of the Heartwood over this
 * phone's OWN NIP-46 owner pairing (`heartwood_link_create` and friends), so a
 * phone with no operator key can offer it. The device shows one LINK card and
 * makes the link only on a 2 s hold.
 *
 * Everything here runs on an injected request function (the primary pairing's
 * `BunkerSigningBackend.request`), so the timing rules are tested without the
 * app:
 * - one create on the wire at a time, and never a second create while a card
 *   may still be up (the device refuses BOTH on a different ask);
 * - a lost reply is found again by label, but only while the device still
 *   remembers it (60 s after the hold); after that the record is kept as
 *   uncertain, never dropped;
 * - a device error string is a real answer: no link was made.
 *
 * The link's secret is in the create reply. It is never logged, stored or
 * shown, and none of the errors here carry it.
 */
import type { SlotPolicyUpdate } from './heartwood-mgmt-types';
import type { CreateClientV2Reply } from './heartwood-mgmt';
import { HeartwoodCopyError, DEVICE_TEXT_MAX } from './heartwood-mgmt-error-copy';
import { BunkerRequestTimeoutError } from './signing-backend';

export const SITE_LINK_CREATE = 'heartwood_link_create';
export const SITE_LINK_STATUS = 'heartwood_link_status';
export const SITE_LINK_REVOKE = 'heartwood_link_revoke';

/** Longer than the worst case a card can take (90 s queued + its 30 s window). */
export const SITE_LINK_CREATE_TIMEOUT_MS = 125_000;
/** Status checks while the create waits: every 10 s, from 10 s. */
export const SITE_LINK_POLL_MS = 10_000;
/** After the status shows the hold, how long the create's own reply gets before the idempotent resend. */
export const SITE_LINK_RESEND_AFTER_HOLD_MS = 5_000;
/** Status and revoke never raise a card: a short listener. */
export const SITE_LINK_QUICK_TIMEOUT_MS = 8_000;
/** A resend made after the window closed (the hold was seen at the last moment). */
export const SITE_LINK_FINAL_RESEND_TIMEOUT_MS = 15_000;
/** The whole Straight phase of one sign-in. */
export const SITE_LINK_BUDGET_MS = 180_000;
/** A request is fresh for 5 minutes; the link must be delivered inside that. */
export const SITE_LINK_FRESHNESS_MS = 300_000;
/** A create (first or retry) starts only with at least this much of both left. */
export const SITE_LINK_MIN_ATTEMPT_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const LINK_LABEL_MAX_BYTES = 64;

/** The Heartwood lists all three link methods in `heartwood_capabilities`. */
export function supportsSiteLinks(methods: readonly string[] | null | undefined): boolean {
  return !!methods && methods.includes(SITE_LINK_CREATE) && methods.includes(SITE_LINK_STATUS) && methods.includes(SITE_LINK_REVOKE);
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** Shown at once while a device create is waiting for the hold. */
export function signInLinkHoldCopy(host: string): string {
  return `Hold the button on your Heartwood for 2 seconds. It shows LINK ${host}. A short press cancels.`;
}
export const SITE_LINK_BUSY_COPY = 'Your Heartwood is busy with another request. Try again shortly.';
export const SITE_LINK_NOT_OWNER_COPY = "This phone isn't paired with full access to your Heartwood.";
export const SITE_LINK_NO_ANSWER_COPY = "Your Heartwood didn't answer. Check it's on and online, then try again, or choose the other option.";
export const SITE_LINK_TOO_OLD_COPY = 'This sign-in request is too old to wait for your Heartwood. Start signing in again.';
/** The create's reply never came: the link may or may not be on the device. */
export const SITE_LINK_LOST_COPY = "Your Heartwood didn't confirm the link in time, so it wasn't used. If you held its button, the link may still be on your Heartwood: you can remove it in Sapwood.";
/** Disconnect on a link whose creation was never confirmed. */
export const SITE_LINK_UNCERTAIN_REVOKE_COPY = "This phone never heard back when this link was made, so it can't remove it from here. Remove it in Sapwood, then choose Forget on this phone.";
export const SITE_LINK_BAD_REPLY_COPY = 'Your Heartwood gave an unexpected answer. Try again.';

/**
 * One map from the device's error strings (exact firmware text, matched by
 * prefix) to plain words. `name` is the identity's name as this phone shows it.
 */
export function signInLinkDeviceErrorCopy(message: string, name: string): string {
  const m = message.trim();
  const who = name.trim() || 'this identity';
  if (m.startsWith('user denied')) return 'You cancelled it on your Heartwood.';
  if (m.startsWith('timeout')) return "Your Heartwood wasn't held in time. Try again in a minute.";
  if (m.startsWith('shown recently')) return 'Your Heartwood showed this a moment ago. Try again in a minute.';
  if (m.startsWith('another link request arrived')) return 'Another request reached your Heartwood at the same time, so it refused both. Try again in a minute.';
  if (m.startsWith("wider than this phone's access")) {
    return `This phone's own connection to ${who} can't sign everything without asking, so it can't give a site more. Widen it in Sapwood, or choose the other option.`;
  }
  if (m.startsWith('not approved for identity')) {
    return `This phone hasn't signed as ${who} on your Heartwood yet. Sign something as it first, or choose the other option.`;
  }
  if (m.startsWith('not an owner pairing')) return SITE_LINK_NOT_OWNER_COPY;
  if (m.startsWith('no room') || m.startsWith('storage_full')) return 'Your Heartwood has no room for another connection. Remove one in Sapwood.';
  if (m.startsWith('signer is busy')) return SITE_LINK_BUSY_COPY;
  if (m.startsWith('approval_changed')) return "Your Heartwood's connections changed while it was asking. Try again.";
  if (m.startsWith('identity not served')) return `Your Heartwood doesn't hold ${who}, or it is locked.`;
  return `Your Heartwood refused this: ${m.slice(0, DEVICE_TEXT_MAX)}.`;
}

/** The device answered, and no link was made: the pending record goes. */
export class SiteLinkRefusedError extends HeartwoodCopyError {
  readonly refused = true;
  constructor(message: string) { super(message); this.name = 'SiteLinkRefusedError'; }
}

/** No answer that can be trusted: a link may exist. The record is kept (uncertain). */
export class SiteLinkUncertainError extends HeartwoodCopyError {
  readonly uncertain = true;
  constructor(message: string) { super(message); this.name = 'SiteLinkUncertainError'; }
}

// ── Wire ────────────────────────────────────────────────────────────────────

export type SiteLinkRequest = (method: string, params: string[], timeoutMs?: number) => Promise<string>;

/** Printable ASCII and at most 64 bytes, or the device refuses it as malformed. */
export function isSiteLinkLabel(label: string): boolean {
  return label.length > 0 && label.length <= LINK_LABEL_MAX_BYTES && /^[\x20-\x7e]+$/.test(label);
}

/**
 * `heartwood_link_create` params[0], as a JSON string. Only the three policy
 * keys the firmware takes: the escalate / petition / audit / bound-identity
 * fields of a slot policy are never sent. Built once per sign-in, so a resend
 * is byte-identical.
 */
export function siteLinkCreateParams(p: { identity: string; label: string; policy: SlotPolicyUpdate }): string {
  const identity = p.identity.toLowerCase();
  if (!HEX64.test(identity)) throw new Error('identity must be 64 hex chars');
  if (!isSiteLinkLabel(p.label)) throw new Error('label must be printable ASCII, at most 64 bytes');
  return JSON.stringify({
    identity,
    label: p.label,
    policy: {
      allowed_methods: [...p.policy.allowedMethods],
      allowed_kinds: [...p.policy.allowedKinds],
      auto_approve: p.policy.autoApprove,
    },
  });
}

export type SiteLinkTarget =
  | { identity: string; slotIndex: number; secretFingerprint: string }
  | { identity: string; label: string };

/** `heartwood_link_status` / `heartwood_link_revoke` params[0]: by slot and fingerprint, or by label (exactly one form). */
export function siteLinkTargetParams(t: SiteLinkTarget): string {
  const identity = t.identity.toLowerCase();
  if (!HEX64.test(identity)) throw new Error('identity must be 64 hex chars');
  if ('label' in t) return JSON.stringify({ identity, label: t.label });
  return JSON.stringify({ identity, slot_index: t.slotIndex, expected_secret_fingerprint: t.secretFingerprint.toLowerCase() });
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}
function isKindArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isInteger(x) && x >= 0);
}

/** A reply nothing can be read from: fails every field of the echo check. */
const EMPTY_CREATE_REPLY: CreateClientV2Reply = {
  slotIndex: null, secretFingerprint: '', label: '', npubHex: '', bunkerUri: '',
  policyVersion: null, allowedMethods: null, allowedKinds: null, autoApprove: null,
};

/**
 * The create reply, read as loosely as the wire allows; null unless it is a
 * JSON object. The echo check decides whether it is the link that was asked for.
 */
export function parseSiteLinkCreateReply(raw: unknown): CreateClientV2Reply | null {
  const r = parseObject(raw);
  if (!r) return null;
  const slot = r.slot_index;
  return {
    slotIndex: typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot <= 255 ? slot : null,
    secretFingerprint: typeof r.secret_fingerprint === 'string' ? r.secret_fingerprint.toLowerCase() : '',
    label: typeof r.label === 'string' ? r.label : '',
    npubHex: typeof r.npub_hex === 'string' ? r.npub_hex.toLowerCase() : '',
    bunkerUri: typeof r.bunker_uri === 'string' ? r.bunker_uri : '',
    policyVersion: typeof r.policy_version === 'number' ? r.policy_version : null,
    allowedMethods: isStringArray(r.allowed_methods) ? [...r.allowed_methods] : null,
    allowedKinds: isKindArray(r.allowed_kinds) ? [...r.allowed_kinds] : null,
    autoApprove: typeof r.auto_approve === 'boolean' ? r.auto_approve : null,
  };
}

/** `{ exists, bound }`; null when the answer is not that shape. */
export function parseSiteLinkStatus(raw: unknown): { exists: boolean; bound: boolean } | null {
  const r = parseObject(raw);
  if (!r || typeof r.exists !== 'boolean') return null;
  return { exists: r.exists, bound: r.bound === true };
}

/** `{ revoked: true, ... }` or the label form's `{ revoked: false, bound }`; null otherwise. */
export function parseSiteLinkRevoke(raw: unknown): { revoked: boolean; bound: boolean } | null {
  const r = parseObject(raw);
  if (!r || typeof r.revoked !== 'boolean') return null;
  return { revoked: r.revoked, bound: r.bound === true };
}

/** The device's own error text. nostr-tools rejects a NIP-46 error reply with the bare string; anything else is transport. */
export function deviceErrorText(e: unknown): string | null {
  return typeof e === 'string' ? e : null;
}

function isUnknownLink(msg: string): boolean { return msg.trim().startsWith('unknown link'); }
function isStaleSlot(msg: string): boolean { return msg.trim().startsWith('stale_client_slot'); }
function isApprovalChanged(msg: string): boolean { return msg.trim().startsWith('approval_changed'); }

/** The request threw before it could leave this phone (wrapped so it is told apart from a publish that may have gone). */
class NotSentError extends Error {
  constructor(readonly cause: unknown) { super('request not sent'); this.name = 'NotSentError'; }
}

/**
 * The event never reached a relay, so no card can be on the device: the backend
 * had no signer, the signer was closed, the request threw before sending, or
 * every relay publish failed. A publish that TIMED OUT may still have been
 * delivered, so an `AggregateError` holding one is not "not sent".
 */
function notSent(e: unknown): boolean {
  if (e instanceof NotSentError) return true;
  if (e instanceof AggregateError) {
    return !e.errors.some(c => c instanceof Error && /publish timed out/i.test(c.message));
  }
  return e instanceof Error && (e.message === 'Not connected to bunker' || /^this signer is not open/.test(e.message));
}

// ── The device-link lock ────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Serialises device creates, revokes and reconciles. A create can keep it past
 * its own return (`holdUntil`) while its card may still be up, so a second
 * create can never reach the device beside it. Not re-entrant.
 */
export class SiteLinkLock {
  private tail: Promise<void> = Promise.resolve();
  private creates = 0;
  private readonly subs = new Set<(inFlight: boolean) => void>();
  constructor(private readonly sleep: (ms: number) => Promise<void> = defaultSleep, private readonly now: () => number = () => Date.now()) {}

  /** A create holds the lock (including any time it is kept past its return). */
  get createInFlight(): boolean { return this.creates > 0; }

  subscribe(fn: (inFlight: boolean) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  private bump(d: number): void {
    const before = this.creates > 0;
    this.creates += d;
    const after = this.creates > 0;
    if (before !== after) for (const fn of this.subs) fn(after);
  }

  run<T>(task: (ctx: { holdUntil: (ms: number) => void }) => Promise<T>, opts: { create?: boolean } = {}): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(r => { release = r; });
    return (async () => {
      await prev;
      if (opts.create) this.bump(1);
      let until = 0;
      try {
        return await task({ holdUntil: ms => { until = Math.max(until, ms); } });
      } finally {
        const done = () => { if (opts.create) this.bump(-1); release(); };
        const wait = until - this.now();
        if (wait > 0) void this.sleep(wait).then(done, done);
        else done();
      }
    })();
  }
}

/** The one lock for this app. */
export const siteLinkLock = new SiteLinkLock();

// ── Create ──────────────────────────────────────────────────────────────────

type SendEvent =
  | { kind: 'reply'; raw: unknown }
  | { kind: 'refused'; message: string }
  | { kind: 'timeout' }
  | { kind: 'not-sent' }
  | { kind: 'transport' };

/** Every create sent for one attempt, and what each has answered so far. */
class Sends {
  private events: SendEvent[] = [];
  private cursor = 0;
  private outstanding = 0;
  private wake: () => void = () => {};
  private signal: Promise<void> = this.reset();

  private reset(): Promise<void> {
    this.signal = new Promise<void>(r => { this.wake = r; });
    return this.signal;
  }

  add(p: Promise<string>): void {
    this.outstanding++;
    const push = (e: SendEvent) => { this.outstanding--; this.events.push(e); this.wake(); this.reset(); };
    p.then(
      raw => push({ kind: 'reply', raw }),
      (e: unknown) => {
        const text = deviceErrorText(e);
        if (text !== null) push({ kind: 'refused', message: text });
        else if (e instanceof BunkerRequestTimeoutError) push({ kind: 'timeout' });
        else if (notSent(e)) push({ kind: 'not-sent' });
        else push({ kind: 'transport' });
      },
    );
  }

  /** The next event not yet read, if any. */
  take(): SendEvent | null {
    return this.cursor < this.events.length ? this.events[this.cursor++] : null;
  }

  get pending(): number { return this.outstanding; }

  /** Resolves when another event arrives (never consumes one). */
  changed(): Promise<void> { return this.signal; }
}

type AttemptOutcome =
  | { kind: 'reply'; raw: unknown }
  | { kind: 'refused'; message: string }
  | { kind: 'not-sent' }
  | { kind: 'lost'; sentAt: number };

type StatusSeen = 'unbound' | 'bound' | 'none';

export interface SiteLinkCreateArgs {
  request: SiteLinkRequest;
  identity: string;
  label: string;
  policy: SlotPolicyUpdate;
  /** Absolute ms: the end of the phase budget or of the request's freshness, whichever is first. */
  deadlineMs: number;
  /** The identity's name as this phone shows it (for the refusal copy). */
  name: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The hold line is up (true at each create sent, false once the wait is over). */
  onWaiting?: (waiting: boolean) => void;
  /** Keep the device-link lock until this time (a card may still be up). */
  holdLock?: (untilMs: number) => void;
}

async function statusByLabel(a: SiteLinkCreateArgs): Promise<StatusSeen> {
  try {
    const raw = await a.request(SITE_LINK_STATUS, [siteLinkTargetParams({ identity: a.identity, label: a.label })], SITE_LINK_QUICK_TIMEOUT_MS);
    const st = parseSiteLinkStatus(raw);
    if (!st || !st.exists) return 'none';
    return st.bound ? 'bound' : 'unbound';
  } catch {
    // `unknown link` (no hold yet, or too long ago), any other refusal, or no answer: nothing learnt.
    return 'none';
  }
}

async function oneAttempt(a: SiteLinkCreateArgs, params: string, windowMs: number): Promise<AttemptOutcome> {
  const now = a.now ?? Date.now;
  const sleep = a.sleep ?? defaultSleep;
  const sentAt = now();
  const windowEnd = sentAt + windowMs;
  const sends = new Sends();
  const send = (timeoutMs: number) => {
    let p: Promise<string>;
    try { p = a.request(SITE_LINK_CREATE, [params], timeoutMs); } catch (e) { p = Promise.reject(new NotSentError(e)); }
    sends.add(p);
  };
  send(windowMs);
  let heldAt: number | null = null;
  let resent = false;
  let nextPoll = sentAt + SITE_LINK_POLL_MS;
  const lost: AttemptOutcome = { kind: 'lost', sentAt };

  // Reads what the sends have said. A refusal after the hold is not "no link".
  const drain = (): AttemptOutcome | null => {
    for (let e = sends.take(); e; e = sends.take()) {
      if (e.kind === 'reply') return e;
      if (e.kind === 'refused') return heldAt === null && !resent ? e : lost;
      if (e.kind === 'not-sent' && heldAt === null && !resent && sends.pending === 0) return { kind: 'not-sent' };
      // Transport trouble: look at once, never resend because of it.
      if (e.kind === 'transport' && heldAt === null) nextPoll = now();
    }
    return null;
  };

  for (;;) {
    const got = drain();
    if (got) return got;
    const t = now();
    if (t >= windowEnd) break;
    if (heldAt !== null && !resent && t >= heldAt + SITE_LINK_RESEND_AFTER_HOLD_MS) {
      // The card is closed: the same request again is the device's idempotent retry (same link, no card).
      resent = true;
      send(Math.max(windowEnd - t, SITE_LINK_QUICK_TIMEOUT_MS));
      continue;
    }
    if (heldAt === null && t >= nextPoll) {
      const seen = await statusByLabel(a);
      nextPoll = now() + SITE_LINK_POLL_MS;
      if (seen === 'unbound') heldAt = now();
      else if (seen === 'bound') return drain() ?? lost;
      continue;
    }
    const wakeAt = Math.min(windowEnd, heldAt !== null && !resent ? heldAt + SITE_LINK_RESEND_AFTER_HOLD_MS : (heldAt === null ? nextPoll : windowEnd));
    await Promise.race([sends.changed(), sleep(Math.max(0, wakeAt - t))]);
  }

  // The window is over. One last look: a hold in the last seconds is still found by label.
  const last = drain();
  if (last) return last;
  if (heldAt === null) {
    const seen = await statusByLabel(a);
    if (seen === 'unbound') heldAt = now();
    else return drain() ?? lost;
  }
  if (!resent) {
    resent = true;
    send(SITE_LINK_FINAL_RESEND_TIMEOUT_MS);
  }
  const giveUp = now() + SITE_LINK_FINAL_RESEND_TIMEOUT_MS;
  while (sends.pending > 0 && now() < giveUp) {
    const got = drain();
    if (got) return got;
    await Promise.race([sends.changed(), sleep(Math.max(0, giveUp - now()))]);
  }
  return drain() ?? lost;
}

/**
 * Ask the Heartwood for a site link and wait for the hold. Resolves to the
 * device's reply (unverified: the caller's echo check decides). Throws
 * {@link SiteLinkRefusedError} when the device answered and nothing was made,
 * {@link SiteLinkUncertainError} when a link may exist. A first
 * `approval_changed` is asked again once, inside the budget.
 */
export async function createSiteLinkOnDevice(a: SiteLinkCreateArgs): Promise<CreateClientV2Reply> {
  const now = a.now ?? Date.now;
  // Nothing is sent when the request can't be built, so the caller's pending record goes.
  let params: string;
  try { params = siteLinkCreateParams(a); } catch (e) { throw new SiteLinkRefusedError(signInLinkDeviceErrorCopy(e instanceof Error ? e.message : 'malformed link request', a.name)); }
  let changedOnce = false;
  try {
    for (;;) {
      const left = a.deadlineMs - now();
      if (left < SITE_LINK_MIN_ATTEMPT_MS) {
        throw new SiteLinkRefusedError(changedOnce ? signInLinkDeviceErrorCopy('approval_changed', a.name) : SITE_LINK_TOO_OLD_COPY);
      }
      a.onWaiting?.(true);
      const out = await oneAttempt(a, params, Math.min(SITE_LINK_CREATE_TIMEOUT_MS, left));
      if (out.kind === 'reply') return parseSiteLinkCreateReply(out.raw) ?? { ...EMPTY_CREATE_REPLY };
      if (out.kind === 'not-sent') throw new SiteLinkRefusedError(SITE_LINK_NO_ANSWER_COPY);
      if (out.kind === 'refused') {
        if (isApprovalChanged(out.message) && !changedOnce) {
          changedOnce = true;
          continue;
        }
        throw new SiteLinkRefusedError(signInLinkDeviceErrorCopy(out.message, a.name));
      }
      // The card may still be up if this attempt stopped listening early: no create beside it until then.
      a.holdLock?.(out.sentAt + SITE_LINK_CREATE_TIMEOUT_MS);
      throw new SiteLinkUncertainError(SITE_LINK_LOST_COPY);
    }
  } finally {
    a.onWaiting?.(false);
  }
}

// ── Status and revoke ───────────────────────────────────────────────────────

export interface SiteLinkRecordRef {
  persona: string;
  label: string;
  slotIndex?: number;
  secretFingerprint: string;
}

function confirmedTarget(rec: SiteLinkRecordRef): SiteLinkTarget | null {
  return rec.secretFingerprint && rec.slotIndex !== undefined
    ? { identity: rec.persona, slotIndex: rec.slotIndex, secretFingerprint: rec.secretFingerprint }
    : null;
}

/**
 * Take a link off the Heartwood over the phone's own pairing. Resolves once it
 * is gone; throws (so the record is kept) otherwise.
 *
 * A confirmed link (slot and fingerprint known) is revoked by fingerprint, and
 * `unknown link` / `stale_client_slot` / `{exists:false}` mean it is already
 * gone. A link whose creation was never confirmed can only be named by label,
 * which the device remembers for 60 s after the hold: only `revoked: true`
 * there proves it gone, never `unknown link`.
 */
export async function revokeSiteLinkOnDevice(request: SiteLinkRequest, rec: SiteLinkRecordRef, name = ''): Promise<void> {
  const target = confirmedTarget(rec);
  if (target) {
    let raw: string;
    try {
      raw = await request(SITE_LINK_REVOKE, [siteLinkTargetParams(target)], SITE_LINK_QUICK_TIMEOUT_MS);
    } catch (e) {
      const text = deviceErrorText(e);
      if (text === null) throw new HeartwoodCopyError(SITE_LINK_NO_ANSWER_COPY);
      if (isUnknownLink(text) || isStaleSlot(text)) return;
      throw new HeartwoodCopyError(signInLinkDeviceErrorCopy(text, name));
    }
    const out = parseSiteLinkRevoke(raw);
    if (out?.revoked) return;
    throw new HeartwoodCopyError(SITE_LINK_BAD_REPLY_COPY);
  }
  let raw: string;
  try {
    raw = await request(SITE_LINK_REVOKE, [siteLinkTargetParams({ identity: rec.persona, label: rec.label })], SITE_LINK_QUICK_TIMEOUT_MS);
  } catch {
    throw new SiteLinkUncertainError(SITE_LINK_UNCERTAIN_REVOKE_COPY);
  }
  if (parseSiteLinkRevoke(raw)?.revoked) return;
  throw new SiteLinkUncertainError(SITE_LINK_UNCERTAIN_REVOKE_COPY);
}

/** A confirmed link's state on the device. Throws when there is no usable answer. */
export async function siteLinkStatusOnDevice(request: SiteLinkRequest, rec: SiteLinkRecordRef): Promise<{ exists: boolean; bound: boolean }> {
  const target = confirmedTarget(rec);
  if (!target) throw new Error('not a confirmed link');
  const out = parseSiteLinkStatus(await request(SITE_LINK_STATUS, [siteLinkTargetParams(target)], SITE_LINK_QUICK_TIMEOUT_MS));
  if (!out) throw new Error('bad status reply');
  return out;
}

/** When the Straight phase of a sign-in must be over: its budget, or the request's freshness, whichever is first. */
export function siteLinkDeadline(startMs: number, requestTimestampSec: number | undefined): number {
  const budget = startMs + SITE_LINK_BUDGET_MS;
  if (typeof requestTimestampSec !== 'number' || !Number.isFinite(requestTimestampSec)) return budget;
  return Math.min(budget, requestTimestampSec * 1000 + SITE_LINK_FRESHNESS_MS);
}

/**
 * One device create under the device-link lock: refused at once while a
 * full-access bundle is waiting on the Heartwood (its card would sit beside
 * this one), and the lock is kept while the LINK card may still be up.
 */
export function mintSiteLinkUnderLock(p: {
  lock: SiteLinkLock;
  ownerBusy: () => boolean;
  args: Omit<SiteLinkCreateArgs, 'holdLock'>;
}): Promise<CreateClientV2Reply> {
  return p.lock.run(async ({ holdUntil }) => {
    if (p.ownerBusy()) throw new SiteLinkRefusedError(SITE_LINK_BUSY_COPY);
    return createSiteLinkOnDevice({ ...p.args, holdLock: holdUntil });
  }, { create: true });
}
