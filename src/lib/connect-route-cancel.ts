import type { AuthRequestSettlement } from './auth-request-settlement';

type DenyOutcome = ReturnType<AuthRequestSettlement['deny']>;

/**
 * Which transient serving route each NIP-46 connect approval installed, so a
 * Cancel can take it down at once instead of when the approval next reaches a
 * checkpoint — which can be many seconds later while a device-held key opens
 * its routed connection, a relay arms, or the response is signed.
 *
 * The approval's own rollback (connect-delivery) still runs afterwards and
 * clears the same token again; App's clear-by-token is a no-op the second
 * time, and never touches a newer approval's route.
 */
export class ConnectRouteTracker {
  private readonly tokens = new Map<string, number>();

  /** The approval for `key` installed the route identified by `token`. */
  record(key: string, token: number): void {
    this.tokens.set(key, token);
  }

  /** The approval for `key` connected; its route now serves a live pairing. */
  forget(key: string): void {
    this.tokens.delete(key);
  }

  /**
   * A Cancel landed on `key`. Returns the route token to clear now, or null.
   *
   * `outcome` is AuthRequestSettlement.deny(key); `cancelRecorded` is
   * requestCancelDuringDelivery(key) when that outcome was 'already-answered'.
   * A request already answered with no delivery still running has connected:
   * its route serves the new pairing and is kept. Every other Cancel abandons
   * the approval (or follows one that failed), so its route goes.
   */
  takeOnCancel(key: string, outcome: DenyOutcome, cancelRecorded: boolean): number | null {
    if (outcome === 'already-answered' && !cancelRecorded) return null;
    const token = this.tokens.get(key);
    this.tokens.delete(key);
    return token ?? null;
  }
}
