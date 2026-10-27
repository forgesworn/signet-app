/**
 * Wire constants for reading a user's Keep from relays (My Keep screen).
 *
 * A Keep is the small always-on device the Bothy software runs on. Bothy
 * publishes two things about it:
 *   - a claim, signed by the owner's master key, saying "this node is mine";
 *   - a status card, signed by the node's own key, republished about every
 *     five minutes.
 *
 * PROVISIONAL: these kind numbers are not allocated. They may change before
 * the Bothy events draft is upstreamed (the collision re-check is still
 * open). Every kind number this app uses for Keeps lives in this file and
 * nowhere else, so a renumbering is a one-line edit here.
 */

/** Addressable claim of a node by its owner (`d` = node key). Provisional. */
export const KEEP_CLAIM_KIND = 30640;

/** Replaceable status card signed by the node itself. Provisional. */
export const KEEP_STATUS_KIND = 10640;

/** Relays Bothy publishes to. Both are also in the app's default read pool. */
export const KEEP_RELAYS: readonly string[] = ['wss://relay.damus.io', 'wss://nos.lol'];

/** A status newer than this (seconds) counts as online; Bothy republishes every 300 s. */
export const KEEP_ONLINE_WINDOW_S = 600;

/** A status dated further than this (seconds) into the future is not believed. */
export const KEEP_FUTURE_SKEW_S = 300;

/*
 * K1d: owner-signed messages between My Signet and a Keep (provisional).
 *
 * Every message is a NIP-59 gift wrap whose rumor has one of these kinds and
 * an empty `content`. They are provisional (the numbers are not allocated) and
 * must not be used outside K1d testing. Like the constants above, this file is
 * the only place the numbers live.
 */
export const KEEP_MSG_CLAIM_KIND = 27660;
export const KEEP_MSG_INVITE_KIND = 27661;
export const KEEP_MSG_REVOKE_KIND = 27662;
export const KEEP_MSG_ACK_KIND = 27663;
/** K1e (provisional): the owner personas of a Keep. An update lists them; an accept comes from the persona being added. */
export const KEEP_MSG_OWNERS_KIND = 27664;
export const KEEP_MSG_ACCEPT_KIND = 27665;
/** K1f (provisional): return passes. An owner persona sets the switch and asks for reports; the Keep reports each pass. */
export const KEEP_MSG_SETTINGS_KIND = 27666;
export const KEEP_MSG_PASS_REPORT_KIND = 27667;
export const KEEP_MSG_PASSES_REQUEST_KIND = 27668;

/** Ack `status` values, and the `reason` values that go with `refused`. */
export const KEEP_ACK_STATUSES = ['paired', 'active', 'revoked', 'refused', 'updated', 'pending'] as const;
export const KEEP_REFUSAL_REASONS = ['expired', 'expiry_too_long', 'revoked', 'full', 'conflict', 'malformed', 'stale', 'too_many'] as const;

/** Invite lifetimes (seconds): a personal invite 30 days, a guest pass 24 hours. */
export const KEEP_PERSONAL_INVITE_S = 30 * 86400;
export const KEEP_GUEST_PASS_S = 24 * 3600;

/** The longest `name` label an invite carries, in characters. */
export const KEEP_INVITE_LABEL_MAX = 40;

/** NIP-59: the seal and wrap of a message to a Keep are backdated by up to this many seconds (2 days). */
export const KEEP_WRAP_JITTER_S = 2 * 86400;

/** The Keep backdates its acks by up to KEEP_WRAP_JITTER_S too, so a read starts that far before the newest ack seen. */
export const KEEP_ACK_BACKDATE_S = 2 * 86400;

/** The first read for a Keep (no ack seen yet) goes back this far: the backdating plus a day. */
export const KEEP_ACK_FIRST_LOOKBACK_S = 3 * 86400;

/** An unanswered invite or revoke is sent again, when the Keep's page opens, once its last send is older than this. */
export const KEEP_RESEND_AFTER_S = 600;

/**
 * A pass revoke is sent again only until the pass has been expired this long. The Keep remembers a pass's grant for
 * this long past its expiry (so the revoke of an expired pass still blocks the player); after that it no longer
 * knows the grant, and sending the revoke again can do nothing.
 */
export const KEEP_PASS_REVOKE_WINDOW_S = 30 * 86400;

/** A claim says whether the Keep is for every persona of the account or just the one that claims. */
export const KEEP_SCOPES = ['all', 'one'] as const;

/** The only section defined so far; the Keep keeps unknown section names and ignores them. */
export const KEEP_SECTION_GAMES = 'games';

/** The highest revision the Keep takes (exact in JavaScript); a higher one is `refused malformed`. */
export const KEEP_MAX_REV = 2 ** 53;

/** An owners update lists 1 to this many personas. */
export const KEEP_MAX_OWNER_PERSONAS = 16;

/**
 * A persona's own games invite lasts this long. The contract says 365 days, and the Keep
 * refuses an invite "more than 365 days ahead", so a phone clock a little ahead of the Keep's
 * would trip it: one hour is taken off.
 */
export const KEEP_GAMES_INVITE_S = 365 * 86400 - 3600;

/** A persona's games invite is renewed once less than this much of it is left. */
export const KEEP_GAMES_RENEW_BEFORE_S = 30 * 86400;

/** K1f: the states and the ways in a pass report may carry. */
export const KEEP_PASS_STATES = ['active', 'revoked', 'expired'] as const;
export const KEEP_PASS_VIAS = ['code', 'lan', 'link'] as const;

/** K1f: the one setting defined so far (the `setting` tag of its ack, and the tag of the settings message). */
export const KEEP_SETTING_RETURN_PASSES = 'return_passes';

/** K1f: a Keep stores at most this many passes; a passes request is answered with at most this many reports. */
export const KEEP_MAX_PASSES = 256;

/** K1f: a Keep whose last report (or last passes request) is older than this is asked for its passes again. */
export const KEEP_PASSES_REQUEST_AFTER_S = 7 * 86400;
