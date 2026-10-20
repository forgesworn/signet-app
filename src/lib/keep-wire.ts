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
