/**
 * Heartwood one-hold pairing (signet-plans 2026-10-17-heartwood-one-hold-pairing
 * spec, stage 1, My Signet half). Pure wire-format and copy helpers; the React
 * screens and App.tsx wiring live elsewhere.
 *
 * Four NIP-46 methods ride the PRIMARY pairing:
 *   - `heartwood_approve_bundle`  one card, a 5 s hold, grants the whole phone
 *   - `heartwood_owner_status`    no card; does the pairing carry the owner mark
 *   - `heartwood_owner_narrow`    no card; Everyday -> Extra careful, never wider
 *   - `heartwood_capabilities`    already probed elsewhere; the bundle is gated
 *                                 on this list naming `heartwood_approve_bundle`
 *
 * Everything here is gated on that capability: firmware that does not list the
 * method gets today's flow, untouched.
 */
import { encodeAsWords, sha256 } from 'spoken-token';
import { hexToBytes } from '@noble/hashes/utils.js';
import { BunkerRequestTimeoutError } from './signing-backend';

export const CAP_APPROVE_BUNDLE = 'heartwood_approve_bundle';
export const CAP_OWNER_STATUS = 'heartwood_owner_status';
export const CAP_OWNER_NARROW = 'heartwood_owner_narrow';

/** The bundle waits out the device's 90 s queue TTL plus its 45 s card window (A7). */
export const BUNDLE_TIMEOUT_MS = 140_000;
/** Any request that may raise a card waits at least this long (A7). */
export const CARD_REQUEST_TIMEOUT_MS = 45_000;
/** Status and narrow never raise a card. */
export const OWNER_QUICK_TIMEOUT_MS = 20_000;

export type OwnerStyle = 'everyday' | 'careful';

/** The only list the firmware sets for Extra careful (4.6). */
export const CAREFUL_KINDS: readonly number[] = [30078, 22242];

const HEX64 = /^[0-9a-f]{64}$/;

export type RequestFn = (method: string, params: string[], timeoutMs?: number) => Promise<string>;

// ---------------------------------------------------------------------------
// The three words (4.2)
// ---------------------------------------------------------------------------

const WORDS_PREFIX = new TextEncoder().encode('heartwood-pair-words');

/**
 * `d = SHA-256("heartwood-pair-words" || 0x00 || client_pubkey_32)`; word i is
 * the spoken-token en-v1 word at `u16_be(d[2i], d[2i+1]) % 2048`, i = 0..2.
 * `encodeAsWords` is exactly that encoding.
 */
export function pairWordsForClient(clientPubkeyHex: string): [string, string, string] {
  const hex = (clientPubkeyHex || '').trim().toLowerCase();
  if (!HEX64.test(hex)) throw new Error('client pubkey must be 64 hex chars');
  const key = hexToBytes(hex);
  const input = new Uint8Array(WORDS_PREFIX.length + 1 + key.length);
  input.set(WORDS_PREFIX, 0);
  input[WORDS_PREFIX.length] = 0;
  input.set(key, WORDS_PREFIX.length + 1);
  const d = sha256(input);
  const words = encodeAsWords(d, 3);
  input.fill(0);
  key.fill(0);
  return [words[0], words[1], words[2]];
}

// ---------------------------------------------------------------------------
// The card, as the choice screen draws it (4.2, 4.6). Same lines, word for word.
// ---------------------------------------------------------------------------

export interface CardLines {
  header: string;
  label: string | null;
  wordsLine1: string;
  wordsLine2: string;
  scope: string;
  /** Everyday: one line. Extra careful: two. */
  powers: string[];
  hold: string;
}

export function cardLines(args: {
  words: readonly [string, string, string];
  label?: string | null;
  realName: boolean;
  style: OwnerStyle;
}): CardLines {
  const label = (args.label ?? '').trim();
  return {
    header: 'FULL ACCESS',
    label: label ? label.toUpperCase().slice(0, 24) : null,
    wordsLine1: `${args.words[0]} ${args.words[1]}`,
    wordsLine2: args.words[2],
    scope: args.realName ? 'PERSONA + REAL NAME' : 'PERSONA ONLY',
    powers: args.style === 'careful'
      ? ['SIGNS ALONE: BACKUPS', 'ASKS: EVERYTHING ELSE']
      : ['SIGN IN, POST, BACK UP'],
    hold: 'HOLD 5 SECONDS',
  };
}

// ---------------------------------------------------------------------------
// Copy (A1, A1b, A2, A9, A10, A11). Plain British English, as the spec gives it.
// ---------------------------------------------------------------------------

export const FULL_ACCESS_COPY = {
  heading: 'Give this phone full access?',
  covers: 'This phone can sign in, post and back up as your persona (and your real name, if you use it), including your children\'s backups. You can take it back in Settings.',
  expect: 'Your Heartwood will show FULL ACCESS and these three words. Check they match, then hold its button for 5 seconds.',
  warning: 'Your Heartwood only shows FULL ACCESS when you start it here. If it ever shows it at another time, don\'t hold the button.',
  setUp: 'Set up with one hold',
  separately: 'Approve each thing separately',
  separatelyHint: 'Your Heartwood will then ask a few times, once for each thing: first to list your keys, then once for each key it has to make.',
  styleHeading: 'How should this phone sign?',
  everyday: { name: 'Everyday', tag: 'recommended', body: 'Sign-ins, posts and backups happen from your phone, at home or away. Your Heartwood is needed for big things: new keys, money, your real name the first time.' },
  careful: { name: 'Extra careful', tag: '', body: 'Only backups happen on their own. Every sign-in, post and message asks on your Heartwood, so they wait until you\'re home.' },
  holding: 'Hold the button on your Heartwood for 5 seconds. It shows FULL ACCESS and the three words above.',
  declined: 'Full access wasn\'t approved. Nothing changed.',
  tryAgain: 'Try again',
  unreachable: 'Couldn\'t reach your Heartwood. Check it\'s switched on and online, then try again. Nothing changed.',
  pairingMismatch: 'Your Heartwood\'s keys don\'t match this phone\'s. Nothing was changed.',
  personaMissing: 'Your Heartwood doesn\'t have this phone\'s keys yet, so nothing was changed.',
  realNameFirstUse: 'The first time you use your real name, your Heartwood will ask you to confirm it once.',
  needsHeartwood: 'This needs your Heartwood. Try again when you\'re with it.',
  lostPhone: 'If you lose this phone, remove it in Sapwood.',
  sapwoodForget: 'Choose Forget approvals for this phone in Sapwood.',
  offerExisting: 'Give this phone full access: one hold on your Heartwood',
  approveAgain: 'Approve this phone again on your Heartwood',
  pairAgain: 'Pair again from My Signet',
} as const;

/** Section 7's table: why the hold is refused, in words the owner can act on. */
export const PAIRING_PROBLEM_COPY = {
  strict: 'Pair My Signet in Sapwood with the cable plugged in.',
  everything: 'Pair My Signet with Everything access in Sapwood.',
  shared: 'This pairing is used by another device. Make a separate link for this phone in Sapwood.',
  phoneMayOk: 'Turn off \'Phone may OK\' for My Signet in Sapwood.',
} as const;

/** Plain words for the `-4` limits; today's flow runs afterwards. */
export const DEVICE_LIMIT_COPY = {
  storageFull: 'Your Heartwood has no room for another identity.',
  noPersonaTree: 'Your Heartwood isn\'t set up to make persona keys, so full access isn\'t available.',
  methodListFull: 'This pairing has no room for full access. Remove some of its permissions in Sapwood, then try again.',
} as const;

/** How many presses are coming, and what each says (decision 11). */
export function addChildPressPreview(name: string): string {
  const n = name.trim();
  const possessive = n ? `${n}'s` : 'their';
  return `Your Heartwood will ask twice: first for ${possessive} real-name key, then for ${possessive} persona key.`;
}

// ---------------------------------------------------------------------------
// Bundle param and reply (4.1)
// ---------------------------------------------------------------------------

export interface BundleParamArgs {
  create: boolean;
  /** Include the real identity in `act_as`. */
  actAsNaturalPerson: boolean;
  style: OwnerStyle;
  /** Required for `create: false`; optional (but checked) for `create: true`. */
  expect?: { naturalPerson?: string; persona?: string };
}

/** The single JSON-string param of `heartwood_approve_bundle`. */
export function buildBundleParam(args: BundleParamArgs): string {
  const expectEntries: Record<string, string> = {};
  if (args.expect?.naturalPerson) expectEntries['natural-person'] = args.expect.naturalPerson.toLowerCase();
  if (args.expect?.persona) expectEntries['persona'] = args.expect.persona.toLowerCase();
  const body: Record<string, unknown> = {
    v: 1,
    personas: ['natural-person', 'persona'],
    act_as: args.actAsNaturalPerson ? ['natural-person', 'persona'] : ['persona'],
    ...(Object.keys(expectEntries).length > 0 ? { expect: expectEntries } : {}),
    create: args.create,
    style: args.style,
  };
  return JSON.stringify(body);
}

export interface BundleSuccess {
  naturalPerson: string;
  persona: string;
  actAs: string[];
  style: OwnerStyle;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate the success reply. Two shapes are accepted, with identical checks:
 * the pinned 4.1 shape (`pubkeys` map) and the 4.3 / A1 shape (`personas`
 * array of `{name, pubkey, index}`). Lowercase hex64, not the master, and the
 * real identity differs from the persona. `null` means the reply is unusable.
 */
export function parseBundleReply(
  raw: string,
  ctx: { masterPubkey: string; requestedStyle: OwnerStyle; expect?: { naturalPerson?: string; persona?: string } },
): BundleSuccess | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const found: Record<string, string> = {};
  if (isRecord(parsed.pubkeys)) {
    for (const [k, v] of Object.entries(parsed.pubkeys)) if (typeof v === 'string') found[k] = v;
  } else if (Array.isArray(parsed.personas)) {
    for (const row of parsed.personas) {
      if (isRecord(row) && typeof row.name === 'string' && typeof row.pubkey === 'string') found[row.name] = row.pubkey;
    }
  } else {
    return null;
  }
  const np = found['natural-person'];
  const persona = found['persona'];
  if (typeof np !== 'string' || typeof persona !== 'string') return null;
  const master = (ctx.masterPubkey || '').trim().toLowerCase();
  const valid = (k: string) => HEX64.test(k) && k !== master;
  if (!valid(np) || !valid(persona) || np === persona) return null;
  if (ctx.expect?.naturalPerson && ctx.expect.naturalPerson.toLowerCase() !== np) return null;
  if (ctx.expect?.persona && ctx.expect.persona.toLowerCase() !== persona) return null;
  // A reply that says the owner mark was NOT set is not a success.
  if (parsed.owner !== undefined && parsed.owner !== true) return null;
  const actAs = Array.isArray(parsed.act_as) ? parsed.act_as.filter((x): x is string => typeof x === 'string') : [];
  const style: OwnerStyle = parsed.style === 'careful' || parsed.style === 'everyday' ? parsed.style : ctx.requestedStyle;
  return { naturalPerson: np, persona, actAs, style };
}

// ---------------------------------------------------------------------------
// Errors (4.1, section 7)
// ---------------------------------------------------------------------------

/**
 * What the screen does about a failed bundle.
 *  - `retry`    the card was not answered or the device was unreachable: Try again / separately
 *  - `continue` the pairing cannot take the hold: say why, then today's flow
 *  - `silent`   run today's flow with no message
 *  - `mismatch` a create:false request found keys that differ: say so, change nothing
 */
export type BundleFailureAction = 'retry' | 'continue' | 'silent' | 'mismatch';

export interface BundleFailure {
  action: BundleFailureAction;
  message: string;
  code:
    | 'declined' | 'unreachable' | 'strict' | 'kinds-list' | 'shared' | 'every-request' | 'phone-may-ok'
    | 'approval-list-full' | 'storage-full' | 'no-persona-tree' | 'method-list-full'
    | 'pubkey-mismatch' | 'persona-missing' | 'malformed' | 'child' | 'bad-reply' | 'other';
}

/**
 * Map a rejected bundle request. nostr-tools rejects a remote error reply with
 * the raw STRING and a transport failure with an Error; our own 140 s expiry is
 * a BunkerRequestTimeoutError. The `unauthorised: pairing ...` variants are
 * tested before the bare `unauthorised`.
 */
export function classifyBundleError(err: unknown): BundleFailure {
  if (err instanceof BunkerRequestTimeoutError) return { action: 'retry', code: 'declined', message: FULL_ACCESS_COPY.declined };
  if (err instanceof Error) {
    return /timed out|timeout/i.test(err.message)
      ? { action: 'retry', code: 'declined', message: FULL_ACCESS_COPY.declined }
      : { action: 'retry', code: 'unreachable', message: FULL_ACCESS_COPY.unreachable };
  }
  const m = String(err ?? '').trim();
  const lower = m.toLowerCase();
  if (/pairing shared by another device/.test(lower)) return { action: 'continue', code: 'shared', message: PAIRING_PROBLEM_COPY.shared };
  if (/pairing has a kinds list/.test(lower)) return { action: 'continue', code: 'kinds-list', message: PAIRING_PROBLEM_COPY.everything };
  if (/pairing asks for every request/.test(lower)) return { action: 'continue', code: 'every-request', message: PAIRING_PROBLEM_COPY.everything };
  if (/device_approval_required/.test(lower)) return { action: 'continue', code: 'phone-may-ok', message: PAIRING_PROBLEM_COPY.phoneMayOk };
  if (/^unauthori[sz]ed$/.test(lower)) return { action: 'continue', code: 'strict', message: PAIRING_PROBLEM_COPY.strict };
  if (/approval list full/.test(lower)) return { action: 'silent', code: 'approval-list-full', message: '' };
  if (/storage full/.test(lower)) return { action: 'continue', code: 'storage-full', message: DEVICE_LIMIT_COPY.storageFull };
  if (/no persona tree/.test(lower)) return { action: 'continue', code: 'no-persona-tree', message: DEVICE_LIMIT_COPY.noPersonaTree };
  if (/method list full/.test(lower)) return { action: 'continue', code: 'method-list-full', message: DEVICE_LIMIT_COPY.methodListFull };
  if (/pubkey mismatch/.test(lower)) return { action: 'mismatch', code: 'pubkey-mismatch', message: FULL_ACCESS_COPY.pairingMismatch };
  if (/persona missing/.test(lower)) return { action: 'mismatch', code: 'persona-missing', message: FULL_ACCESS_COPY.personaMissing };
  if (/malformed bundle/.test(lower)) return { action: 'silent', code: 'malformed', message: '' };
  if (/bundle names a child/.test(lower)) return { action: 'silent', code: 'child', message: '' };
  // The firmware's own denial reply for a card ("user denied", "timeout", ...).
  if (/denied|declin|reject|timeout|timed out|cancel/.test(lower)) {
    return { action: 'retry', code: 'declined', message: FULL_ACCESS_COPY.declined };
  }
  return { action: 'silent', code: 'other', message: '' };
}

export type BundleRunResult = { ok: true; reply: BundleSuccess } | { ok: false; failure: BundleFailure };

/**
 * Send ONE bundle. Never retried here: the caller calls it from a tap and from
 * nowhere else.
 */
export async function runApproveBundle(
  request: RequestFn,
  args: BundleParamArgs & { masterPubkey: string },
): Promise<BundleRunResult> {
  let raw: string;
  try {
    raw = await request('heartwood_approve_bundle', [buildBundleParam(args)], BUNDLE_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, failure: classifyBundleError(err) };
  }
  const reply = parseBundleReply(raw, {
    masterPubkey: args.masterPubkey,
    requestedStyle: args.style,
    expect: args.expect,
  });
  if (!reply) {
    return { ok: false, failure: { action: 'silent', code: 'bad-reply', message: '' } };
  }
  return { ok: true, reply };
}

// ---------------------------------------------------------------------------
// Status and narrow (4.1, 4.6)
// ---------------------------------------------------------------------------

export interface OwnerStatus {
  owner: boolean;
  style: OwnerStyle;
}

export function parseOwnerStatus(raw: string): OwnerStatus | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed) || typeof parsed.owner !== 'boolean') return null;
  const style: OwnerStyle = parsed.style === 'careful' ? 'careful' : 'everyday';
  return { owner: parsed.owner, style };
}

/** One `heartwood_owner_status` round-trip. `null` = no usable answer (unknown, not "off"). */
export async function fetchOwnerStatus(request: RequestFn): Promise<OwnerStatus | null> {
  try {
    return parseOwnerStatus(await request(CAP_OWNER_STATUS, [], OWNER_QUICK_TIMEOUT_MS));
  } catch {
    return null;
  }
}

export type NarrowResult = { ok: true; changed: boolean } | { ok: false; message: string };

/** Everyday -> Extra careful. Raises no card and can never widen. */
export async function narrowToCareful(request: RequestFn): Promise<NarrowResult> {
  let raw: string;
  try {
    raw = await request(CAP_OWNER_NARROW, [JSON.stringify({ v: 1, style: 'careful' })], OWNER_QUICK_TIMEOUT_MS);
  } catch (err) {
    if (typeof err === 'string' && /unauthori[sz]ed/i.test(err)) {
      return { ok: false, message: 'This phone no longer has full access, so its style can\'t be changed. Approve it again first.' };
    }
    return { ok: false, message: FULL_ACCESS_COPY.unreachable };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.style === 'careful') return { ok: true, changed: parsed.changed === true };
  } catch { /* fall through */ }
  return { ok: false, message: 'Your Heartwood gave an unexpected answer. Nothing was changed.' };
}

/** Does the device's capability list name the bundle method? */
export function supportsApproveBundle(methods: readonly string[] | null | undefined): boolean {
  return !!methods && methods.includes(CAP_APPROVE_BUNDLE);
}

/** Hex helper kept local so callers need not import @noble just to compare keys. */
export function sameKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Onboarding hand-off (A1): App.tsx asks the screen to run the choice
// ---------------------------------------------------------------------------

/** What App.tsx hands the onboarding screen once the Heartwood lists the bundle method. */
export interface FullAccessOffer {
  words: [string, string, string];
  /** Send ONE bundle. The screen calls this from the tap only. */
  run: (style: OwnerStyle) => Promise<BundleRunResult>;
}

export type FullAccessDecision =
  | { mode: 'separate' }
  | { mode: 'bundle'; reply: BundleSuccess; style: OwnerStyle }
  | { mode: 'cancel' };

/** UI seam for `handleConnectHeartwood`. Absent = never offer (today's flow). */
export interface HeartwoodConnectUi {
  chooseFullAccess(offer: FullAccessOffer): Promise<FullAccessDecision>;
}

/**
 * A1: after `connect`, decide whether the owner is offered full access.
 * `probe` makes the ONE capabilities attempt (20 s) and returns the method
 * list, or `null` for any failure. Without the bundle method, or without a UI
 * to ask on, the answer is `separate`: today's flow, with nothing sent. The
 * bundle itself runs only if the UI calls `offer.run`, which the screen does
 * from the tap and from nowhere else.
 */
export async function negotiateFullAccess(args: {
  ui: HeartwoodConnectUi | undefined;
  probe: () => Promise<readonly string[] | null>;
  clientPubkeyHex: string;
  masterPubkey: string;
  request: RequestFn;
}): Promise<FullAccessDecision> {
  if (!args.ui) return { mode: 'separate' };
  let methods: readonly string[] | null;
  try { methods = await args.probe(); } catch { methods = null; }
  if (!supportsApproveBundle(methods)) return { mode: 'separate' };
  return args.ui.chooseFullAccess({
    words: pairWordsForClient(args.clientPubkeyHex),
    run: (style) => runApproveBundle(args.request, {
      create: true, actAsNaturalPerson: false, style, masterPubkey: args.masterPubkey,
    }),
  });
}
