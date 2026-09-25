/**
 * Keypair-selection policy resolver for Sign-in-with-Signet.
 *
 * Takes a set of available keypair options plus the inputs that can
 * influence selection (consumer hint, app guardrails, future: user
 * defaults, per-origin memory) and produces a ranked list with the
 * disallowed rows removed. The approval screens call into this once
 * and render the result — they don't make selection decisions themselves.
 *
 * Precedence (§4):
 *   appGuardrails > consumerHint > userDefaults > originMemory
 *
 * Only `consumerHint` and `appGuardrails` are wired so far; the other
 * inputs are accepted as parameters but ignored so follow-up work can
 * land without churn in the signatures.
 */

import type { ConsumerHint, KeypairToken, AppGuardrails, OriginPolicy } from '../types';

/** Something that can be selected for signing. */
export interface KeypairOption {
  /** Stable key — one of the token literals or an extra persona's hex pubkey. */
  key: string;
  /** Which family this option belongs to (drives allow-list filtering). */
  token: KeypairToken;
  /** Display name shown in the picker. */
  label: string;
  /** Hex pubkey for display / disambiguation. */
  pubkey: string;
}

/** User-side defaults that influence default selection when no consumer hint is present. */
export interface UserDefaults {
  /**
   * When true, sign-in flows default-select the persona keypair when the
   * consumer sent no `accept=` hint. Does NOT override an explicit hint.
   */
  preferPersonaForSignIns?: boolean;
  /**
   * Hex pubkey of the persona-family keypair (built-in `persona` or an
   * `extra-persona`) the user pinned as their preferred sign-in default.
   * Only consulted when `preferPersonaForSignIns` is true. When it doesn't
   * match a current persona-family option (e.g. the extra was deleted), the
   * resolver falls back to the built-in persona, then to NP. An NP pubkey
   * here is ignored — only persona-family options are honoured.
   */
  preferredPersonaPubkey?: string;
}

export interface ResolvePolicyInput {
  /** All signing options available to the user for this request. */
  options: KeypairOption[];
  /** Parsed consumer hint from the URL, if any. */
  consumerHint: ConsumerHint | null;
  /** User-side app guardrails. */
  appGuardrails: AppGuardrails;
  /** User-side defaults. Ignored when `consumerHint.allow` is non-empty. */
  userDefaults?: UserDefaults;
  /**
   * Per-origin memory from a previous sign-in. When `pinned`, overrides
   * consumer hints entirely. When unpinned, nudges default selection
   * towards the last-used keypair if it's still allowed.
   */
  originMemory?: OriginPolicy | null;
}

export interface ResolvedPolicy {
  /** Options that pass the allowlist, ordered so the preferred one is first. */
  ranked: KeypairOption[];
  /** Options excluded by the consumer's allowlist. */
  hidden: KeypairOption[];
  /** Key of the option to pre-select — first of `ranked`, or null if empty. */
  defaultKey: string | null;
  /**
   * When the user picks `natural-person`, require an extra confirmation.
   * True whenever the app guardrail is enabled.
   */
  requireNpConfirmation: boolean;
  /**
   * Short human-readable string to show above the picker. Sourced from
   * `accept_reason`, falling back to a generic label derived from the
   * allowlist. Null when no hint is present — caller should render no caption.
   */
  caption: string | null;
}

/**
 * Apply the consumer hint + app guardrails to the available options.
 * Pure function — no side effects, deterministic given its inputs.
 */
export function resolvePolicy(input: ResolvePolicyInput): ResolvedPolicy {
  const { options, consumerHint, appGuardrails, userDefaults, originMemory } = input;

  // ── Precedence: pinned origin > consumer hint > user defaults > origin memory ──
  //
  // A `pinned` origin-memory record short-circuits everything else — the user
  // explicitly said "always this keypair here." The result shape pretends the
  // consumer's hint didn't happen, so the picker doesn't show a caption for a
  // consumer decision the user has already overridden.
  if (originMemory?.pinned) {
    const pinnedOpt = options.find(o => o.key === originMemory.lastKeypair);
    if (pinnedOpt) {
      return {
        ranked: [pinnedOpt, ...options.filter(o => o.key !== pinnedOpt.key)],
        hidden: [],
        defaultKey: pinnedOpt.key,
        requireNpConfirmation: appGuardrails.requireNpConfirmation,
        caption: 'You pinned this identity for this site',
      };
    }
    // Pinned keypair no longer exists (deleted persona?) — fall through to
    // normal flow rather than fail closed.
  }

  // No consumer hint → apply user defaults + origin memory to choose a default.
  if (!consumerHint || consumerHint.allow.length === 0) {
    const ranked = options.slice();
    let defaultKey: string | null = ranked[0]?.key ?? null;

    // Tier 1 (low strength): preferPersona shifts default when available.
    // When the user pinned a specific persona (`preferredPersonaPubkey`),
    // promote that exact persona-family option; otherwise promote the
    // built-in `persona`. A stale/unknown pinned pubkey falls back to the
    // built-in persona, then (no persona at all) leaves NP.
    if (userDefaults?.preferPersonaForSignIns) {
      let targetIdx = -1;
      const wanted = userDefaults.preferredPersonaPubkey;
      if (wanted) {
        targetIdx = ranked.findIndex(
          o => o.pubkey === wanted && (o.token === 'persona' || o.token === 'extra-persona'),
        );
      }
      if (targetIdx === -1) {
        targetIdx = ranked.findIndex(o => o.token === 'persona');
      }
      if (targetIdx > 0) {
        const [promoted] = ranked.splice(targetIdx, 1);
        ranked.unshift(promoted);
        defaultKey = promoted.key;
      } else if (targetIdx === 0) {
        defaultKey = ranked[0].key;
      }
    }

    // Tier 2 (higher strength than preferPersona, lower than consumer hint):
    // origin memory pre-selects the last-used keypair if still available.
    if (originMemory && !originMemory.pinned) {
      const memIdx = ranked.findIndex(o => o.key === originMemory.lastKeypair);
      if (memIdx > 0) {
        const [promoted] = ranked.splice(memIdx, 1);
        ranked.unshift(promoted);
        defaultKey = promoted.key;
      } else if (memIdx === 0) {
        defaultKey = ranked[0].key;
      }
    }

    return {
      ranked,
      hidden: [],
      defaultKey,
      requireNpConfirmation: appGuardrails.requireNpConfirmation,
      caption: consumerHint?.reason ?? null,
    };
  }

  // ── Consumer-hint path ──
  const allowSet = new Set<KeypairToken>(consumerHint.allow);

  const ranked: KeypairOption[] = [];
  const hidden: KeypairOption[] = [];
  for (const opt of options) {
    if (allowSet.has(opt.token)) ranked.push(opt);
    else hidden.push(opt);
  }

  // Stable ordering by the allow-list order: earlier token → earlier in ranked.
  const tokenOrder = new Map<KeypairToken, number>();
  consumerHint.allow.forEach((t, i) => tokenOrder.set(t, i));
  ranked.sort((a, b) => {
    const ai = tokenOrder.get(a.token) ?? 999;
    const bi = tokenOrder.get(b.token) ?? 999;
    return ai - bi;
  });

  // Apply explicit prefer= if it's in the allowlist.
  if (consumerHint.prefer && allowSet.has(consumerHint.prefer)) {
    const idx = ranked.findIndex(o => o.token === consumerHint.prefer);
    if (idx > 0) {
      const [promoted] = ranked.splice(idx, 1);
      ranked.unshift(promoted);
    }
  }

  // Origin memory (lowest-precedence tie-breaker): if the consumer allowlist
  // leaves multiple options and the user's last choice at this origin is one
  // of them, nudge it to the front. Still respects allowlist + prefer.
  if (originMemory && !originMemory.pinned && !consumerHint.prefer) {
    const memIdx = ranked.findIndex(o => o.key === originMemory.lastKeypair);
    if (memIdx > 0) {
      const [promoted] = ranked.splice(memIdx, 1);
      ranked.unshift(promoted);
    }
  }

  return {
    ranked,
    hidden,
    defaultKey: ranked[0]?.key ?? null,
    requireNpConfirmation: appGuardrails.requireNpConfirmation,
    caption: consumerHint.reason ?? defaultCaption(consumerHint.allow),
  };
}

/**
 * Generic caption when the consumer didn't supply `accept_reason`.
 * Kept deliberately generic — the site origin is shown elsewhere on
 * the approval screen, so we don't embed it here (avoids the need to
 * re-truncate attacker-controlled strings in another display surface).
 */
function defaultCaption(allow: KeypairToken[]): string {
  if (allow.length === 1) {
    switch (allow[0]) {
      case 'natural-person':
        return 'This site asked for your real-name identity';
      case 'persona':
        return 'This site asked for a persona';
      case 'extra-persona':
        return 'This site asked for one of your extra personas';
    }
  }
  // Multi-token allowlist.
  const hasPerson = allow.includes('natural-person');
  return hasPerson
    ? 'This site prefers a specific identity type'
    : 'This site asked for a persona';
}

/**
 * Decide whether the resolver's recommended default should override the
 * incoming carousel/`defaultSelection` (the row the user happened to be on
 * when the request arrived).
 *
 * The carousel's active row is usually the guardian Natural Person simply
 * because NP is the primary keypair — an *incidental* default, not a
 * deliberate identity choice. A user who turned on "prefer persona for
 * sign-ins" (optionally pinning a specific persona) expects that preference
 * to win over the incidental NP default; without this, `resolvePolicy`'s
 * persona default is computed but never reached, so the toggle looks like a
 * no-op.
 *
 * Returns true only when ALL hold:
 *   - no consumer hint is constraining the picker (the hint path owns the
 *     default when present),
 *   - the incoming selection is the guardian Natural Person (we never
 *     override a deliberately-selected persona or a dependant selection),
 *   - the resolver produced a non-NP default (i.e. a persona preference
 *     actually promoted something).
 * Pure function — no side effects.
 */
export function shouldOverrideIncomingDefault(input: {
  incomingSource: 'guardian' | 'dependant' | null;
  incomingKey: string | null;
  resolverDefaultKey: string | null;
  hasConsumerHint: boolean;
}): boolean {
  const { incomingSource, incomingKey, resolverDefaultKey, hasConsumerHint } = input;
  if (hasConsumerHint) return false;
  if (incomingSource !== 'guardian' || incomingKey !== 'natural-person') return false;
  if (!resolverDefaultKey || resolverDefaultKey === 'natural-person') return false;
  return true;
}

/**
 * Classify what the empty-state should offer when every option is
 * filtered out. The caller decides how to render each case.
 */
export type EmptyStateKind =
  | 'no-persona-configured'   // user has only NP; accept=persona
  | 'no-extra-persona'        // user has NP + persona but no extras; accept=extra-persona
  | 'np-hidden'               // user has NP only and accept excludes it (bunker edge case)
  | 'np-dormant'              // accept includes NP but the real identity isn't activated yet
  | 'generic';

export function classifyEmptyState(
  hint: ConsumerHint | null,
  hasPersona: boolean,
  hasExtras: boolean,
  hasNp: boolean,
  npDormant = false,
): EmptyStateKind {
  if (!hint || hint.allow.length === 0) return 'generic';
  const wantsPersona = hint.allow.includes('persona');
  const wantsExtra = hint.allow.includes('extra-persona');
  const wantsNp = hint.allow.includes('natural-person');
  // Checked first: a consumer asking for the real identity of a user who has
  // not activated one has an actionable answer ("activate it"), which beats
  // every "you have no persona" message we could show instead.
  if (wantsNp && npDormant) return 'np-dormant';
  if (wantsPersona && !hasPersona) return 'no-persona-configured';
  if (wantsExtra && !wantsPersona && hasPersona && !hasExtras) return 'no-extra-persona';
  if (!wantsNp && hasNp && !hasPersona && !hasExtras) return 'np-hidden';
  return 'generic';
}
