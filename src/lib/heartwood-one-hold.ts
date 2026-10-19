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
/**
 * The longest A8 holds backups for the router probe and the first owner-status
 * answer: the probe's own timeouts plus the 20 s status call, rounded up. A
 * Heartwood that has not answered by then gets today's cards.
 */
export const OWNER_HOLD_CAP_MS = 60_000;
/** Status and narrow never raise a card. */
export const OWNER_QUICK_TIMEOUT_MS = 20_000;

/** The two styles an owner can ASK for in a bundle. */
export type OwnerStyle = 'everyday' | 'careful';
/**
 * What `heartwood_owner_status` can report: the two styles above, or `custom`
 * (W4), a non-empty kinds list that is neither of them, e.g. one an operator
 * narrowed in Sapwood. Never sent in a request.
 */
export type StatusStyle = OwnerStyle | 'custom';

/** The only list the firmware sets for Extra careful (4.6). */
export const CAREFUL_KINDS: readonly number[] = [30078, 22242];

const HEX64 = /^[0-9a-f]{64}$/;

export type RequestFn = (method: string, params: string[], timeoutMs?: number) => Promise<string>;

// ---------------------------------------------------------------------------
// The five check words (W1, 4.2)
// ---------------------------------------------------------------------------

const WORDS_PREFIX = new TextEncoder().encode('heartwood-pair-words');

/** How many check words the FULL ACCESS card shows (5 x 11 = 55 bits, as the phone-enrol card). */
export const PAIR_WORD_COUNT = 5;

export type PairWords = [string, string, string, string, string];

/**
 * `d = SHA-256("heartwood-pair-words" || 0x00 || client_pubkey_32)`; word i is
 * the spoken-token en-v1 word at `u16_be(d[2i], d[2i+1]) % 2048`, i = 0..4
 * (`d[0..10]`). `encodeAsWords` is exactly that encoding. The first three words
 * are the ones the three-word version showed.
 */
export function pairWordsForClient(clientPubkeyHex: string): PairWords {
  const hex = (clientPubkeyHex || '').trim().toLowerCase();
  if (!HEX64.test(hex)) throw new Error('client pubkey must be 64 hex chars');
  const key = hexToBytes(hex);
  const input = new Uint8Array(WORDS_PREFIX.length + 1 + key.length);
  input.set(WORDS_PREFIX, 0);
  input[WORDS_PREFIX.length] = 0;
  input.set(key, WORDS_PREFIX.length + 1);
  const d = sha256(input);
  const words = encodeAsWords(d, PAIR_WORD_COUNT);
  input.fill(0);
  key.fill(0);
  return [words[0], words[1], words[2], words[3], words[4]];
}

// ---------------------------------------------------------------------------
// The card, as the choice screen draws it (4.2, 4.6, W2). Same lines, word for word.
// At rest the Heartwood draws (oled.rs `show_full_access`): the inverted header,
// ONE page of the words (two at a time: "1-2 of 5", "3-4 of 5", "5 of 5"),
// the scope, the style's lines and a hint that reads COMPARE ALL 5 WORDS until
// every page has had its dwell, then HOLD 5 SECONDS. There is NO label at
// rest. The label and all five words appear only on the hold screen
// (`show_full_access_hold`), while the button is down. The hold counts only
// once every page has had its dwell and the button has been seen up since;
// letting go before 5 s declines.
// ---------------------------------------------------------------------------

export interface CardLines {
  header: string;
  /** The word pages as the Heartwood pages them, e.g. `1-2 of 5`: `nice never`. */
  wordPages: { label: string; words: string }[];
  scope: string;
  /** Everyday: one line. Extra careful: two. */
  powers: string[];
  /** The hint line at rest, until every words page has had its dwell. */
  compare: string;
  /** The hint line once a hold counts, and the hold screen's job. */
  hold: string;
  /**
   * What the Heartwood draws only while the button is held (`show_full_access_hold`):
   * the pairing's label and all five words (`w1 w2` / `w3 w4` / `w5`).
   */
  holdScreen: {
    /** The pairing's name as the Heartwood draws it, or a placeholder when it is not known here. */
    label: string;
    /** False when `label` is the placeholder (onboarding cannot read the pairing's name). */
    labelKnown: boolean;
    words: string[];
  };
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

/** The pages the Heartwood shows the words in (W2): two at a time, then the last one on its own. */
export function wordPages(words: readonly string[]): { label: string; words: string }[] {
  const pages: { label: string; words: string }[] = [];
  for (let i = 0; i < words.length; i += 2) {
    const chunk = words.slice(i, i + 2);
    const label = chunk.length === 2 ? `${i + 1}-${i + 2} of ${words.length}` : `${i + 1} of ${words.length}`;
    pages.push({ label, words: chunk.join(' ') });
  }
  return pages;
}

export function cardLines(args: {
  words: readonly string[];
  label?: string | null;
  realName: boolean;
  style: OwnerStyle;
}): CardLines {
  const label = (args.label ?? '').trim();
  return {
    header: 'FULL ACCESS',
    wordPages: wordPages(args.words),
    scope: args.realName ? 'PERSONA + REAL NAME' : 'PERSONA ONLY',
    // Firmware CAREFUL_LINES: "SIGNS" is dropped to fit 24 characters.
    powers: args.style === 'careful'
      ? ['ALONE: BACKUPS, APP DATA', 'ASKS: EVERYTHING ELSE']
      : ['SIGN IN, POST, BACKUP'],
    compare: 'COMPARE ALL 5 WORDS',
    hold: 'HOLD 5 SECONDS',
    holdScreen: {
      label: label ? cardLabelLine(label) : CARD_LABEL_PLACEHOLDER,
      labelKnown: label !== '',
      words: wordPages(args.words).map(p => p.words),
    },
  };
}

// ---------------------------------------------------------------------------
// Copy (A1, A1b, A2, A9, A10, A11). Plain British English, as the spec gives it.
// ---------------------------------------------------------------------------

export const FULL_ACCESS_COPY = {
  heading: 'Give this phone full access?',
  covers: 'Everyday lets this phone sign anything and read your messages as your persona (and your real name, if you use it), including your children\'s backups. Extra careful limits what signs without you. You can take it back in Settings.',
  realNameForLegacyBackups: 'Your older backups still sign with your real-name key, so this includes it.',
  expect: 'Your Heartwood will show FULL ACCESS and five words, two at a time. Check every word matches the ones here. When they\'ve all shown, hold its button for 5 seconds. If any word doesn\'t match, don\'t hold.',
  warning: 'Your Heartwood only shows FULL ACCESS when you start it here. If it ever shows it at another time, don\'t hold the button.',
  setUp: 'Set up with one hold',
  separately: 'Approve each thing separately',
  styleHeading: 'How should this phone sign?',
  everyday: { name: 'Everyday', tag: 'recommended', body: 'Sign-ins, posts and backups happen from your phone, at home or away. Your Heartwood is needed for big things: new keys, money, your real name the first time.' },
  // The hold being offered already covers the real name, so it is not a "first time" ask.
  everydayWithRealName: 'Sign-ins, posts and backups happen from your phone, at home or away. Your Heartwood is needed for big things: new keys and money.',
  careful: { name: 'Extra careful', tag: '', body: 'Backups, app data and relay logins happen on their own, and reading messages still works. Signing in to sites, posting and sending messages ask on your Heartwood, so they wait until you\'re home.' },
  holding: 'Your Heartwood is showing FULL ACCESS and five words, two at a time. Check every word matches the ones above. When they\'ve all shown, hold its button for 5 seconds. If any word doesn\'t match, don\'t hold.',
  holdScreenHeading: 'While you hold the button it shows:',
  cardHintChange: (hold: string) => `When every page has shown, the last line changes to ${hold}.`,
  approvedOutcome: 'Full access is on for this phone.',
  declined: 'Full access wasn\'t approved. Nothing changed. You can try again in a minute.',
  noAnswer: 'Your Heartwood didn\'t answer in time. If you did hold its button, full access may already be on: check Settings, Advanced. You can also try again in a minute.',
  // Onboarding has no Settings yet, so it cannot point there.
  noAnswerOnboarding: 'Your Heartwood didn\'t answer in time. If you did hold its button, full access may already be on. You can try again in a minute.',
  anotherCard: 'Your Heartwood got another full access request at the same moment, so it closed this one. Nothing changed. You can try again in a minute.',
  cardShownRecently: 'Your Heartwood showed a full access card a moment ago, so it won\'t show another yet. Nothing changed. You can try again in a minute.',
  saveFailed: 'Your Heartwood couldn\'t save that. Nothing changed. You can try again in a minute.',
  saveFailedFatal: 'Your Heartwood couldn\'t save that and needs attention. Connect it by cable and check it in Sapwood.',
  busy: 'Your Heartwood was busy. Nothing changed. Try again.',
  changed: 'Something changed on your Heartwood while it waited. Nothing changed here. Try again in a minute.',
  tryAgain: 'Try again',
  unreachable: 'Couldn\'t reach your Heartwood. Check it\'s switched on and online, then try again. Nothing changed.',
  pairingMismatch: 'Your Heartwood\'s keys don\'t match this phone\'s. Nothing was changed.',
  personaMissing: 'Your Heartwood doesn\'t have this phone\'s keys yet, so nothing was changed.',
  missingKey: 'This phone is missing a key it needs for full access, so nothing was sent. Your Heartwood will keep asking about each thing separately.',
  realNameFirstUse: 'The first time you use your real name, your Heartwood will ask you to confirm it once.',
  needsHeartwood: 'This needs your Heartwood. Try again when you\'re with it.',
  lostPhone: 'If you lose this phone, remove it in Sapwood.',
  // Sapwood: the consent panel's "Withdraw all for this client" drops the mark, but it only shows
  // while the client still has a remembered approval. Edit or Remove drops it too.
  sapwoodForget: 'In Sapwood, open this phone\'s pairing and choose Withdraw all for this client. If that button isn\'t there, choose Edit or Remove for the pairing instead.',
  turnOffUnconfirmed: 'Your Heartwood still shows full access as on, so it was not turned off.',
  turnOffUnknown: 'Couldn\'t check your Heartwood. Full access may already be off; it will show here next time it connects.',
  customStyleName: 'Custom',
  customStyleBody: 'Changed in Sapwood, so your Heartwood signs only some things on its own. Choose a style again to set it with a hold on your Heartwood.',
  chooseStyleAgain: 'Choose a style again',
  customNarrow: 'Your Heartwood\'s list was changed in Sapwood, so this changed nothing. Choose a style again to set it with a hold.',
  offerExisting: 'Give this phone full access: one hold on your Heartwood',
  approveAgain: 'Approve this phone again on your Heartwood',
  pairAgain: 'Pair again from My Signet',
} as const;

/** Section 7's table: why the hold is refused, in words the owner can act on. */
export const PAIRING_PROBLEM_COPY = {
  strict: 'Pair My Signet in Sapwood with the cable plugged in.',
  everything: 'Pair My Signet with Everything access in Sapwood.',
  shared: 'This pairing is used by another device. Make a separate link for this phone in Sapwood.',
  phoneMayOk: 'Turn off \'Approve from my phone\' for My Signet in Sapwood.',
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
  /** Signing mode is bunker on an owner install (never a paired child). */
  bunkerMode: boolean;
  /**
   * The router probe has settled: a router is installed, or the probe gave up
   * (`unsupported`). Until then `supported` cannot be known.
   */
  routerSettled: boolean;
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
   * Hold the backups. ONLY until the router probe has settled AND the first
   * owner-status answer is in (A8), so a card is not queued beside the one the
   * owner may be asked for. "Settled" is success or failure: a router that
   * lists no bundle method, a failed probe or an unanswered status all release
   * the hold (the caller also bounds the wait). Once the answer is in, even
   * `owner:false`, backups run (today's cards): a pairing the owner
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
  const statusPending = i.supported && i.awaitingFirstStatus;
  const holdBackups = i.everHadFullAccess && i.bunkerMode && (!i.routerSettled || statusPending);
  return { lost, offer, holdBackups };
}

/**
 * A2: will the first use of the real name raise a card on the Heartwood?
 * Only when the grant on file does not cover `natural-person`. With nothing on
 * file (an install that ran the hold before the grant was recorded) the answer
 * is today's: a Heartwood that supports the hold asks once. A mark the device
 * has dropped (`ownerOn === false`) covers nothing either.
 */
export function realNameFirstUseAsks(args: {
  supported: boolean;
  /** The `act_as` the device echoed at the last hold; undefined = none on file. */
  storedActAs: readonly string[] | undefined;
  /** `heartwood_owner_status`'s `owner`, `null` = not known. */
  ownerOn: boolean | null;
}): boolean {
  if (!args.supported) return false;
  if (!args.storedActAs) return true;
  return !(args.ownerOn !== false && args.storedActAs.includes('natural-person'));
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

/** The identities a bundle may name (W6): any other name is `-3 malformed bundle`. */
export const BUNDLE_IDENTITY_NAMES: readonly string[] = ['persona', 'natural-person'];

/** The `act_as` list a request asks for. */
export function requestedActAs(args: Pick<BundleParamArgs, 'actAsNaturalPerson'>): string[] {
  return args.actAsNaturalPerson ? ['natural-person', 'persona'] : ['persona'];
}

/** The single JSON-string param of `heartwood_approve_bundle`. */
export function buildBundleParam(args: BundleParamArgs): string {
  const expectEntries: Record<string, string> = {};
  if (args.expect?.naturalPerson) expectEntries['natural-person'] = args.expect.naturalPerson.toLowerCase();
  if (args.expect?.persona) expectEntries['persona'] = args.expect.persona.toLowerCase();
  const body: Record<string, unknown> = {
    v: 1,
    personas: ['natural-person', 'persona'],
    act_as: requestedActAs(args),
    ...(Object.keys(expectEntries).length > 0 ? { expect: expectEntries } : {}),
    create: args.create,
    style: args.style,
  };
  return JSON.stringify(body);
}

export interface BundleSuccess {
  naturalPerson: string;
  persona: string;
  /** The identities the device says this phone may act as: what the grant really is, kept on file. */
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
  ctx: {
    masterPubkey: string;
    requestedStyle: OwnerStyle;
    expect?: { naturalPerson?: string; persona?: string };
    /** What the request asked `act_as` to be. When given, the echo must not name anything else. */
    requestedActAs?: readonly string[];
  },
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
  // The echo is the device's own statement of what it granted. It must be a
  // list of known names that includes the persona and nothing wider than the
  // request asked for; a narrower grant is accepted and recorded as it is, so
  // the real-name copy stays true.
  if (!Array.isArray(parsed.act_as) || !parsed.act_as.every((x): x is string => typeof x === 'string')) return null;
  const actAs = [...new Set(parsed.act_as.map(x => x.toLowerCase()))];
  if (!actAs.includes('persona')) return null;
  if (!actAs.every(x => BUNDLE_IDENTITY_NAMES.includes(x))) return null;
  if (ctx.requestedActAs && !actAs.every(x => ctx.requestedActAs!.includes(x))) return null;
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
    | 'declined' | 'no-answer' | 'busy' | 'changed' | 'another-card' | 'card-recent' | 'save-failed' | 'unreachable' | 'strict' | 'kinds-list' | 'shared' | 'every-request' | 'phone-may-ok'
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
  // W3: one full-access card at a time. Both are `-1 unauthorised: ...`; tested
  // before the bare `unauthorised`. A client that keeps sending bundles can
  // block pairing but never gets the mark, so the owner waits a minute.
  if (/another full access request arrived/.test(lower)) return { action: 'retry', code: 'another-card', message: FULL_ACCESS_COPY.anotherCard };
  if (/full access card shown recently/.test(lower)) return { action: 'retry', code: 'card-recent', message: FULL_ACCESS_COPY.cardShownRecently };
  if (/^unauthori[sz]ed$/.test(lower)) return { action: 'continue', code: 'strict', message: PAIRING_PROBLEM_COPY.strict };
  if (/approval list full/.test(lower)) return { action: 'silent', code: 'approval-list-full', message: '' };
  if (/storage full/.test(lower)) return { action: 'continue', code: 'storage-full', message: DEVICE_LIMIT_COPY.storageFull };
  if (/no persona tree/.test(lower)) return { action: 'continue', code: 'no-persona-tree', message: DEVICE_LIMIT_COPY.noPersonaTree };
  if (/method list full/.test(lower)) return { action: 'continue', code: 'method-list-full', message: DEVICE_LIMIT_COPY.methodListFull };
  // The `-4` save failures after a press: the slot step could not be made
  // durable and was rolled back (nip46_handler.rs `persist_bind_or_rollback`),
  // or the persona registry could not be written. The fatal variant could not
  // restore the prior policy, so it must not say nothing changed.
  if (/fatal storage error/.test(lower)) return { action: 'continue', code: 'save-failed', message: FULL_ACCESS_COPY.saveFailedFatal };
  if (/could not persist|persona (state|count|chunk|entry|registry)|failed to (inspect|read|verify|write) persona/.test(lower)) {
    return { action: 'retry', code: 'save-failed', message: FULL_ACCESS_COPY.saveFailed };
  }
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
    requestedActAs: requestedActAs(args),
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
  style: StatusStyle;
}

export function parseOwnerStatus(raw: string): OwnerStatus | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed) || typeof parsed.owner !== 'boolean') return null;
  const style: StatusStyle = parsed.style === 'careful' || parsed.style === 'custom' ? parsed.style : 'everyday';
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

/** `style: 'custom'` = the device answered that the slot's list is custom and changed nothing (W4). */
export type NarrowResult = { ok: true; changed: boolean } | { ok: false; message: string; style?: 'custom' };

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
    // W4: narrowing a custom slot changes nothing and says so.
    if (isRecord(parsed) && parsed.style === 'custom') return { ok: false, message: FULL_ACCESS_COPY.customNarrow, style: 'custom' };
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
  words: PairWords;
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
    run: async (style) => {
      const out = await runApproveBundle(args.request, {
        // m8 / A1: false is right here. Onboarding runs before any identity
        // exists, and the identity it creates is persona-first with the real-name
        // slot dormant (`naturalPersonActive: false`), so there is no active real
        // identity to include. An existing install passes `isNaturalPersonActive`
        // through `useHeartwoodOwner` (`includeRealName`).
        create: true, actAsNaturalPerson: false, style, masterPubkey: args.masterPubkey,
      });
      // Onboarding has no Settings page to check, so the generic line that
      // sends the owner there is replaced.
      if (!out.ok && out.failure.code === 'no-answer') {
        return { ok: false, failure: { ...out.failure, message: FULL_ACCESS_COPY.noAnswerOnboarding } };
      }
      return out;
    },
  });
}
