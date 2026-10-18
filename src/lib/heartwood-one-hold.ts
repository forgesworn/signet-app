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
import { BunkerRequestTimeoutError, CARD_REQUEST_TIMEOUT_MS } from './signing-backend';

export { CARD_REQUEST_TIMEOUT_MS };

export const CAP_APPROVE_BUNDLE = 'heartwood_approve_bundle';
export const CAP_OWNER_STATUS = 'heartwood_owner_status';
export const CAP_OWNER_NARROW = 'heartwood_owner_narrow';

/** The bundle waits out the device's 90 s queue TTL plus its 45 s card window (A7). */
export const BUNDLE_TIMEOUT_MS = 140_000;
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
// The words are not on the card at rest: the Heartwood shows them only on the
// hold screen, while the button is held (letting go declines).
// ---------------------------------------------------------------------------

export interface CardLines {
  header: string;
  /** The pairing's name as the Heartwood draws it, or a placeholder when it is not known here. */
  label: string;
  /** False when `label` is the placeholder, so the line count still matches the Heartwood's card. */
  labelKnown: boolean;
  wordsLine1: string;
  wordsLine2: string;
  scope: string;
  /** Everyday: one line. Extra careful: two. */
  powers: string[];
  hold: string;
}

/** Standing in for the pairing's name where this phone cannot read it (onboarding). */
export const CARD_LABEL_PLACEHOLDER = '(this pairing\'s name)';

/**
 * Characters the label line takes on the Heartwood's panel. The firmware draws
 * the label as typed, shows anything outside printable ASCII as `?`, and cuts a
 * longer one to this width with `..` (common/src/owner_pairing.rs
 * `full_access_card`); this is its preview width, so the drawing here may cut a
 * very long name a little earlier or later than a given panel does.
 */
export const CARD_LABEL_MAX_CHARS = 21;

/** The label line exactly as the firmware builds it (no upper-casing). */
export function cardLabelLine(label: string, maxChars: number = CARD_LABEL_MAX_CHARS): string {
  const printable = Array.from(label, c => (c >= ' ' && c <= '~' ? c : '?')).join('');
  const room = Math.max(maxChars, 3);
  return printable.length <= room ? printable : `${printable.slice(0, room - 2)}..`;
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
    label: label ? cardLabelLine(label) : CARD_LABEL_PLACEHOLDER,
    labelKnown: label !== '',
    wordsLine1: `${args.words[0]} ${args.words[1]}`,
    wordsLine2: args.words[2],
    scope: args.realName ? 'PERSONA + REAL NAME' : 'PERSONA ONLY',
    powers: args.style === 'careful'
      ? ['SIGNS ALONE: BACKUPS', 'ASKS: EVERYTHING ELSE']
      : ['SIGN IN, POST, BACKUP'],
    hold: 'HOLD 5 SECONDS',
  };
}

// ---------------------------------------------------------------------------
// Copy (A1, A1b, A2, A9, A10, A11). Plain British English, as the spec gives it.
// ---------------------------------------------------------------------------

export const FULL_ACCESS_COPY = {
  heading: 'Give this phone full access?',
  covers: 'This phone can sign in, post and back up as your persona (and your real name, if you use it), including your children\'s backups. You can take it back in Settings.',
  realNameForLegacyBackups: 'Your older backups still sign with your real-name key, so this includes it.',
  expect: 'Your Heartwood will show FULL ACCESS and these three words. Start holding its button: the words appear on the Heartwood while you hold. If they match, keep holding for 5 seconds. If they don\'t, let go.',
  warning: 'Your Heartwood only shows FULL ACCESS when you start it here. If it ever shows it at another time, don\'t hold the button.',
  setUp: 'Set up with one hold',
  separately: 'Approve each thing separately',
  styleHeading: 'How should this phone sign?',
  everyday: { name: 'Everyday', tag: 'recommended', body: 'Sign-ins, posts and backups happen from your phone, at home or away. Your Heartwood is needed for big things: new keys, money, your real name the first time.' },
  careful: { name: 'Extra careful', tag: '', body: 'Only backups happen on their own. Every sign-in, post and message asks on your Heartwood, so they wait until you\'re home.' },
  holding: 'Start holding the button on your Heartwood. The three words above appear on it while you hold. If they match, keep holding for 5 seconds. If they don\'t, let go.',
  wordsWhileHolding: 'while you hold:',
  declined: 'Full access wasn\'t approved. Nothing changed.',
  noAnswer: 'Your Heartwood didn\'t answer in time. If you did hold its button, full access may already be on: check Settings, Advanced. You can also try again.',
  busy: 'Your Heartwood was busy. Nothing changed. Try again.',
  changed: 'Something changed on your Heartwood while it waited. Nothing changed here. Try again.',
  tryAgain: 'Try again',
  unreachable: 'Couldn\'t reach your Heartwood. Check it\'s switched on and online, then try again. Nothing changed.',
  pairingMismatch: 'Your Heartwood\'s keys don\'t match this phone\'s. Nothing was changed.',
  personaMissing: 'Your Heartwood doesn\'t have this phone\'s keys yet, so nothing was changed.',
  missingKey: 'This phone is missing a key it needs for full access, so nothing was sent. Your Heartwood will keep asking about each thing separately.',
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

/** The method that makes a new key on the device; a pairing that lists it makes keys with no card. */
export const CAP_DERIVE_PERSONA = 'heartwood_derive_persona';

/**
 * Decision 11: show the add-child press preview only when cards will actually
 * appear. `ownSlotMethods` is the operator's view of this phone's pairing
 * (`null` when there is no operator key, so the answer is unknown and the
 * preview is shown). A pairing that lists derive raises no card.
 */
export function addChildRaisesCards(args: { deviceDerive: boolean; ownSlotMethods: readonly string[] | null }): boolean {
  return args.deviceDerive && !(args.ownSlotMethods?.includes(CAP_DERIVE_PERSONA) ?? false);
}

/** The private backups a fresh install makes: profiles, two contact lists, credentials and settings. */
export const FIRST_SYNC_BACKUPS = 5;

/**
 * How many times today's flow asks, so the owner weighing one hold against it
 * sees the real cost (decision 11): one card to list the keys, one for each of
 * the two keys it makes, three for each backup (two key checks and one
 * REMEMBER AS), and one more for the older backups that sign as the real name.
 */
export function separateCardCount(backups: number = FIRST_SYNC_BACKUPS): number {
  return 1 + 2 + 3 * backups + 1;
}

export function separatelyHint(backups: number = FIRST_SYNC_BACKUPS): string {
  return `Your Heartwood will then ask about ${separateCardCount(backups)} times over the first few minutes: once to list your keys, once for each key it makes, and about three times for each of your ${backups} backups.`;
}

/**
 * How many presses are coming, and what each says (decision 11). With the
 * full-access mark on this phone the Heartwood asks exactly twice; without it
 * the child's first backups ask as well, so the line says "more than twice".
 */
export function addChildPressPreview(name: string, fullAccess: boolean = false): string {
  const n = name.trim();
  const possessive = n ? `${n}'s` : 'their';
  return fullAccess
    ? `Your Heartwood will ask twice: first for ${possessive} real-name key, then for ${possessive} persona key.`
    : `Your Heartwood will ask more than twice: first for ${possessive} real-name key, then for ${possessive} persona key, then a few more times for ${possessive} first backups.`;
}

// ---------------------------------------------------------------------------
// A8: when an owner pairing loses its mark
// ---------------------------------------------------------------------------

export interface OwnerOfferInput {
  supported: boolean;
  /** A style is on file: this install ran the hold before. */
  everHadFullAccess: boolean;
  /** `heartwood_owner_status` answered `owner:false` (`null` = no answer, never "off"). */
  statusOwner: boolean | null;
  /** The first status answer for this router has not arrived yet. */
  awaitingFirstStatus: boolean;
  /** A vault request was refused, timed out or found the signer busy. */
  vaultNeedsApproval: boolean;
  dismissed: boolean;
}

export interface OwnerOfferState {
  /** The mark is known to be gone. */
  lost: boolean;
  /** Show "Approve this phone again". */
  offer: boolean;
  /**
   * Hold the backups. ONLY while the first answer is pending, so a card is not
   * queued beside the one the owner may be asked for. Once the answer is in,
   * even `owner:false`, backups run (today's cards): a pairing the owner
   * deliberately cleared in Sapwood must not stall every start until "Not now".
   */
  holdBackups: boolean;
}

export function ownerOfferState(i: OwnerOfferInput): OwnerOfferState {
  const lost = i.supported && i.everHadFullAccess && i.statusOwner === false;
  // A refused vault request is only a reason to offer the hold when the mark is
  // not there: with `owner:true` the refusal is a plain backup refusal, whose
  // own banner re-queues today's cards.
  const offer = i.supported && i.everHadFullAccess && !i.dismissed
    && (lost || (i.vaultNeedsApproval && i.statusOwner !== true));
  const holdBackups = i.everHadFullAccess && i.supported && i.awaitingFirstStatus;
  return { lost, offer, holdBackups };
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
 * Validate the success reply (the 4.1 shape: `pubkeys` map, `act_as`, `owner`,
 * `style`). Lowercase hex64, not the master, and the real identity differs
 * from the persona. `null` means the reply is unusable.
 */
export function parseBundleReply(
  raw: string,
  ctx: { masterPubkey: string; requestedStyle: OwnerStyle; expect?: { naturalPerson?: string; persona?: string } },
): BundleSuccess | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed)) return null;
  // The only reply shape is the 4.1 one: a `pubkeys` map of name -> hex.
  if (!isRecord(parsed.pubkeys)) return null;
  const found: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.pubkeys)) if (typeof v === 'string') found[k] = v;
  const np = found['natural-person'];
  const persona = found['persona'];
  if (typeof np !== 'string' || typeof persona !== 'string') return null;
  const master = (ctx.masterPubkey || '').trim().toLowerCase();
  const valid = (k: string) => HEX64.test(k) && k !== master;
  if (!valid(np) || !valid(persona) || np === persona) return null;
  if (ctx.expect?.naturalPerson && ctx.expect.naturalPerson.toLowerCase() !== np) return null;
  if (ctx.expect?.persona && ctx.expect.persona.toLowerCase() !== persona) return null;
  // The firmware always sends `owner:true` on success; a reply without it is not one.
  if (parsed.owner !== true) return null;
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
    | 'declined' | 'no-answer' | 'busy' | 'changed' | 'unreachable' | 'strict' | 'kinds-list' | 'shared' | 'every-request' | 'phone-may-ok'
    | 'approval-list-full' | 'storage-full' | 'no-persona-tree' | 'method-list-full'
    | 'pubkey-mismatch' | 'persona-missing' | 'missing-key' | 'malformed' | 'child' | 'bad-reply' | 'other';
}

/**
 * Map a rejected bundle request. NIP-46 errors carry only the message text,
 * never a numeric code, so this matches the text. nostr-tools rejects a remote error reply with
 * the raw STRING and a transport failure with an Error; our own 140 s expiry is
 * a BunkerRequestTimeoutError. The `unauthorised: pairing ...` variants are
 * tested before the bare `unauthorised`.
 */
export function classifyBundleError(err: unknown): BundleFailure {
  // Our own expiry means no answer reached us, not that the owner said no: the
  // press may have landed after we stopped listening (m3).
  if (err instanceof BunkerRequestTimeoutError) return { action: 'retry', code: 'no-answer', message: FULL_ACCESS_COPY.noAnswer };
  if (err instanceof Error) {
    return /timed out|timeout/i.test(err.message)
      ? { action: 'retry', code: 'no-answer', message: FULL_ACCESS_COPY.noAnswer }
      : { action: 'retry', code: 'unreachable', message: FULL_ACCESS_COPY.unreachable };
  }
  const m = String(err ?? '').trim();
  const lower = m.toLowerCase();
  if (/pairing shared by another device/.test(lower)) return { action: 'continue', code: 'shared', message: PAIRING_PROBLEM_COPY.shared };
  if (/pairing has a kinds list/.test(lower)) return { action: 'continue', code: 'kinds-list', message: PAIRING_PROBLEM_COPY.everything };
  if (/pairing asks for every request/.test(lower)) return { action: 'continue', code: 'every-request', message: PAIRING_PROBLEM_COPY.everything };
  // The firmware's refusal for a pairing set to "Phone may OK": its text is
  // escalate.rs DEVICE_APPROVAL_REQUIRED, not the constant's name. The name is
  // still matched in case a build sends it.
  if (/must be approved at the device|device[_ ]approval[_ ]required/.test(lower)) return { action: 'continue', code: 'phone-may-ok', message: PAIRING_PROBLEM_COPY.phoneMayOk };
  // Transient refusals: the slot changed while the ask waited, or the signer
  // was busy with another card. Nothing was granted; the owner taps Try again.
  if (/signer is busy|busy with another approval/.test(lower)) return { action: 'retry', code: 'busy', message: FULL_ACCESS_COPY.busy };
  if (/send the request again|approval_changed/.test(lower)) return { action: 'retry', code: 'changed', message: FULL_ACCESS_COPY.changed };
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
  // m9 / A10: an existing install must name both keys it has on file. An empty
  // or malformed entry would be dropped from `expect` and the firmware would
  // answer `malformed bundle`, which the owner would never see. Say so, and
  // send nothing.
  if (!args.create) {
    const onFile = (k: string | undefined) => typeof k === 'string' && HEX64.test(k.trim().toLowerCase());
    if (!onFile(args.expect?.naturalPerson) || !onFile(args.expect?.persona)) {
      return { ok: false, failure: { action: 'continue', code: 'missing-key', message: FULL_ACCESS_COPY.missingKey } };
    }
  }
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
      // m8 / A1: false is right here. Onboarding runs before any identity
      // exists, and the identity it creates is persona-first with the real-name
      // slot dormant (`naturalPersonActive: false`), so there is no active real
      // identity to include. An existing install passes `isNaturalPersonActive`
      // through `useHeartwoodOwner` (`includeRealName`).
      create: true, actAsNaturalPerson: false, style, masterPubkey: args.masterPubkey,
    }),
  });
}
