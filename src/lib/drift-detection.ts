/**
 * Consumer-behaviour drift detection for Sign-in-with-Signet.
 *
 * When a site's `accept=` hint pattern changes in a surprising way we
 * surface an inline notice so the user isn't silently steered toward a
 * different identity than they expected. Zero telemetry — this is a
 * purely local analysis over the rolling `acceptHistory` on the origin's
 * per-origin policy record (see `OriginPolicy`).
 */

import type { ConsumerHint, KeypairToken, OriginPolicy } from '../types';

export type DriftSignal =
  | {
      kind: 'persona-to-np';
      /** Human-readable explanation for the picker. */
      message: string;
    }
  | {
      kind: 'persona-to-none';
      message: string;
    }
  | {
      kind: 'first-np-request';
      message: string;
    };

/** Number of prior entries that must agree before we call something a drift. */
const MIN_HISTORY_DEPTH = 3;

/** True when `allow` is a persona-only or persona-dominant allowlist. */
function wasPersonaShaped(allow: KeypairToken[]): boolean {
  if (allow.length === 0) return false;
  return allow.includes('persona') && !allow.includes('natural-person');
}

/** True when the current hint is shaped toward natural-person. */
function currentShapeIsNp(hint: ConsumerHint | null): boolean {
  if (!hint || hint.allow.length === 0) return false;
  return hint.allow.includes('natural-person') && !hint.allow.includes('persona');
}

/** True when the current hint is absent / effectively 'no filter'. */
function currentShapeIsOpen(hint: ConsumerHint | null): boolean {
  return !hint || hint.allow.length === 0;
}

/**
 * Compare the current request's hint against the origin's history of
 * past hints. Returns a drift signal to display, or null if nothing
 * interesting has changed.
 *
 * Heuristics are deliberately conservative — we'd rather undercount
 * than cry wolf. Only fires when the prior N requests were all the
 * same persona-shaped and the current request breaks that pattern.
 */
export function detectDrift(
  currentHint: ConsumerHint | null,
  memory: OriginPolicy | null | undefined,
): DriftSignal | null {
  if (!memory) {
    // First-time site with hostile-looking hint — flag it (low-volume guard).
    if (currentHint && currentShapeIsNp(currentHint)) {
      return {
        kind: 'first-np-request',
        message: "This site is asking for your real-name identity. Most sites don't need it.",
      };
    }
    return null;
  }

  const history = memory.acceptHistory ?? [];
  if (history.length < MIN_HISTORY_DEPTH) return null;

  const recent = history.slice(-MIN_HISTORY_DEPTH);
  const allPersona = recent.every(entry => wasPersonaShaped(entry.allow));
  if (!allPersona) return null;

  if (currentShapeIsNp(currentHint)) {
    return {
      kind: 'persona-to-np',
      message: "This site previously asked for a persona. Today it's asking for your real name.",
    };
  }
  if (currentShapeIsOpen(currentHint)) {
    return {
      kind: 'persona-to-none',
      message: "This site previously asked for a persona. Today it isn't specifying — all your identities are shown.",
    };
  }
  return null;
}
