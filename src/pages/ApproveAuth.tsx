import { useEffect, useMemo, useState } from 'react';
import { useApprovalPickerChoice, WAITING_FOR_SIGNER_COPY } from '../hooks/useApprovalPickerChoice';
export { WAITING_FOR_SIGNER_COPY, CHOSEN_UNAVAILABLE_COPY } from '../hooks/useApprovalPickerChoice';
import type { AuthRequest, LoginRequest } from '../lib/qr-router';
import type { SignetIdentity, DependantIdentity, ConsumerHint, KeypairToken, OriginPolicy } from '../types';
import { shortNpub } from '../lib/signet';
import { SharePreview } from '../components/SharePreview';
import { resolveSelectedDisplayName, resolveSelectedToken, resolveSelectedPubkey, resolveSelectedPublicProfile, buildGuardianKeypairOptions, buildDependantKeypairOptions } from '../lib/auth-selection';
import { isNaturalPersonActive } from '../lib/identity-display';
import { computeAge } from '../lib/date-utils';
import { resolvePolicy, classifyEmptyState, shouldOverrideIncomingDefault } from '../lib/keypair-policy';
import type { KeypairOption } from '../lib/keypair-policy';
import { detectDrift } from '../lib/drift-detection';
import { KeypairBadge } from '../components/KeypairBadge';
import { PairedChildApprovalWaiting } from '../components/PairedChildApprovalWaiting';

/**
 * Resolve the display name for SharePreview. Returns `'(anonymous)'` when a
 * slot IS selected but its name is empty — preferred over SharePreview's
 * fallback "(not set)" which implies an error rather than a deliberate
 * anonymous choice. When no selection exists (`sel` is null) returns
 * null so SharePreview can render its normal unselected state. (D3)
 */
function resolveDisplayNameForPreview(
  sel: AuthSelection | null,
  identity: SignetIdentity,
  dependants?: ReadonlyArray<Pick<DependantIdentity, 'id' | 'displayName' | 'dateOfBirth' | 'naturalPerson' | 'persona' | 'extraPersonas' | 'primaryKeypair' | 'naturalPersonActive'>>,
): string | null {
  if (!sel) return null;
  return resolveSelectedDisplayName(sel, identity, dependants) ?? '(anonymous)';
}

/**
 * Which account + keypair was selected for signing.
 *
 * `keypairType` is a literal token or an extra-persona's publicKey (hex):
 *  - 'natural-person' | 'persona' → the well-known built-in keypairs
 *  - 64-char hex string → the `publicKey` of an extra persona on the guardian
 *    identity or on a dependant identity.
 */
export type AuthSelection =
  | { source: 'guardian'; keypairType: string }
  | { source: 'dependant'; dependantId: string; keypairType: string };

interface Props {
  request: AuthRequest | LoginRequest;
  hasCredentialForSelection: (selection: AuthSelection | null) => boolean;
  identity: SignetIdentity;
  /** Whether the guardian has selectable signing identities. */
  canSwitchGuardianPersona: boolean;
  availableGuardianPubkeys?: readonly string[];
  /** Dependants available for signing (only when local backends exist) */
  dependants?: Array<Pick<DependantIdentity, 'id' | 'displayName' | 'dateOfBirth' | 'naturalPerson' | 'persona' | 'extraPersonas' | 'primaryKeypair' | 'naturalPersonActive'>>;
  /** Initial signing selection (e.g. the carousel's active row when the request arrived) */
  defaultSelection?: AuthSelection;
  /** Consumer-supplied hint from the URL (accept/prefer/accept_reason). */
  consumerHint: ConsumerHint | null;
  /**
   * When true, selecting the natural-person keypair requires an extra
   * confirmation step before the request is signed. Defends against
   * a hostile `accept=natural-person` pressuring real-name disclosure.
   */
  requireNpConfirmation: boolean;
  /** Per-origin memory for this request's origin, if any. */
  originMemory?: OriginPolicy | null;
  /** User-side defaults — prefer-persona toggle. */
  preferPersonaForSignIns?: boolean;
  /** Pinned preferred persona pubkey for the default selection. */
  preferredPersonaPubkey?: string;
  /** Inline add-persona callback used by the empty-state fallback. */
  onAddPersona?: (displayName: string) => Promise<void>;
  /**
   * Offered when the consumer asked for the real identity and this user has not
   * activated one (`classifyEmptyState` → `'np-dormant'`). Navigates to the
   * activation page with this pending auth as its `returnTo`. Absent on
   * surfaces that cannot activate (paired child).
   */
  onActivateRealIdentity?: () => void;
  onApprove: (selection: AuthSelection, shareHandle: boolean) => Promise<void> | void;
  onDeny: () => void;
  /**
   * Pre-populated error banner, used when an upstream handler (e.g. the
   * carousel-overlay quick-approve path) routes to this picker after
   * catching a throw — so the cause surfaces in the UI instead of being
   * silently swallowed.
   */
  initialError?: string;
  /**
   * An approval for THIS request is already in flight in App (e.g. one that
   * outlived the page instance that started it across a lock). Shown as
   * "Signing…" so the user never gets a fresh Approve for a request that is
   * already being answered.
   */
  externallyApproving?: boolean;
  /**
   * The user's explicit pick for THIS request, held by App so it survives a
   * lock/unlock remount. `undefined` ⇒ the user has not touched the picker
   * yet (the resolver's default applies); `{ selection }` ⇒ their choice,
   * which no default and no transient list change may override.
   */
  userChoice?: { selection: AuthSelection | null };
  /** Called when the user picks (or clears) an identity. */
  onUserChoice?: (selection: AuthSelection | null) => void;
  /**
   * Guardian slot pubkeys that are listed but not signable yet — their key is
   * on the paired signer and its route is not back (locked, reconnecting,
   * probing). Shown as waiting; Approve stays disabled while one is selected.
   */
  waitingGuardianPubkeys?: string[];
  /**
   * True when running on a paired-child surface (signingMode ===
   * 'paired-child'). When set, the in-flight approve state swaps the
   * "Signing…" button for a status panel that explains the kid is
   * waiting on the guardian's NIP-46 server — including a soft nudge +
   * Cancel after a long wait. See `PairedChildApprovalWaiting`.
   */
  isPairedChild?: boolean;
}

function isLoginRequest(r: AuthRequest | LoginRequest): r is LoginRequest {
  return r.type === 'signet-login-request';
}

function safeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname || origin.slice(0, 64);
  } catch {
    return origin.slice(0, 64);
  }
}

const VALID_AGE_RANGES = ['0-3', '4-7', '8-12', '13-17', '18+'];

/** Map an internal keypair literal / pubkey to its policy token family. */
function tokenFor(keypairLiteral: string): KeypairToken {
  if (keypairLiteral === 'natural-person') return 'natural-person';
  if (keypairLiteral === 'persona') return 'persona';
  return 'extra-persona';
}

/**
 * The approval screen's title, for the Layout header that renders it.
 *
 * Exported so the header is the ONE place the title appears: the screen used to
 * print it again as a section heading, which since the title stopped keying on
 * the request type (a plain sign-in is "Login Request" in both) showed the user
 * the same words twice and made every `getByText('Login Request')` in the e2e
 * suite ambiguous.
 */
export function approveAuthTitle(request: AuthRequest | LoginRequest): string {
  const ageRange = isLoginRequest(request)
    && typeof request.requiredAgeRange === 'string'
    && VALID_AGE_RANGES.includes(request.requiredAgeRange);
  return ageRange ? 'Login + Verification Request' : 'Login Request';
}

export function ApproveAuth({
  request,
  hasCredentialForSelection,
  identity,
  canSwitchGuardianPersona,
  availableGuardianPubkeys,
  dependants,
  defaultSelection,
  consumerHint,
  requireNpConfirmation,
  originMemory,
  preferPersonaForSignIns,
  preferredPersonaPubkey,
  onAddPersona,
  onActivateRealIdentity,
  onApprove,
  onDeny,
  initialError,
  externallyApproving = false,
  userChoice,
  onUserChoice,
  waitingGuardianPubkeys,
  isPairedChild = false,
}: Props) {
  const login = isLoginRequest(request);
  const originDisplay = safeOrigin(request.origin);
  const ageRange = login && typeof request.requiredAgeRange === 'string' && VALID_AGE_RANGES.includes(request.requiredAgeRange)
    ? request.requiredAgeRange
    : null;

  // Build guardian options and run them through the policy resolver so the
  // allowlist, caption, and default selection all come from one place.
  const guardianOptions: KeypairOption[] = useMemo(
    // Shared builder: persona-first order, dormant real identity excluded.
    // The filter keeps upstream's binding of the picker to the keys this
    // signing route can actually reach.
    () => buildGuardianKeypairOptions(identity)
      .filter(option => !availableGuardianPubkeys || availableGuardianPubkeys.includes(option.pubkey)),
    [identity, availableGuardianPubkeys],
  );

  const guardianPolicy = useMemo(
    () => resolvePolicy({
      options: guardianOptions,
      consumerHint,
      appGuardrails: { requireNpConfirmation },
      userDefaults: { preferPersonaForSignIns, preferredPersonaPubkey },
      originMemory,
    }),
    [guardianOptions, consumerHint, requireNpConfirmation, preferPersonaForSignIns, preferredPersonaPubkey, originMemory],
  );

  // Drift signal — shown inline above the picker when the consumer's
  // hint pattern at this origin changes in a surprising direction.
  const driftSignal = useMemo(
    () => detectDrift(consumerHint, originMemory ?? null),
    [consumerHint, originMemory],
  );

  // For each dependant, filter their keypair list by the allowlist too
  // (comment 2 §1 — dependant-scoped filter + empty state).
  const dependantOptionsById = useMemo(() => {
    const map = new Map<string, KeypairOption[]>();
    for (const dep of dependants ?? []) {
      const opts = buildDependantKeypairOptions(dep);
      const policy = resolvePolicy({
        options: opts,
        consumerHint,
        appGuardrails: { requireNpConfirmation },
        userDefaults: { preferPersonaForSignIns, preferredPersonaPubkey },
      });
      map.set(dep.id, policy.ranked);
    }
    return map;
  }, [dependants, consumerHint, requireNpConfirmation, preferPersonaForSignIns, preferredPersonaPubkey]);

  const hasAnyDependantOption = useMemo(
    () => Array.from(dependantOptionsById.values()).some(arr => arr.length > 0),
    [dependantOptionsById],
  );

  // When the caller's default selection is still allowed we keep it; otherwise
  // we fall back to the resolver's recommended default.
  const resolvedDefault = useMemo<AuthSelection | null>(() => {
    if (defaultSelection) {
      if (defaultSelection.source === 'guardian'
          && guardianPolicy.ranked.some(o => o.key === defaultSelection.keypairType)) {
        // The carousel's active row is usually NP just because NP is the
        // primary keypair — an incidental default. When the user prefers a
        // persona (resolver promoted one) and no consumer hint constrains
        // the picker, honour that preference over the incidental NP row so
        // the "prefer persona for sign-ins" toggle isn't a no-op.
        if (shouldOverrideIncomingDefault({
          incomingSource: 'guardian',
          incomingKey: defaultSelection.keypairType,
          resolverDefaultKey: guardianPolicy.defaultKey,
          hasConsumerHint: !!consumerHint && consumerHint.allow.length > 0,
        })) {
          return { source: 'guardian', keypairType: guardianPolicy.defaultKey! };
        }
        return defaultSelection;
      }
      if (defaultSelection.source === 'dependant') {
        const depOpts = dependantOptionsById.get(defaultSelection.dependantId);
        if (depOpts?.some(o => o.key === defaultSelection.keypairType)) return defaultSelection;
      }
    }
    if (guardianPolicy.defaultKey) {
      return { source: 'guardian', keypairType: guardianPolicy.defaultKey };
    }
    // Guardian empty — try first dependant with an allowed option.
    for (const dep of dependants ?? []) {
      const opts = dependantOptionsById.get(dep.id);
      if (opts && opts.length > 0) {
        return { source: 'dependant', dependantId: dep.id, keypairType: opts[0].key };
      }
    }
    return null;
  }, [defaultSelection, guardianPolicy, dependantOptionsById, dependants, consumerHint]);

  const {
    selection,
    setSelection,
    selectionWaiting,
    isWaitingPubkey,
    missingChosenOption,
    missingChosenCopy,
  } = useApprovalPickerChoice<AuthSelection>({
    identity,
    resolvedDefault,
    offeredGuardianKeys: guardianPolicy.ranked.map(o => o.key),
    guardianOptions,
    resolvePubkey: (sel) => resolveSelectedPubkey(sel, identity, dependants),
    userChoice,
    onUserChoice,
    waitingGuardianPubkeys,
  });
  const [shareHandle, setShareHandle] = useState(true);
  const [approvingHere, setApproving] = useState(false);
  const approving = approvingHere || externallyApproving;
  const [error, setError] = useState<string | null>(initialError ?? null);
  // An approval can outlive the instance that started it (a lock unmounts
  // the page mid-wait). Its failure then arrives here as a new initialError:
  // show it and make Approve usable again, never a silent reset.
  useEffect(() => {
    if (!initialError) return;
    setError(initialError);
    setApproving(false);
  }, [initialError]);
  const [addingPersona, setAddingPersona] = useState(false);
  const [newPersonaName, setNewPersonaName] = useState('');
  const [showNpConfirm, setShowNpConfirm] = useState(false);

  const needsCredential = login && ageRange !== null;
  const hasCredential = hasCredentialForSelection(selection);

  const isGuardianSelected = (keypairType: string) =>
    selection?.source === 'guardian' && selection.keypairType === keypairType;
  const isDependantSelected = (depId: string, keypairType: string) =>
    selection?.source === 'dependant' && selection.dependantId === depId && selection.keypairType === keypairType;


  // Keyed on whether a credential was actually asked for, NOT on the request
  // TYPE: every URL sign-in parses as `signet-login-request`, so keying on the
  // type told every plain sign-in that the site wanted to "verify your
  // identity" when it had asked for nothing of the sort. Alarming, and wrong.
  // The title itself is rendered ONCE, by the Layout header this screen sits in
  // (see `approveAuthTitle`) — repeating it here as a section heading showed the
  // user "Login Request" twice on every plain sign-in, and left the e2e selectors
  // matching two elements.
  const verificationAsked = ageRange !== null;
  const description = verificationAsked
    ? `${originDisplay} wants to log you in AND verify your identity.`
    : `${originDisplay} wants to log you in with your Signet identity.`;

  const guardianEmpty = guardianPolicy.ranked.length === 0;
  const allEmpty = guardianEmpty && !hasAnyDependantOption;


  // ── Mobile branch ───────────────────────────────────────────────────────

  if (needsCredential && !hasCredential) {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            {description}
          </p>

          <div
            className="card"
            style={{
              background: 'var(--warning-light)',
              borderColor: 'var(--warning)',
              marginBottom: 20,
            }}
          >
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
              This login also requires age verification ({ageRange}). You need to get verified
              before you can approve this request.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onDeny}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Empty-state path ───────────────────────────────────────────────────
  // The allowlist filtered every guardian AND dependant option out. Offer
  // an inline add-persona flow (same-device escape hatch) and a clearly
  // labelled natural-person fallback (per review comment 1 — phone-side
  // users have no other way to add a persona).
  if (allEmpty) {
    const npDormant = !!identity.naturalPerson.publicKey && !isNaturalPersonActive(identity);
    const emptyKind = classifyEmptyState(
      consumerHint,
      !!identity.persona.publicKey,
      !!(identity.extraPersonas && identity.extraPersonas.length > 0),
      !!identity.naturalPerson.publicKey && !npDormant,
      npDormant,
    );
    const wantsPersona = !!consumerHint?.allow.includes('persona');
    const wantsExtra = !!consumerHint?.allow.includes('extra-persona');
    const canAddPersona = !!onAddPersona
      && canSwitchGuardianPersona
      && (emptyKind === 'no-persona-configured' || emptyKind === 'no-extra-persona');
    const npHidden = emptyKind === 'np-hidden';

    const emptyTitle = emptyKind === 'np-dormant'
      ? 'This site asked for your real identity'
      : wantsPersona
        ? "This site asked for a persona"
        : wantsExtra
          ? "This site asked for an extra persona"
          : "No matching identity";

    const emptyBody = emptyKind === 'np-dormant'
      ? "Your real identity isn't set up yet. It's a separate key that carries your legal name — you set it up once, and only use it when something like this asks for it."
      : wantsPersona
        ? "You don't have a persona configured yet — a persona is a separate, pseudonymous identity that doesn't expose your real name."
        : wantsExtra
          ? "You don't have an extra persona configured yet."
          : "None of your keypairs match what this site asked for.";

    const handleAddPersona = async () => {
      if (!onAddPersona) return;
      const name = newPersonaName.trim();
      if (!name) return;
      try {
        await onAddPersona(name);
        // The parent re-renders with the new persona on identity — the empty
        // state dissolves automatically because guardianOptions recomputes.
        setNewPersonaName('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not add persona — please try again');
      }
    };

    return (
      <div className="fade-in" role="main">
        <div className="section">
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            {description}
          </p>
        </div>

        <div
          className="card section"
          style={{
            background: 'var(--warning-light)',
            borderColor: 'var(--warning)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{emptyTitle}</div>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            {emptyBody}
          </p>
          {consumerHint?.reason && (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 8, marginBottom: 0, fontStyle: 'italic' }}>
              {consumerHint.reason}
            </p>
          )}
        </div>

        {emptyKind === 'np-dormant' && onActivateRealIdentity && (
          <div className="card section">
            <button className="btn btn-primary" onClick={onActivateRealIdentity}>
              Activate my real identity
            </button>
          </div>
        )}

        {canAddPersona && (
          <div className="card section">
            <div className="section-title">
              {wantsExtra ? 'Add an extra persona' : 'Add a persona'}
            </div>
            {!addingPersona ? (
              <button className="btn btn-primary" onClick={() => setAddingPersona(true)}>
                Add persona now
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  type="text"
                  placeholder="Display name"
                  value={newPersonaName}
                  onChange={e => setNewPersonaName(e.target.value.slice(0, 100))}
                  maxLength={100}
                  autoFocus
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    fontSize: '0.95rem',
                    background: 'var(--bg)',
                    color: 'var(--text-primary)',
                  }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" disabled={!newPersonaName.trim()} onClick={handleAddPersona} style={{ flex: 1 }}>
                    Save &amp; continue
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setAddingPersona(false); setNewPersonaName(''); }} style={{ flex: 1 }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Natural-person fallback — visible when an ACTIVATED NP exists.
            A dormant real identity is excluded here for the same reason it is
            excluded from the picker (spec §6): it has no name to show and the
            user has never chosen to use it. The np-dormant CTA above is the
            only route to it. Marked so the consumer can see the user overrode
            its hint (fromNP=true is set on the redirect-back in App.tsx). */}
        {!npHidden && !npDormant && identity.naturalPerson.publicKey && (
          <div className="card section">
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Or, sign in with your real-name identity instead. The site will see that you chose this.
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => setSelection({ source: 'guardian', keypairType: 'natural-person' })}
              style={{ width: '100%' }}
            >
              Sign in with my {identity.naturalPerson.displayName || 'Real identity'} instead
            </button>
          </div>
        )}

        {/* When user takes the NP fallback, the rest of the flow (confirm + approve)
            drops into the normal path below. */}
        {selection?.source === 'guardian' && selection.keypairType === 'natural-person' && (
          <NaturalPersonConfirmSection
            display={identity.naturalPerson.displayName || 'Real identity'}
            requireConfirm={requireNpConfirmation}
            confirmed={showNpConfirm}
            onConfirm={() => setShowNpConfirm(true)}
            onUndo={() => { setShowNpConfirm(false); setSelection(null); }}
          />
        )}

        {error && (
          <div className="card section" style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>
              {error}
            </p>
          </div>
        )}

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {approving && isPairedChild ? (
            <PairedChildApprovalWaiting onCancel={onDeny} />
          ) : (
            <>
              <button
                className="btn btn-primary"
                disabled={!selection || approving || selectionWaiting || (requireNpConfirmation && selection?.source === 'guardian' && selection.keypairType === 'natural-person' && !showNpConfirm)}
                onClick={async () => {
                  if (!selection || approving || selectionWaiting) return;
                  setApproving(true);
                  setError(null);
                  try {
                    await onApprove(selection, shareHandle);
                  } catch (e) {
                    setApproving(false);
                    setError(e instanceof Error ? e.message : (e == null ? 'Failed to approve — please try again' : 'Failed to approve: ' + String(e)));
                  }
                }}
              >
                {approving ? 'Signing…' : 'Approve'}
              </button>
              <button className="btn btn-ghost" onClick={onDeny} disabled={approving}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Normal path: at least one allowed option ──────────────────────────

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          {description}
        </p>
      </div>

      {login && ageRange && (
        <div className="card section" style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--warning)' }}>
            This request includes identity verification
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            In addition to logging you in, this website is requesting proof that you are {ageRange}. Both your public key and your age range will be shared.
          </p>
        </div>
      )}

      {/* Drift signal — sits above any caption when fired. */}
      {driftSignal && (
        <div className="card section" style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--warning)' }}>
            Heads up — this site changed its ask
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            {driftSignal.message}
          </p>
        </div>
      )}

      {/* Consumer-hint caption — shown above the picker when a hint is present. */}
      {guardianPolicy.caption && (
        <div className="section" style={{ marginTop: -8, marginBottom: 8 }}>
          <div
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              padding: '8px 12px',
              background: 'var(--bg-card-alt)',
              borderLeft: '3px solid var(--accent)',
              borderRadius: 4,
            }}
          >
            {guardianPolicy.caption}
          </div>
        </div>
      )}

      {/* Identity selector */}
      <div className="card section">
        <div className="section-title">Sign in as</div>

        {/* Guardian personas (filtered) */}
        {canSwitchGuardianPersona ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {guardianPolicy.ranked.map(({ key, token, label, pubkey }) => (
              <button
                key={key}
                className={`btn ${isGuardianSelected(key) ? 'btn-tile-selected' : 'btn-secondary'}`}
                onClick={() => setSelection({ source: 'guardian', keypairType: key })}
                style={{ padding: '10px 14px', textAlign: 'left', justifyContent: 'flex-start' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{label.slice(0, 100)}</span>
                    <KeypairBadge token={token} />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                    {shortNpub(pubkey)}
                  </div>
                  {isWaitingPubkey(pubkey) && (
                    <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.8 }}>
                      {WAITING_FOR_SIGNER_COPY}
                    </div>
                  )}
                </div>
              </button>
            ))}
            {missingChosenOption && (
              <button
                key={`missing-${missingChosenOption.key}`}
                className="btn btn-primary"
                disabled
                style={{ padding: '10px 14px', textAlign: 'left', justifyContent: 'flex-start' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{missingChosenOption.label.slice(0, 100)}</span>
                    <KeypairBadge token={missingChosenOption.token} />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.8 }}>
                    {missingChosenCopy}
                  </div>
                </div>
              </button>
            )}
          </div>
        ) : (
          /* Read-only guardian row — shown in bunker/nip07 mode.
             Only rendered when the guardian's active keypair passes the filter. */
          (() => {
            const current = guardianOptions.find(o => o.key === identity.primaryKeypair);
            const currentAllowed = current && guardianPolicy.ranked.some(o => o.key === current.key);
            if (!currentAllowed) return null;
            return (
              <button
                className={`btn ${selection?.source === 'guardian' ? 'btn-tile-selected' : 'btn-secondary'}`}
                onClick={hasAnyDependantOption ? () => setSelection({ source: 'guardian', keypairType: identity.primaryKeypair }) : undefined}
                style={{
                  padding: '10px 14px',
                  textAlign: 'left',
                  justifyContent: 'flex-start',
                  cursor: hasAnyDependantOption ? 'pointer' : 'default',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{current.label.slice(0, 100)}</span>
                    <KeypairBadge token={current.token} />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                    {shortNpub(current.pubkey)}
                  </div>
                </div>
              </button>
            );
          })()
        )}

        {/* Dependants section — each dependant's options are filter-scoped. */}
        {dependants && dependants.length > 0 && hasAnyDependantOption && (
          <>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '12px 0 6px',
              borderTop: '1px solid var(--border)',
              marginTop: 10,
            }}>
              Dependants
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {dependants.map((dep) => {
                const depAllowed = dependantOptionsById.get(dep.id) ?? [];
                if (depAllowed.length === 0) return null;
                const age = dep.dateOfBirth ? computeAge(dep.dateOfBirth) : null;
                return (
                  <div key={dep.id}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', padding: '6px 0 2px' }}>
                      {dep.displayName.slice(0, 100)}
                      {age !== null && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>age {age}</span>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {depAllowed.map(({ key, token, label, pubkey }) => {
                        const isActive = isDependantSelected(dep.id, key);
                        return (
                          <button
                            key={key}
                            className={`btn ${isActive ? 'btn-tile-selected' : 'btn-secondary'}`}
                            onClick={() => setSelection({ source: 'dependant', dependantId: dep.id, keypairType: key })}
                            style={{
                              padding: '8px 14px',
                              textAlign: 'left',
                              justifyContent: 'flex-start',
                              borderColor: isActive ? undefined : 'var(--guardian, var(--border))',
                            }}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 600 }}>{label.slice(0, 100)}</span>
                                <KeypairBadge token={token} />
                              </div>
                              <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                                {shortNpub(pubkey)}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* NP-ceiling confirmation — only when user has picked natural-person
          and the guardrail is active. Shown inline, not modal. */}
      {selection?.source === 'guardian'
        && selection.keypairType === 'natural-person'
        && tokenFor(selection.keypairType) === 'natural-person' && (
        <NaturalPersonConfirmSection
          display={identity.naturalPerson.displayName || 'Real identity'}
          requireConfirm={requireNpConfirmation}
          confirmed={showNpConfirm}
          onConfirm={() => setShowNpConfirm(true)}
          onUndo={() => { setShowNpConfirm(false); }}
        />
      )}

      <div className="card section">
        <div className="section-title">What will be shared</div>
        <SharePreview
          pubkey={resolveSelectedPubkey(selection, identity, dependants)}
          selectedDisplayName={resolveDisplayNameForPreview(selection, identity, dependants)}
          selectedToken={resolveSelectedToken(selection)}
          ageRange={ageRange}
          shareHandle={shareHandle}
          onShareHandleChange={setShareHandle}
        />
        {(() => {
          const pp = resolveSelectedPublicProfile(selection, identity, dependants);
          if (!pp?.enabled) return null;
          return (
            <div
              style={{
                fontSize: '0.82rem',
                color: 'var(--text-secondary)',
                padding: '8px 10px',
                background: 'var(--bg-card-alt)',
                borderLeft: '3px solid var(--accent)',
                borderRadius: 4,
                marginTop: 10,
              }}
              data-testid="approve-auth-public-profile-hint"
            >
              ℹ This site can look up your public Nostr profile
              {pp.displayName ? (<> (<strong>{pp.displayName.slice(0, 30)}</strong>)</>) : null}
              {' '}for this persona.
            </div>
          );
        })()}
      </div>

      {error && (
        <div className="card section" style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>
            {error}
          </p>
        </div>
      )}

      <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {approving && isPairedChild ? (
          <PairedChildApprovalWaiting onCancel={onDeny} />
        ) : (
          <>
            <button
              className="btn btn-primary"
              disabled={
                !selection
                || approving
                || selectionWaiting
                || (requireNpConfirmation
                    && selection?.source === 'guardian'
                    && selection.keypairType === 'natural-person'
                    && !showNpConfirm)
              }
              onClick={async () => {
                if (!selection || approving || selectionWaiting) return;
                setApproving(true);
                setError(null);
                try {
                  await onApprove(selection, shareHandle);
                } catch (e) {
                  setApproving(false);
                  setError(e instanceof Error ? e.message : (e == null ? 'Failed to approve — please try again' : 'Failed to approve: ' + String(e)));
                }
              }}
            >
              {approving ? 'Signing…' : 'Approve'}
            </button>
            <button className="btn btn-ghost" onClick={onDeny} disabled={approving}>
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Inline confirmation shown when the user has selected natural-person
 * and the NP-ceiling guardrail is active. Two-step so a single tap on
 * an NP row doesn't silently send the real-name identity.
 */
interface NpConfirmProps {
  display: string;
  requireConfirm: boolean;
  confirmed: boolean;
  onConfirm: () => void;
  onUndo: () => void;
}
function NaturalPersonConfirmSection({ display, requireConfirm, confirmed, onConfirm, onUndo }: NpConfirmProps) {
  if (!requireConfirm) return null;
  if (confirmed) {
    return (
      <div
        className="card section"
        style={{
          background: 'var(--success-light)',
          borderColor: 'var(--success)',
          fontSize: '0.85rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--success)' }}>
            Real-name sign-in confirmed.
          </span>
          <button className="btn btn-ghost" onClick={onUndo} style={{ fontSize: '0.8rem', padding: '4px 8px' }}>
            Undo
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="card section"
      style={{
        background: 'var(--warning-light)',
        borderColor: 'var(--warning)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        You're about to sign in with your real-name identity
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
        <strong>{display.slice(0, 100)}</strong> is your natural-person keypair. Most sites don't need it —
        a persona is usually enough.
      </p>
      <button className="btn btn-secondary" onClick={onConfirm} style={{ width: '100%' }}>
        Yes, use my real-name identity
      </button>
    </div>
  );
}
