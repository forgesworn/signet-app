/**
 * Child-direct activity and connected apps (spec §9.1, §9.2).
 *
 * Task 11 declares the shapes the child's bunker produces; Task 12 adds the
 * rails (connected-apps event, gift-wrapped activity, merged timeline).
 */

/** An app or site the child's phone has served (spec §9.1). Unix seconds. */
export interface ConnectedChildApp {
  /** NIP-46 client pubkey, `nip55:<package>`, or the site origin. */
  appId: string;
  kind: 'nip46' | 'nip55' | 'site';
  label: string;
  url?: string;
  /** Persona pubkey the app was served as. */
  persona: string;
  firstSeen: number;
  lastUsed: number;
}

/**
 * One decision of the child's gate (spec §9.2). `at` and `requestCreatedAt`
 * are unix seconds; `requestCreatedAt` is the forced NIP-46 request
 * `created_at` the Heartwood echoes in its C5 rumor (set on `signed` and
 * `approved`, i.e. whenever the request is forwarded).
 */
export interface ChildActivityEntry {
  persona: string;
  kind: number | null;
  method: string;
  outcome: 'signed' | 'denied' | 'asked' | 'approved' | 'blocked' | 'expired';
  appId: string;
  appLabel: string;
  target?: string;
  requestCreatedAt?: number;
  at: number;
}
