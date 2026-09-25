import { useRef, useState, useEffect, useCallback } from 'react';
import type { CarouselRow } from '../types';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import type { IQBreakdownItem } from '../lib/badge-fetch';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';
import { computeAge } from '../lib/date-utils';
import { initialFromName, colourFromPubkey } from '../lib/avatar';
import { useResolvedAvatar } from '../hooks/useResolvedAvatar';
import { BrandMark } from './BrandMark';
import { Icon } from './Icon';

export interface IdentityCardProps {
  row: CarouselRow;
  resolved: ResolvedIdentity;
  badge: { tier: number; score: number; vouchCount: number; iqBreakdown?: IQBreakdownItem[] } | null;
  childMode: boolean;
  /**
   * On a paired-child install when the guardian has set
   * `autonomyStage: full-control`. Renders the dormant surface —
   * dependant card + soft indicator + "ask your guardian" copy.
   * See OQ1-139 of the
   * 2026-04-22 child-stage-awareness holodeck.
   */
  childDormant?: boolean;
  /**
   * Which signer actually covers this dormant paired-child device
   * (family-bunker §11.1.7). 'heartwood' when the family runs a Heartwood
   * signer that answered the capabilities probe, so the kid's sign-ins are
   * served by the device rather than parked on a guardian's phone.
   */
  childSignerKind?: 'guardian-phone' | 'heartwood';
  /**
   * Guardian's display name, surfaced in the dormant copy. Falls back
   * to "your guardian" when the status-sync payload didn't include it.
   */
  cachedGuardianName?: string;
  /** Pairing status for dependant rows. Undefined for non-dependants. */
  pairingStatus?: { paired: true } | { paired: false } | null;
  /** Optional resolved photo URL. When provided externally, overrides the
   *  internally-resolved per-persona avatar — used by tests / callers that
   *  want full control. When omitted, this component resolves the avatar
   *  itself from `resolved.avatarHash/Url/Key` via `useResolvedAvatar`. */
  photoUrl?: string | null;
  /** When set, renders a Pro pill alongside the tier badge. Tap navigates to Professional Dashboard. */
  proAnchorActive?: boolean;
  /** Called when the Pro pill is tapped. Navigates to `professional` page. */
  onProPillTap?: () => void;
  /**
   * Transient "Signed in as <persona>" caption shown after the user
   * approves a sign-in using one of this dep's personas/extras. The
   * parent ring only exposes the dep's NP card, so this chip is the
   * only place persona-level disambiguation surfaces post-approval.
   */
  recentSignInLabel?: string;
  /**
   * When true, the identity name and avatar render blurred with a
   * tap-to-reveal that auto-re-blurs after ~4 s. The role/type label
   * stays sharp at all times. When false/undefined, everything renders
   * normally. Driven by `shouldBlurIdentity(prefs)`.
   */
  blurIdentityNames?: boolean;
  /**
   * Called when an unnamed persona commits a name (blur or Enter). The parent
   * should persist it via `updateDisplayName(...)`. Only fires while the
   * inline editor is shown (`!resolved.displayNameIsSet`).
   * May be async.
   */
  onRenameActive?: (name: string) => void | Promise<void>;
}

export function IdentityCard({ row, resolved, badge, childMode, childDormant, childSignerKind, cachedGuardianName, pairingStatus, photoUrl, proAnchorActive, onProPillTap, recentSignInLabel, blurIdentityNames, onRenameActive }: IdentityCardProps) {
  const tier = badge?.tier ?? 1;
  const iq = badge?.score ?? 0;
  const vouches = badge?.vouchCount ?? 0;
  const verified = tier >= 2;
  const isDependant = row.type === 'dependant';
  const isChildCard = isDependant && !childMode;

  // Guardian name for the dormant notice — falls back to the generic form
  // when the guardian's status-publish carried no name (see `cachedGuardianName`).
  const guardianName = cachedGuardianName && cachedGuardianName.trim() ? cachedGuardianName : 'your guardian';

  // Resolve the per-persona avatar from the metadata on `resolved`. The
  // external `photoUrl` prop wins if set (test overrides, future custom
  // callers); otherwise we fetch + decrypt the persona's encrypted blob
  // from Blossom via `useResolvedAvatar`. Returns null while loading,
  // when no avatar is set, or on fetch failure — and the existing
  // initial+gradient fallback below picks up cleanly.
  const internalAvatarUrl = useResolvedAvatar({
    avatarHash: resolved.avatarHash,
    avatarBlossomUrl: resolved.avatarBlossomUrl,
    avatarKey: resolved.avatarKey,
  });
  const effectivePhotoUrl = photoUrl ?? internalAvatarUrl;

  // ── Blur / tap-to-reveal state ──────────────────────────────────────────
  // `revealed` is local to this card instance — resets naturally on
  // row change because the Carousel re-renders a fresh IdentityCard.
  const [revealed, setRevealed] = useState(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the auto-re-blur timer on unmount to avoid stale updates.
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);

  const handleRevealTap = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!blurIdentityNames) return;
    // Prevent the tap from bubbling to the Carousel's tap handler
    // (which would trigger child-mode entry on dependant rows).
    e.stopPropagation();
    if (revealed) return; // already revealed — ignore re-taps; let timer run
    setRevealed(true);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      setRevealed(false);
      revealTimerRef.current = null;
    }, 4000);
  }, [blurIdentityNames, revealed]);

  // When the blur setting is turned OFF mid-session, cancel any running timer.
  useEffect(() => {
    if (!blurIdentityNames) {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      setRevealed(false);
    }
  }, [blurIdentityNames]);

  const blurActive = blurIdentityNames && !revealed;
  // ────────────────────────────────────────────────────────────────────────

  // ── Inline name editor ──────────────────────────────────────
  // Any unnamed persona gets the inline "Add your name / handle" editor.
  const showNameEditor = !resolved.displayNameIsSet && !!onRenameActive;
  const [nameInput, setNameInput] = useState('');

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const commitName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (trimmed && onRenameActive) {
      await onRenameActive(trimmed);
    }
  }, [nameInput, onRenameActive]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { void commitName(); }
  }, [commitName]);
  // ──────────────────────────────────────────────────────────────────────────

  const age = isDependant && row.dependant.dateOfBirth
    ? computeAge(row.dependant.dateOfBirth)
    : null;

  let npubDisplay = '';
  if (isValidHexKey(resolved.publicKey)) {
    const npub = encodeNpub(hexToBytes(resolved.publicKey));
    npubDisplay = npub.slice(0, 12) + '...' + npub.slice(-6);
  }

  const initial = initialFromName(resolved.displayName);

  return (
    <div className="id-card">
      <div className={`card-band tier-${tier}-band`} />
      {recentSignInLabel && (
        <div className="signin-ack-chip" role="status" aria-live="polite">
          <span className="signin-ack-tick">&#10003;</span>
          Signed in as {recentSignInLabel}
        </div>
      )}
      <div className="card-inner">
        <div className="card-brand">
          <BrandMark variant="emblem" tone="on-dark" size={60} decorative />
          <BrandMark variant="wordmark" tone="on-dark" size={46} />
        </div>

        {/* \u2500\u2500 Blurred identity area (avatar + name) \u2500\u2500 */}
        {/* The role/type label sits outside this wrapper and stays sharp. */}
        <div
          onClick={blurActive ? handleRevealTap : undefined}
          onTouchEnd={blurActive ? handleRevealTap : undefined}
          style={blurActive ? {
            filter: 'blur(6px)',
            userSelect: 'none',
            cursor: 'pointer',
            WebkitUserSelect: 'none',
          } : undefined}
          aria-label={blurActive ? 'Tap to reveal identity' : undefined}
        >
          <div className="card-photo-wrap">
            <div
              className="card-photo"
              style={{
                background: effectivePhotoUrl ? '#0000' : colourFromPubkey(resolved.publicKey),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 600,
                fontSize: '1.3rem',
                overflow: 'hidden',
              }}
            >
              {effectivePhotoUrl ? (
                <img
                  src={effectivePhotoUrl}
                  alt={`${resolved.displayName ?? 'Identity'}'s image`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                initial
              )}
            </div>
          </div>

          <div className="card-name-block">
            {showNameEditor ? (
              // No name set yet — render an inline editable placeholder.
              // MiniIdBadge keeps receiving resolved.displayName (its fallback).
              <input
                ref={nameInputRef}
                className="card-name-input"
                type="text"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={() => { void commitName(); }}
                onKeyDown={handleNameKeyDown}
                placeholder="Add your name / handle"
                maxLength={100}
                aria-label="Add your name or handle"
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px dashed var(--border)',
                  color: 'var(--text-muted)',
                  fontSize: 'inherit',
                  fontFamily: 'inherit',
                  fontWeight: 'inherit',
                  width: '100%',
                  outline: 'none',
                  padding: '2px 0',
                  cursor: 'text',
                }}
              />
            ) : (
              <div className="card-name">{resolved.displayName}</div>
            )}
          </div>
        </div>

        {/* \u2500\u2500 Role/type label \u2014 the role word stays sharp; a dependant's age
            is identifying, so it blurs with the rest of the identity \u2500\u2500 */}
        <div className="card-type">
          {isDependant
            ? (
              <>
                Dependant
                {age ? (
                  <>
                    {' \u00B7 '}
                    <span style={blurActive ? { filter: 'blur(5px)', userSelect: 'none' } : undefined}>
                      Age {age}
                    </span>
                  </>
                ) : null}
              </>
            )
            : resolved.type}
        </div>

        <div className="card-tier-row">
          <div className={`carousel-tier-badge carousel-tier-${tier}`}>
            Tier {tier}
          </div>
          {proAnchorActive && (
            <button
              onClick={e => {
                e.stopPropagation();
                onProPillTap?.();
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 10px',
                borderRadius: 10,
                background: 'var(--accent)',
                color: 'var(--on-accent)',
                fontSize: '0.75rem',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                letterSpacing: '0.03em',
              }}
              aria-label="Pro — tap to open Professional Dashboard"
            >
              Pro
            </button>
          )}
          <div className="status-chip">
            <span className={`status-dot${verified ? ' verified' : ''}`} />
            {verified ? 'Verified' : 'Unverified'}
          </div>
        </div>

        {pairingStatus && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              marginTop: 6,
            }}
          >
            <Icon name="smartphone" size={12} className="icon-inline" />
            {pairingStatus.paired
              ? 'Paired'
              : 'No phone paired — swipe › to settings'}
          </div>
        )}

        <div className="card-stats">
          <div className="card-stat">
            <div className="card-stat-value">{iq}</div>
            <div className="card-stat-label">Signet IQ</div>
          </div>
          <div className="card-stat">
            <div className="card-stat-value">{tier}</div>
            <div className="card-stat-label">Tier</div>
          </div>
          <div className="card-stat">
            <div className="card-stat-value">{vouches}</div>
            <div className="card-stat-label">Vouches</div>
          </div>
        </div>

        {npubDisplay && (
          <div className="card-npub">{npubDisplay}</div>
        )}

        {childDormant && (
          <div
            className="card-dormant-notice"
            style={{
              marginTop: 16,
              padding: '12px 14px',
              borderRadius: 'var(--radius)',
              background: 'var(--bg-card-alt)',
              border: '1px solid var(--border)',
              fontSize: '0.85rem',
              lineHeight: 1.4,
              textAlign: 'center',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {childSignerKind === 'heartwood' ? 'Your family Heartwood signs for you.' : 'This device is dormant.'}
            </div>
            <div style={{ opacity: 0.8 }}>
              {childSignerKind === 'heartwood' ? (
                <>
                  Sign-ins from this device go to your family&rsquo;s Heartwood signer. Some may still need{' '}
                  <strong>{guardianName}</strong> to say yes.
                </>
              ) : (
                <>
                  You're signed in as you, but this device can't sign anything yet. Ask{' '}
                  <strong>{guardianName}</strong> to sign for you on their phone.
                </>
              )}
            </div>
          </div>
        )}

        <div className="card-footer">
          <div className={isChildCard ? 'card-hint-child' : 'card-hint'}>
            {isChildCard
              ? (
                <>
                  Tap to enter{' '}
                  <span style={blurActive ? { filter: 'blur(6px)', userSelect: 'none' } : undefined}>
                    {resolved.displayName}
                  </span>
                  's account
                </>
              )
              : childDormant
                ? 'Ask your guardian'
                : '\u2190 QR \u00B7 Camera \u2192'}
          </div>
        </div>
      </div>
    </div>
  );
}
