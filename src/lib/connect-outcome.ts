import type { AuthRequestSettlement } from './auth-request-settlement';

/**
 * What the Nostr Connect approval screen shows for one request.
 *
 * Held by App, not by the page: a lock remounts the page while the approval
 * (and App's pending request) carry on, so a result kept in the page's own
 * state would be lost and the request would come back looking unanswered.
 * Keyed by the request's settlement key, so another request never reads it.
 *
 * `closed` is an answered request that ended with a message (the Heartwood
 * may already have told the app): Close only. `error` is a failure that left
 * the request open for another try.
 */
export interface ConnectOutcome {
  key: string;
  status: 'sending' | 'sent' | 'closed' | 'error';
  error?: string;
}

export interface TrackedApproval {
  key: string;
  /** The one-answer guard. Its state, not the error's type, says whether the request is answered. */
  settlement: AuthRequestSettlement;
  /** Still the request App holds; a cleared or replaced one records nothing. */
  isCurrent: () => boolean;
  record: (outcome: ConnectOutcome | null) => void;
  run: () => Promise<void>;
}

export const CONNECT_FAILED_COPY = 'Failed to connect — please try again';

/** The message the page shows for a failed approval. */
export function connectErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : CONNECT_FAILED_COPY;
}

/**
 * Run an approval and record where it ended. "Answered" is read from the
 * settlement after the run, so it can't disagree with what the guard allows:
 * an answered request shows its outcome with Close only, and an unanswered one
 * is open for retry.
 */
export async function trackApproval(a: TrackedApproval): Promise<void> {
  const { key, settlement, isCurrent, record } = a;
  const put = (outcome: ConnectOutcome | null) => { if (isCurrent()) record(outcome); };
  put({ key, status: 'sending' });
  try {
    await a.run();
  } catch (e) {
    put({ key, status: settlement.isAnswered(key) ? 'closed' : 'error', error: connectErrorMessage(e) });
    throw e;
  }
  // Returned without answering (withdrawn, taken over): nothing to show.
  put(settlement.isAnswered(key) ? { key, status: 'sent' } : null);
}
