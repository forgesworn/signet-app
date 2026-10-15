/**
 * Relay-mode "Sign in with Signet": the pure rules for using every consumer
 * relay (up to three, primary first — see `parseAuthRelays` in url-auth.ts).
 *
 * App.tsx owns the effects (arming the in-page NIP-46 listener, publishing
 * the gift wrap); these helpers decide the order and what counts as success,
 * so the rules can be tested without the app.
 */

import { dedupeRelayUrls, relayCompareKey } from './url-auth';

export interface AuthDeliveryPlan {
  /** Consumer relays first (deduped, in order), then the user's relay if it is not one of them. */
  targets: string[];
  /** How many leading entries of `targets` are consumer relays. */
  consumerCount: number;
}

/**
 * Where the response gift wrap goes. The consumer subscribes to its own
 * relays, so they come first; the user's relay is a best-effort extra copy
 * and is appended only when it is not already a consumer relay.
 */
export function planAuthDeliveryTargets(
  consumerRelays: readonly string[],
  userRelay: string | null | undefined,
): AuthDeliveryPlan {
  const consumer = dedupeRelayUrls(consumerRelays);
  const targets = dedupeRelayUrls([...consumer, userRelay]);
  return { targets, consumerCount: consumer.length };
}

/**
 * Delivered when ANY consumer relay accepted the wrap. The user's own relay
 * accepting alone does not count: the consumer is not listening there, so a
 * success on it would show "approved" while the site stays signed out.
 */
export function deliveredToConsumer(results: readonly boolean[], consumerCount: number): boolean {
  return results.slice(0, consumerCount).some(ok => ok === true);
}

/**
 * Arm the listener on the consumer relays in order; the first that opens
 * wins. With one relay, its own error is rethrown unchanged (today's
 * behaviour). With several, the error names every relay tried. Returns null,
 * without trying the next relay, once `stillOpen` says the request was
 * denied or withdrawn after a failed attempt.
 */
export async function armFirstOpenRelay(
  relays: readonly string[],
  arm: (relayUrl: string) => Promise<void>,
  stillOpen: () => boolean = () => true,
): Promise<string | null> {
  const candidates = dedupeRelayUrls(relays);
  if (candidates.length === 0) throw new Error('No relay to listen on');
  if (candidates.length === 1) {
    await arm(candidates[0]);
    return candidates[0];
  }
  const failures: string[] = [];
  for (const relayUrl of candidates) {
    if (failures.length > 0 && !stillOpen()) return null;
    try {
      await arm(relayUrl);
      return relayUrl;
    } catch (e) {
      failures.push(`${relayUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`listener not ready on any of ${candidates.length} relays (${failures.join(' | ')})`);
}

/**
 * Relays for the one-shot bunker URI handed to the consumer: the relay the
 * listener actually opened on first, then the other consumer relays, then
 * the rest (user relay, saved fallbacks, built-in fallbacks), deduped.
 */
export function authBunkerRelays(
  armedRelay: string,
  consumerRelays: readonly string[],
  rest: readonly (string | null | undefined)[],
): string[] {
  const armedKey = relayCompareKey(armedRelay);
  return dedupeRelayUrls([
    armedRelay,
    ...consumerRelays.filter(r => relayCompareKey(r) !== armedKey),
    ...rest,
  ]);
}
