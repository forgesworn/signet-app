/**
 * In-memory log of inbound Sign-in-with-Signet requests, for the
 * power-mode Developer diagnostics page.
 *
 * NOT persisted to IndexedDB — by design. The primary use case is
 * consumer developers debugging their integration; we don't want to
 * accumulate an auth-request history on disk for user-side privacy.
 *
 * Capped ring buffer — newest entries evict the oldest.
 */

import type { ConsumerHint } from '../types';

export interface AuthRequestLogEntry {
  at: number;
  origin: string;
  /** Parser warnings (comma-token list from parseConsumerHint). */
  warnings: string[];
  /** Consumer hint shape, or null if the URL didn't carry one. */
  hint: ConsumerHint | null;
  /** Result outcome — set later when the user takes action. */
  outcome?: 'approved' | 'denied' | 'cancelled';
  /** Keypair chosen on approve, if applicable. */
  chosen?: string;
}

const CAP = 20;
const entries: AuthRequestLogEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Append a request as it arrives. Returns the entry so callers can mutate `outcome`. */
export function logAuthRequest(entry: Omit<AuthRequestLogEntry, 'at'>): AuthRequestLogEntry {
  const full: AuthRequestLogEntry = { ...entry, at: Math.floor(Date.now() / 1000) };
  entries.push(full);
  if (entries.length > CAP) entries.splice(0, entries.length - CAP);
  notify();
  return full;
}

/** Update the outcome on a previously-logged entry. No-op if not tracked. */
export function updateAuthRequestOutcome(entry: AuthRequestLogEntry, outcome: AuthRequestLogEntry['outcome'], chosen?: string) {
  entry.outcome = outcome;
  if (chosen !== undefined) entry.chosen = chosen;
  notify();
}

export function getAuthRequestLog(): AuthRequestLogEntry[] {
  return entries.slice().reverse(); // newest first
}

export function clearAuthRequestLog(): void {
  entries.length = 0;
  notify();
}

export function subscribeAuthRequestLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
