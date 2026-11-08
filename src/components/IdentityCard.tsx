import { HandshakeButton } from './HandshakeButton';
import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { CarouselRow } from '../types';
import type { KnownPlace } from '../types/known-places';
import type { Badge } from '../lib/known-place-badges';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';
import { computeAge } from '../lib/date-utils';
import { initialFromName, colourFromPubkey } from '../lib/avatar';
import { useResolvedAvatar } from '../hooks/useResolvedAvatar';
import { BACKDROP_PRIVACY_COPY, useCardBackdrop } from '../hooks/useCardBackdrop';
import { safeImageOrLinkUrl } from '../lib/public-profile-publish';
import { BrandMark } from './BrandMark';
import { KnownPlacesStrip } from './KnownPlacesStrip';
import { Icon } from './Icon';
import { useCarouselArrows } from './CarouselArrowContext';
import { armPickerGrace } from '../lib/picker-grace';

/**
 * One place this identity is known (a signed-in site, a paired app), with the
 * badge and icon its chip shows. Carousel routes these through its
 * `knownPlacesFor` / `onOpenPlace` props.
 */
export interface KnownPlaceItem {
  place: KnownPlace;
  badge: Badge | null;
  /** A data-URL app icon, or null for the letter tile. */
  iconUrl?: string | null;
}

export interface IdentityCardProps {
  onHandshake?: (choose: boolean) => void;
  row: CarouselRow;
  resolved: ResolvedIdentity;
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
  /** When set, renders a Pro pill under the identity type. Tap navigates to Professional Dashboard. */
  proAnchorActive?: boolean;
  /** Called when the Pro pill is tapped. Navigates to `professional` page. */
  onProPillTap?: () => void;
  /** Places this identity is known. An array (even empty) shows the strip, with a quiet
   *  "Not known anywhere yet" line when empty; undefined hides it. */
  knownPlaceItems?: KnownPlaceItem[];
  /** The app is locked: show one unlock chip instead of the (hidden) place chips. */
  placesLocked?: boolean;
  onUnlockRequest?: () => void;
  /** A chip was tapped: the id of the place to open in the known-places column. The card
   *  then jumps to that column itself; the "+N" chip jumps with no id. */
  onOpenPlace?: (placeId: string) => void;
  /** Active contacts on this identity's private list. null/undefined hides the pill
   *  (dependant rows, locked directory, still loading). */
  contactsCount?: number | null;
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
   * This card's own position in the ring. The arrow context only knows the
   * row the carousel has settled on, so during a vertical slide the incoming
   * card would show the outgoing card's position until the slide ended.
   */
  rowIndex?: number;
  /**
   * Called when an unnamed persona commits a name (blur or Enter). The parent
   * should persist it via `updateDisplayName(...)`. Only fires while the
   * inline editor is shown (`!resolved.displayNameIsSet`).
   * May be async.
   */
  onRenameActive?: (name: string) => void | Promise<void>;
}

const BACKDROP_NOTE_MS = 4000;

export function IdentityCard({ onHandshake, row, resolved, childMode, childDormant, childSignerKind, cachedGuardianName, pairingStatus, photoUrl, proAnchorActive, onProPillTap, knownPlaceItems, placesLocked, onUnlockRequest, onOpenPlace, contactsCount, recentSignInLabel, blurIdentityNames, rowIndex, onRenameActive }: IdentityCardProps) {
  const isDependant = row.type === 'dependant';
  const isChildCard = isDependant && !childMode;
  const arrows = useCarouselArrows();

  // ── Card backdrop — this identity's wallpaper (device-local) ──
  const backdrop = useCardBackdrop(resolved.publicKey || undefined);
  const backdropInputRef = useRef<HTMLInputElement | null>(null);
  const backdropEditRef = useRef<HTMLDivElement | null>(null);
  const [backdropMenuOpen, setBackdropMenuOpen] = useState(false);
  const [backdropNote, setBackdropNote] = useState<string | null>(null);
  const backdropNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canEditBackdrop = !isDependant && !childDormant;
  // The system picker hides the page; without the grace that hide locks the
  // app and unmounts this input before the pick lands.
  const openBackdropPicker = () => { armPickerGrace(); backdropInputRef.current?.click(); };

  // Any press outside the control closes its menu — including on the tab
  // bar, which a scrim inside the (transformed) card could never cover.
  useEffect(() => {
    if (!backdropMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (backdropEditRef.current && e.target instanceof Node && backdropEditRef.current.contains(e.target)) return;
      setBackdropMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [backdropMenuOpen]);

  const showBackdropNote = useCallback((note: string) => {
    setBackdropNote(note);
    if (backdropNoteTimer.current) clearTimeout(backdropNoteTimer.current);
    backdropNoteTimer.current = setTimeout(() => { setBackdropNote(null); backdropNoteTimer.current = null; }, BACKDROP_NOTE_MS);
  }, []);
  useEffect(() => () => { if (backdropNoteTimer.current) clearTimeout(backdropNoteTimer.current); }, []);

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

  // Public kind-0 picture (e.g. adopted by "Match it in Signet") — the last
  // resort when the slot has no decrypted in-app avatar. Untrusted URL: only
  // https (or loopback http) survives `safeImageOrLinkUrl`. A load failure is
  // remembered per-URL, so a changed URL gets a fresh attempt. A slot with an
  // in-app avatar never falls back to it: useResolvedAvatar reads null while
  // loading, and the public picture would flash in before the avatar.
  const publicPictureHref = resolved.pictureUrl && !resolved.avatarHash
    ? safeImageOrLinkUrl(resolved.pictureUrl)?.href ?? null
    : null;
  const [failedPictureHref, setFailedPictureHref] = useState<string | null>(null);
  const publicPictureUrl =
    publicPictureHref && publicPictureHref !== failedPictureHref ? publicPictureHref : null;
  const effectivePhotoUrl = photoUrl ?? internalAvatarUrl ?? publicPictureUrl;
  const showingPublicPicture = !photoUrl && !internalAvatarUrl && !!publicPictureUrl;

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

  // The strip takes plain lookups; the badge and icon ride beside each place.
  const { stripPlaces, stripBadges, stripIcons } = useMemo(() => {
    const sites = knownPlaceItems ?? [];
    return {
      stripPlaces: sites.map(s => s.place),
      stripBadges: new Map(sites.map(s => [s.place.id, s.badge] as const)),
      stripIcons: new Map(sites.map(s => [s.place.id, s.iconUrl ?? null] as const)),
    };
  }, [knownPlaceItems]);
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
  const ownerCard = !isChildCard && !childDormant;
  // The role label doubles as the way into the identity switcher once the
  // ring has more than one row; on its own it stays a plain label.
  const canSwitch = !!arrows && arrows.rowCount > 1;
  const typeLabel = isDependant
    ? (
      <>
        Dependant
        {age ? (
          <>
            {' · '}
            <span style={blurActive ? { filter: 'blur(5px)', userSelect: 'none' } : undefined}>
              Age {age}
            </span>
          </>
        ) : null}
      </>
    )
    : resolved.type;

  return (
    <div className="id-card">
      {/* The backdrop itself is painted by CardStage behind every card of
          this identity; this card only hosts the customise control. */}
      <div className="card-band" />
      <div className="card-motto">
        <span>MY IDENTITY</span>
        <span> – </span>
        <span>MY SOVEREIGNTY</span>
        <span> – </span>
        <span>MY COMMUNITY</span>
      </div>
      {canEditBackdrop && (
        <div className="card-backdrop-edit" ref={backdropEditRef}>
          <input
            ref={backdropInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              setBackdropMenuOpen(false);
              if (!file) return;
              void backdrop.set(file).then(result => { showBackdropNote(result.ok ? BACKDROP_PRIVACY_COPY : result.reason); });
            }}
          />
          <button
            type="button"
            className="card-backdrop-btn"
            aria-label="Customise card backdrop"
            aria-expanded={backdrop.url ? backdropMenuOpen : undefined}
            onClick={e => {
              e.stopPropagation();
              if (backdrop.url) setBackdropMenuOpen(open => !open);
              else openBackdropPicker();
            }}
          >
            <Icon name="image" size={16} />
          </button>
          {backdropMenuOpen && backdrop.url && (
            <div className="card-backdrop-menu" role="menu" onClick={e => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => { setBackdropMenuOpen(false); openBackdropPicker(); }}>
                Change image
              </button>
              <button type="button" role="menuitem" onClick={() => { setBackdropMenuOpen(false); void backdrop.clear(); }}>
                Remove
              </button>
            </div>
          )}
        </div>
      )}
      {backdropNote && (
        <div className="card-backdrop-note" role="status">{backdropNote}</div>
      )}
      {recentSignInLabel && (
        <div className="signin-ack-chip" role="status" aria-live="polite">
          <span className="signin-ack-tick">&#10003;</span>
          Signed in as{' '}
          <span style={blurActive ? { filter: 'blur(6px)', userSelect: 'none' } : undefined}>{recentSignInLabel}</span>
        </div>
      )}
      <div className="card-inner">
        <div className="card-brand">
          <BrandMark variant="emblem" tone="on-dark" size={60} decorative />
          <BrandMark variant="wordmark" tone="on-dark" size={38} />
        </div>

        {/* Avatar, name, role label, Pro pill and npub read as one group — and
            share one readability plate when a backdrop is set. */}
        <div className="card-identity">
          {/* ── Blurred identity area (avatar + name) ── */}
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
                    {...(showingPublicPicture ? {
                      referrerPolicy: 'no-referrer' as const,
                      onError: () => setFailedPictureHref(publicPictureUrl),
                    } : {})}
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

          {/* ── Role/type label — the role word stays sharp; a dependant's age
              is identifying, so it blurs with the rest of the identity ── */}
          {canSwitch ? (
            <button
              type="button"
              className="card-type card-type-switch"
              aria-label={`${isDependant ? 'Dependant' : resolved.type}, identity ${(rowIndex ?? arrows!.rowIndex) + 1} of ${arrows!.rowCount}. Switch identity`}
              onClick={e => { e.stopPropagation(); arrows!.openSwitcher(); }}
            >
              {typeLabel}
              <span className="card-type-count" aria-hidden="true">{(rowIndex ?? arrows!.rowIndex) + 1}/{arrows!.rowCount}</span>
              <span className="card-type-chevron" aria-hidden="true">&#8964;</span>
            </button>
          ) : (
            <div className="card-type">{typeLabel}</div>
          )}

          {proAnchorActive && (
            <div className="card-tier-row">
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
            </div>
          )}

          {npubDisplay && (
            <div className="card-npub">{npubDisplay}</div>
          )}
        </div>

        {/* ── Quick-open: this identity's sign-ins and contacts.
            Dependant rows keep their pairing/dormant surfaces instead. ── */}
        {!isDependant && ownerCard && (placesLocked || knownPlaceItems || typeof contactsCount === 'number') && (
          <div className="card-quick">
            {(placesLocked || knownPlaceItems) && (
              <KnownPlacesStrip
                places={stripPlaces}
                badges={p => stripBadges.get(p.id) ?? null}
                iconFor={p => stripIcons.get(p.id) ?? null}
                locked={!!placesLocked}
                onUnlock={() => onUnlockRequest?.()}
                onOpenPlace={id => { if (id) onOpenPlace?.(id); arrows?.jump(3); }}
                blur={blurActive}
              />
            )}
            {typeof contactsCount === 'number' && (
              <button
                type="button"
                className="card-contacts-pill"
                onClick={e => { e.stopPropagation(); arrows?.jump(2); }}
                aria-label="Open this identity's contacts"
              >
                <Icon name="users" size={16} className="icon-inline" />
                {contactsCount === 0
                  ? 'Add your first contact'
                  : `${contactsCount} ${contactsCount === 1 ? 'contact' : 'contacts'}`}
                <span className="card-pill-chevron" aria-hidden="true">&rsaquo;</span>
              </button>
            )}
          </div>
        )}

        {pairingStatus && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              textAlign: 'center',
            }}
          >
            <Icon name="smartphone" size={12} className="icon-inline" />
            {pairingStatus.paired
              ? 'Paired'
              : 'No phone paired — swipe › to settings'}
          </div>
        )}

        {childDormant && (
          <div
            className="card-dormant-notice"
            style={{
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

        {(onHandshake || ownerCard) && (
          <div className="card-actions">
            {ownerCard && (
              <button
                type="button"
                className="btn btn-primary card-action-tile card-scan-btn"
                aria-label="Scan a QR code"
                onClick={e => { e.stopPropagation(); arrows?.jump(5); }}
              >
                <Icon name="qrScan" size={24} />
                Scan
              </button>
            )}
            {onHandshake && <HandshakeButton onStart={onHandshake} />}
            {ownerCard && (
              <button
                type="button"
                className="btn btn-secondary card-action-tile"
                aria-label="Show my QR code"
                onClick={e => { e.stopPropagation(); arrows?.jump(1); }}
              >
                <Icon name="qr" size={24} />
                My QR
              </button>
            )}
          </div>
        )}

        {(isChildCard || childDormant) && (
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
                : 'Ask your guardian'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
