/**
 * Bounded wait for a routed (device-held) signing backend.
 *
 * A slot whose key lives on the paired signer (stripped by the Heartwood
 * migration, or accepted keyless on a `deviceHeldKeys` install) has no local
 * key to fall back to. After an auto-lock the per-persona router is torn down
 * by design and only comes back once the app is unlocked, the primary pairing
 * has reconnected and the capabilities probe has answered. An approval tapped
 * in that window must neither dead-end on a local-key unlock prompt nor hang:
 * it waits a bounded time for the route, then gives up with an honest,
 * retryable message.
 */
export interface AwaitRoutedBackendOptions<B> {
  /** The route for the slot right now, or null while it is not available. */
  lookup: () => B | null;
  /**
   * True once waiting can no longer help (signer answered "unsupported",
   * the request was withdrawn, the app locked again). Stops the wait early.
   */
  isHopeless?: () => boolean;
  /** Total wait budget. */
  timeoutMs: number;
  /** Poll interval. */
  intervalMs?: number;
}

export async function awaitRoutedBackend<B>(opts: AwaitRoutedBackendOptions<B>): Promise<B | null> {
  const interval = Math.max(10, opts.intervalMs ?? 250);
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);
  for (;;) {
    const found = opts.lookup();
    if (found) return found;
    if (opts.isHopeless?.()) return null;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(interval, left)));
  }
}

/** How long an approval waits for the signer's route after an unlock/reconnect. */
export const ROUTED_APPROVAL_WAIT_MS = 20_000;

/**
 * The approval-side use of awaitRoutedBackend, shared by the sign-in and the
 * NIP-46 connect approvals: wait (bounded) for a device-held slot's route,
 * stop as soon as the request is no longer the pending one, and end in either
 * the route or an honest error — never a hang, never a local-key dead end.
 */
export async function acquireRoutedBackend<B>(o: {
  lookup: () => B | null;
  isHopeless?: () => boolean;
  stillPending: () => boolean;
  unavailableMessage: () => string;
  withdrawnMessage: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<B> {
  const found = await awaitRoutedBackend({
    lookup: o.lookup,
    isHopeless: () => !o.stillPending() || (o.isHopeless?.() ?? false),
    timeoutMs: o.timeoutMs ?? ROUTED_APPROVAL_WAIT_MS,
    intervalMs: o.intervalMs,
  });
  if (!o.stillPending()) throw new Error(o.withdrawnMessage);
  if (!found) throw new Error(o.unavailableMessage());
  return found;
}
