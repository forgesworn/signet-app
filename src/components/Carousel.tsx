import { CAROUSEL_COLUMNS } from '../types';
import { useRef, useCallback, useState, useEffect, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import type { DependantIdentity, CarouselColumn, CarouselRow, PublicProfileConfig } from '../types';
import { wrapIndex, clampIndex, resolveActiveIdentity, resolveRenameTarget } from '../lib/carousel-utils';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { shouldShowPairingStatus } from '../lib/carousel-routing';
import { NavDots } from './NavDots';
import { IdentityCard } from './IdentityCard';
import type { IdentityCardProps } from './IdentityCard';
import { QRCard } from './QRCard';
import { SettingsCard } from './SettingsCard';
import { CameraCard } from './CameraCard';
import { AddCard } from './AddCard';
import { useRegisterCarouselArrows } from './CarouselArrowContext';
import { computeArrowState } from '../lib/carousel-arrows';
import type { IQBreakdownItem } from '../lib/badge-fetch';

interface CarouselProps {
  renderBotCard?: (row: Extract<CarouselRow, { type: 'bot' }>, col: CarouselColumn) => ReactNode;
  renderInviteCard?: (row: CarouselRow, resolved: ResolvedIdentity, publicCard: ReactNode) => ReactNode;
  renderContactsCard?: (row: CarouselRow, resolved: ResolvedIdentity) => ReactNode;
  row: number;
  col: CarouselColumn;
  rows: CarouselRow[];
  activeIdentity: ResolvedIdentity;
  animating: boolean;
  onCommit: (row: number, col: CarouselColumn) => void;
  onAnimatingChange: (v: boolean) => void;
  swipeLocked?: boolean;
  badge: { tier: number; score: number; vouchCount: number; iqBreakdown?: IQBreakdownItem[] } | null;
  onNavigateDeepPage: (page: string, opts?: {
    focusPersona?: string;
    dependantId?: string;
    slotTarget?: 'natural-person' | 'persona' | 'professional-persona' | string;
  }) => void;
  onEnableContactAvatarShare?: (target: string, depPubkey?: string) => Promise<string | null>;
  /** Stop sharing the contact avatar for a slot (G1 coarse revocation). */
  onStopContactAvatarShare?: (target: string, depPubkey?: string) => Promise<void>;
  onQRScanned: (data: string) => void;
  onEnterChildMode: (dependantId: string) => void;
  onExitChildMode: () => void;
  childMode: boolean;
  childDependant: DependantIdentity | null;
  /**
   * Add a persona. Caller does the freshAuth + IDB write. Throws on
   * failure so AddCard can surface the error inline.
   */
  onAddPersona: (displayName: string) => Promise<void>;
  /** Navigate to the Add Dependant page (guardian only). Omit to hide the affordance (e.g. the paired-child surface). */
  onAddDependant?: () => void;
  /**
   * When true on a paired-child install, the carousel renders the
   * dormant surface — no sign
   * affordances, no persona-add. Ignored on the guardian surface.
   */
  childDormant?: boolean;
  /**
   * Which signer covers a dormant paired-child device — passed straight
   * through to IdentityCard's dormant notice (family-bunker §11.1.7).
   */
  childSignerKind?: IdentityCardProps['childSignerKind'];
  /**
   * Guardian display name the guardian's status-publish included, so
   * the dormant copy reads "Ask [Mum]..." rather than the generic
   * "your guardian". Optional — falls back to the generic form.
   */
  cachedGuardianName?: string;
  children?: ReactNode;
  /** Map from dependant id to DependantIdentity, used to compute pairing status. */
  dependantById?: Record<string, DependantIdentity>;
  /** When true, renders the Pro pill on the owner IdentityCard. */
  proAnchorActive?: boolean;
  /** Called when the Pro pill is tapped — navigates to Professional Dashboard. */
  onProPillTap?: () => void;
  /**
   * Transient confirmation rendered on a dependant's card after the user
   * signs in as one of that dep's personas/extras (set in App.tsx, cleared
   * after a short TTL). Only the row whose id matches `dependantId` shows
   * the chip; other rows ignore it. Undefined when no recent sign-in or
   * when the active card already conveys the keypair on its own.
   */
  recentSignInAck?: { dependantId: string; label: string } | null;
  signingMode?: 'local' | 'bunker' | 'nip07' | 'paired-child';
  /** Number of dependants — surfaces a Family section on the owner NP col-2. */
  dependantsCount?: number;
  /**
   * True when the host install is a paired-child surface
   * (`signingMode === 'paired-child'`). Passed through to col-2's
   * SettingsCard so the gear-fab is suppressed on dep rows — per
   * Appendix B the kid has no consequential actions on their persona
   * card and the §6.6.11 read-only framing is the entire surface.
   */
  isPairedChild?: boolean;

  // ─── Inline SlotProfileFields plumbing — forwarded to SettingsCard. ───
  /** Default Blossom server URL — forwarded to SlotProfileFields. */
  defaultBlossomUrl?: string;
  /** Blossom upload consent flag — forwarded to SlotProfileFields. */
  blossomConsent?: boolean;
  onSavePersonaConfig?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    config: PublicProfileConfig,
  ) => Promise<void>;
  onRepublishProfile?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
  ) => Promise<void>;
  onUploadPersonaPicture?: (
    file: File,
    kind: 'picture' | 'banner',
  ) => Promise<{ url: string; sha256: string }>;
  onUpdateOwnPersonaName?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    name: string,
  ) => Promise<void>;
  /** Save a new encrypted in-app avatar for a user-side slot. */
  onSetPersonaAvatar?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    file: File,
  ) => Promise<void>;
  /** Clear the avatar for a user-side slot. */
  onClearPersonaAvatar?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
  ) => Promise<void>;
  /** Persist a NIP-05 check result for a user-side slot (device-local, never synced). */
  onNip05Checked?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    result: import('../lib/nip05-check').Nip05CheckResult,
    checkedAt: number,
  ) => Promise<void>;
  onSaveDepPersonaConfig?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    config: PublicProfileConfig,
  ) => Promise<void>;
  onRepublishDepProfile?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => Promise<void>;
  onUploadDepPersonaPicture?: (
    depPubkey: string,
    file: File,
    kind: 'picture' | 'banner',
  ) => Promise<{ url: string; sha256: string }>;
  onUpdateDepName?: (depPubkey: string, name: string) => Promise<void>;
  onUpdateDepPersonaName?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    name: string,
  ) => Promise<void>;
  /** Save a new encrypted in-app avatar for a dep slot. */
  onSetDepPersonaAvatar?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    file: File,
  ) => Promise<void>;
  /** Clear the avatar for a dep slot. */
  onClearDepPersonaAvatar?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => Promise<void>;
  /** Persist a NIP-05 check result for a dep slot (device-local, never synced). */
  onDepNip05Checked?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    result: import('../lib/nip05-check').Nip05CheckResult,
    checkedAt: number,
  ) => Promise<void>;
  /**
   * When true, identity names and avatars on col-0 IdentityCards are
   * blurred with tap-to-reveal. Forwarded from App.tsx's `blurIdentityNames`
   * (derived from `shouldBlurIdentity(prefs)`). Default: undefined = no blur.
   */
  blurIdentityNames?: boolean;
  /**
   * Called when an unnamed persona commits a name from the inline editor on
   * the owner IdentityCard. Wired in App.tsx to `updateDisplayName(...)`.
   *
   * `target` is the slot of the ROW that was edited (`resolveRenameTarget`),
   * never the identity's primary keypair — the two differ on every
   * persona-primary install, where renaming from the real-identity row used to
   * rename the persona instead. Rows the owner handler must not write to
   * (dependants, `add`) never get the editor at all.
   * May be async.
   */
  onRenameActive?: (target: string, name: string) => void | Promise<void>;
}

/**
 * Returns a stable, identity-specific string for use as a React `key` on
 * the settled (current-screen) IdentityCard. Keying on this value causes
 * React to remount the card — resetting its local `revealed` state — whenever
 * the displayed identity changes, fixing the shoulder-surf leak where a
 * revealed card's blur persisted after a vertical row swipe.
 *
 * Encoding:
 *   - natural-person / persona rows:    "<type>:<identity.publicKey>"
 *   - extra-persona:                    "extra-persona:<personaIndex>:<publicKey>"
 *   - dependant / dependant-persona:    "<type>:<dependant.id>"
 *   - dependant-extra-persona:          "dependant-extra-persona:<personaIndex>:<dependant.id>"
 *   - add:                              type literal (single stable card)
 *
 * We include the row *type* in the key so that NP and Persona rows of the
 * SAME identity (same publicKey) each get their own IdentityCard instance —
 * they are visually distinct cards on adjacent rows.
 */
function identityCardKey(row: CarouselRow): string {
  switch (row.type) {
    case 'bot': return `bot:${row.bot.publicKey}`;
    case 'natural-person':
    case 'persona':
      return `${row.type}:${row.identity.naturalPerson.publicKey}`;
    case 'extra-persona':
      return `extra-persona:${row.identity.extraPersonas![row.personaIndex].publicKey}`;
    case 'dependant':
    case 'dependant-persona':
      return `${row.type}:${row.dependant.id}`;
    case 'dependant-extra-persona':
      return `dependant-extra-persona:${row.dependant.extraPersonas![row.personaIndex].publicKey}`;
    case 'add':
      // Single stable card per type, no identity payload.
      return row.type;
  }
  // Exhaustiveness guard: a future CarouselRow variant must add an explicit
  // key here (else it would silently share one card instance and leak state).
  const _exhaustive: never = row;
  return (_exhaustive as CarouselRow).type;
}

function renderCard(
  row: CarouselRow,
  col: CarouselColumn,
  resolved: ResolvedIdentity,
  props: CarouselProps,
): ReactNode {
  // Persistent "+ Add" prompt at the bottom of the ring. Non-columnar —
  // all columns render the same card. Variants:
  //  - 'guardian' = top-level surface; both Add persona + Add someone-you-look-after.
  //  - 'child'    = guardian acting-as a dependant (carousel child-mode); persona-only.
  //  - 'paired-child' = the kid's OWN device. Informational only; the kid
  //                     can't create personas — those are derived guardian-side
  //                     and arrive via the persona-inventory sync. We render
  //                     this even when childDormant so the kid still sees an
  //                     explanation instead of a blank screen.
  if (row.type === 'bot') return props.renderBotCard?.(row, col) ?? null;
  if (row.type === 'add') {
    if (props.signingMode === 'paired-child') {
      return <AddCard context="paired-child" onAddPersona={props.onAddPersona} guardianName={props.cachedGuardianName} />;
    }
    if (props.childDormant) return null;
    return (
      <AddCard
        context={props.childMode ? 'child' : 'guardian'}
        onAddPersona={props.onAddPersona}
        onAddDependant={props.childMode ? undefined : props.onAddDependant}
      />
    );
  }
  // Null for dependant rows and `add` — those must never reach the owner
  // identity's rename handler, so the inline editor is not offered there.
  const renameTarget = resolveRenameTarget(row);

  switch (col) {
    case 0: {
      const pairingStatus = shouldShowPairingStatus(row.type, props.childMode, props.signingMode) && row.type === 'dependant'
        ? (props.dependantById?.[row.dependant.id]?.bunkerEndpoint?.authorizedClientPubkey
            ? { paired: true as const }
            : { paired: false as const })
        : null;
      const recentSignInLabel = (row.type === 'dependant' && props.recentSignInAck?.dependantId === row.dependant.id)
        ? props.recentSignInAck.label
        : undefined;
      return (
        <IdentityCard
          key={identityCardKey(row)}
          row={row}
          resolved={resolved}
          badge={props.badge}
          childMode={props.childMode}
          childDormant={props.childDormant}
          childSignerKind={props.childSignerKind}
          cachedGuardianName={props.cachedGuardianName}
          pairingStatus={pairingStatus}
          // TODO: resolve photoHash → URL via local cache or Blossom server. Tracked as follow-up.
          photoUrl={null}
          proAnchorActive={row.type === 'natural-person' ? props.proAnchorActive : false}
          onProPillTap={row.type === 'natural-person' ? props.onProPillTap : undefined}
          recentSignInLabel={recentSignInLabel}
          blurIdentityNames={props.blurIdentityNames}
          onRenameActive={renameTarget && props.onRenameActive
            ? (name: string) => props.onRenameActive!(renameTarget, name)
            : undefined}
        />
      );
    }
    case 1: {
      const publicCard = (
        <QRCard
          // Per-row remount (same pattern as IdentityCard at case 0): the
          // carousel reuses this positional instance across vertical swipes, so
          // without a row-keyed remount QRCard's local state (contactKey,
          // customFields) would carry one persona's contact-share key onto the
          // next persona's QR. Keying on the row forces a fresh slot each swipe.
          key={identityCardKey(row)}
          resolved={resolved}
          badge={props.badge}
          onNavigateDeepPage={props.onNavigateDeepPage}
          onEnableContactAvatarShare={props.onEnableContactAvatarShare}
          onStopContactAvatarShare={props.onStopContactAvatarShare}
        />
      );
      return props.renderInviteCard?.(row, resolved, publicCard) ?? publicCard;
    }
    case 2:
      return props.renderContactsCard?.(row, resolved) ?? null;
    case 3:
      return (
        <SettingsCard
          resolved={resolved}
          row={row}
          childMode={props.childMode}
          isPairedChild={props.isPairedChild ?? false}
          onNavigateDeepPage={props.onNavigateDeepPage}
          dependantsCount={props.dependantsCount ?? 0}
          defaultBlossomUrl={props.defaultBlossomUrl}
          blossomConsent={props.blossomConsent}
          onSavePersonaConfig={props.onSavePersonaConfig}
          onRepublishProfile={props.onRepublishProfile}
          onUploadPersonaPicture={props.onUploadPersonaPicture}
          onUpdateOwnPersonaName={props.onUpdateOwnPersonaName}
          onSetPersonaAvatar={props.onSetPersonaAvatar}
          onClearPersonaAvatar={props.onClearPersonaAvatar}
          onNip05Checked={props.onNip05Checked}
          onSaveDepPersonaConfig={props.onSaveDepPersonaConfig}
          onRepublishDepProfile={props.onRepublishDepProfile}
          onUploadDepPersonaPicture={props.onUploadDepPersonaPicture}
          onUpdateDepName={props.onUpdateDepName}
          onUpdateDepPersonaName={props.onUpdateDepPersonaName}
          onSetDepPersonaAvatar={props.onSetDepPersonaAvatar}
          onClearDepPersonaAvatar={props.onClearDepPersonaAvatar}
          onDepNip05Checked={props.onDepNip05Checked}
        />
      );
    case 4:
      return (
        <CameraCard
          resolved={resolved}
          onQRScanned={props.onQRScanned}
        />
      );
  }
}

/**
 * The neighbour screen mounted alongside the current one.
 *
 * `baseX`/`baseY` are the FULLY-OFFSCREEN resting offsets for the incoming
 * screen (one viewport width/height on the side the card is arriving from).
 * Its live transform is always `base + dragOffset`, so at rest during a drag
 * of `dx` it sits at `baseX + dx` — i.e. it follows the finger.
 */
interface IncomingCard {
  row: number;
  col: CarouselColumn;
  baseX: number;
  baseY: number;
}

export function Carousel(props: CarouselProps) {
  const { row, col, rows, animating, onCommit, onAnimatingChange, swipeLocked } = props;

  const viewportRef = useRef<HTMLDivElement>(null);
  const currentScreenRef = useRef<HTMLDivElement>(null);
  const incomingScreenRef = useRef<HTMLDivElement>(null);
  const swipeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapBackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [incomingCard, setIncomingCard] = useState<IncomingCard | null>(null);

  /**
   * Synchronous mirror of `incomingCard`. The gesture handlers run between
   * React renders (many per second during a drag), so they can't read the
   * state variable to decide whether the neighbour they need is already
   * mounted — they read this instead.
   */
  const incomingRef = useRef<IncomingCard | null>(null);

  /**
   * Live drag offset applied on top of the incoming screen's base offset.
   * Read at render time so a re-render mid-drag/mid-animation re-computes the
   * SAME transform the imperative handlers last wrote (rather than snapping
   * the screen back to its mount-time position).
   */
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const setIncoming = useCallback((next: IncomingCard | null) => {
    incomingRef.current = next;
    setIncomingCard(next);
  }, []);

  const clearSnapBackTimeout = useCallback(() => {
    if (snapBackTimeoutRef.current) {
      clearTimeout(snapBackTimeoutRef.current);
      snapBackTimeoutRef.current = null;
    }
  }, []);

  /**
   * Which row/col a swipe in `direction` on `axis` would land on, or null when
   * the move is illegal (vertical edge / single row) and the card should just
   * snap back. Shared by the drag pre-mount and the release commit so the
   * neighbour that was pre-rasterised is exactly the one that gets committed.
   */
  const resolveTarget = useCallback((
    axis: 'h' | 'v',
    direction: -1 | 1,
  ): { row: number; col: CarouselColumn } | null => {
    if (axis === 'h') {
      // Horizontal wraps — five columns form a loop. Every row is now an identity
      // (or the add) row, so there are no non-columnar rows to guard against.
      return { row, col: wrapIndex(col + (direction === -1 ? 1 : -1), CAROUSEL_COLUMNS.length) as CarouselColumn };
    }
    // Vertical is linear — hard stop at top (natural-person) and bottom
    // (last dependant / persona). Snap back when the user swipes past an edge.
    if (rows.length <= 1) return null;
    const requested = row + (direction === -1 ? 1 : -1);
    const newRow = clampIndex(requested, rows.length);
    if (newRow === row) return null;
    return { row: newRow, col };
  }, [row, col, rows.length]);

  // Reset the current screen's inline transform after each commit so the newly
  // rendered card starts centred. Without this, the outgoing transform persists
  // on the stable DOM node and the viewport blanks on the next swipe.
  useLayoutEffect(() => {
    if (!currentScreenRef.current) return;
    currentScreenRef.current.style.transition = 'none';
    currentScreenRef.current.style.transform = 'translate(0, 0)';
  }, [row, col]);

  useEffect(() => () => {
    if (swipeTimeoutRef.current) clearTimeout(swipeTimeoutRef.current);
    if (snapBackTimeoutRef.current) clearTimeout(snapBackTimeoutRef.current);
  }, []);

  /**
   * Live drag. Beyond moving the current screen this MOUNTS the neighbour for
   * the current drag direction and lets it follow the finger.
   *
   * Why: the incoming screen used to be created at release time, and a phone
   * cannot rasterise a fresh card (blurred box-shadow layer, QR canvas, fonts)
   * within a frame — measured on device, the compositor animated an invisible
   * layer for ~300ms and the card popped in ~75% of the way through the slide,
   * with an empty viewport in between. Mounting it during the drag gives it
   * 100–500ms to rasterise before it has to move, and doubles as the peek
   * affordance.
   */
  const handleDrag = useCallback((axis: 'h' | 'v', dx: number, dy: number) => {
    if (animating || !currentScreenRef.current) return;

    // A fresh drag supersedes any pending unmount from the last snap-back.
    clearSnapBackTimeout();

    const offset = axis === 'h' ? dx : dy;
    dragOffsetRef.current = { x: axis === 'h' ? dx : 0, y: axis === 'v' ? dy : 0 };

    currentScreenRef.current.style.transition = 'none';
    currentScreenRef.current.style.transform = axis === 'h'
      ? `translate(${dx}px, 0)`
      : `translate(0, ${dy}px)`;

    const vp = viewportRef.current;
    if (!vp || offset === 0) return;

    const direction: -1 | 1 = offset < 0 ? -1 : 1;
    const target = resolveTarget(axis, direction);
    if (!target) {
      // Vertical edge — nothing to arrive, and a direction reversal mid-drag
      // must drop whatever the other direction had mounted.
      if (incomingRef.current) setIncoming(null);
      return;
    }

    const baseX = axis === 'h' ? -direction * vp.clientWidth : 0;
    const baseY = axis === 'v' ? -direction * vp.clientHeight : 0;

    const mounted = incomingRef.current;
    if (
      !mounted
      || mounted.row !== target.row
      || mounted.col !== target.col
      || mounted.baseX !== baseX
      || mounted.baseY !== baseY
    ) {
      // First mount for this direction (or the user reversed and needs the
      // other neighbour). The render below positions it at base + this same
      // offset, so it appears already following the finger.
      setIncoming({ row: target.row, col: target.col, baseX, baseY });
      return;
    }

    const incoming = incomingScreenRef.current;
    if (!incoming) return;
    incoming.style.transition = 'none';
    incoming.style.transform =
      `translate(${baseX + dragOffsetRef.current.x}px, ${baseY + dragOffsetRef.current.y}px)`;
  }, [animating, resolveTarget, setIncoming, clearSnapBackTimeout]);

  const handleSnapBack = useCallback(() => {
    const snap = 'transform 0.25s ease';
    if (currentScreenRef.current) {
      currentScreenRef.current.style.transition = snap;
      currentScreenRef.current.style.transform = 'translate(0, 0)';
    }

    const mounted = incomingRef.current;
    // Offset 0 ⇒ the incoming's rendered transform is its base (fully
    // offscreen), matching the animation target below.
    dragOffsetRef.current = { x: 0, y: 0 };
    if (!mounted) return;

    const incoming = incomingScreenRef.current;
    if (incoming) {
      incoming.style.transition = snap;
      incoming.style.transform = `translate(${mounted.baseX}px, ${mounted.baseY}px)`;
    }
    // Unmount once it's offscreen again — never leave a stale neighbour
    // mounted, or the next drag would reuse a screen for the wrong direction.
    clearSnapBackTimeout();
    snapBackTimeoutRef.current = setTimeout(() => {
      snapBackTimeoutRef.current = null;
      setIncoming(null);
    }, 250);
  }, [clearSnapBackTimeout, setIncoming]);

  const handleSwipe = useCallback((axis: 'h' | 'v', direction: -1 | 1, dx: number, dy: number) => {
    if (animating) return;

    const target = resolveTarget(axis, direction);
    if (!target) {
      handleSnapBack();
      return;
    }
    const { row: newRow, col: newCol } = target;

    onAnimatingChange(true);

    const vp = viewportRef.current;
    const current = currentScreenRef.current;
    if (!vp || !current) {
      onAnimatingChange(false);
      return;
    }

    clearSnapBackTimeout();

    const curDx = axis === 'h' ? dx : 0;
    const curDy = axis === 'v' ? dy : 0;
    const baseX = axis === 'h' ? (-direction * vp.clientWidth) : 0;
    const baseY = axis === 'v' ? (-direction * vp.clientHeight) : 0;
    const outX = axis === 'h' ? (direction * vp.clientWidth) : 0;
    const outY = axis === 'v' ? (direction * vp.clientHeight) : 0;

    const runAnimation = () => {
      const incoming = incomingScreenRef.current;
      if (!incoming) {
        onAnimatingChange(false);
        setIncoming(null);
        return;
      }

      const dur = '0.3s';
      const ease = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';

      current.style.transition = `transform ${dur} ${ease}`;
      current.style.transform = `translate(${outX}px, ${outY}px)`;

      // base + offset must equal the animation target (0,0), so a re-render
      // mid-flight re-computes translate(0, 0) rather than yanking the screen
      // back to where the finger left it.
      dragOffsetRef.current = { x: -baseX, y: -baseY };
      incoming.style.transition = `transform ${dur} ${ease}`;
      incoming.style.transform = 'translate(0, 0)';

      swipeTimeoutRef.current = setTimeout(() => {
        swipeTimeoutRef.current = null;
        // Both state updates in one callback so React commits the new current
        // screen and the incoming's unmount together — no blank frame.
        onCommit(newRow, newCol);
        setIncoming(null);
      }, 320);
    };

    const mounted = incomingRef.current;
    const alreadyMounted = !!mounted
      && mounted.row === newRow
      && mounted.col === newCol
      && mounted.baseX === baseX
      && mounted.baseY === baseY
      && !!incomingScreenRef.current;

    if (alreadyMounted) {
      // Pre-mounted during the drag and already rasterised — animate straight
      // from where the finger left it. No setState, no double-rAF wait.
      runAnimation();
      return;
    }

    // Nothing pre-mounted (keyboard arrows, DesktopFrame arrow buttons,
    // programmatic navigation): mount it now and wait two frames as before.
    dragOffsetRef.current = { x: curDx, y: curDy };
    setIncoming({ row: newRow, col: newCol, baseX, baseY });
    requestAnimationFrame(() => {
      requestAnimationFrame(runAnimation);
    });
  }, [animating, resolveTarget, onCommit, onAnimatingChange, handleSnapBack, setIncoming, clearSnapBackTimeout]);

  const handleTap = useCallback(() => {
    // A gesture that locked an axis (mounting a neighbour) but ended under the
    // tap threshold still arrives here — settle both screens before acting so
    // no stale neighbour is left mounted. No-op when nothing was dragged.
    handleSnapBack();
    const currentRow = rows[row];
    if (currentRow?.type === 'dependant' && !props.childMode && col === 0) {
      props.onEnterChildMode(currentRow.dependant.id);
      return;
    }
    // No tap-to-navigate on the Add card — the two choice buttons
    // (Add persona / Add dependant) require an explicit tap to disambiguate.
  }, [rows, row, col, props, handleSnapBack]);

  const [longPressEngaged, setLongPressEngaged] = useState(false);

  useSwipeGesture({
    onSwipe: handleSwipe,
    onSnapBack: handleSnapBack,
    onDrag: handleDrag,
    onTap: handleTap,
    onLongPressEngage: () => setLongPressEngaged(true),
    onLongPressRelease: () => setLongPressEngaged(false),
    disabled: animating || !!swipeLocked,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (animating || swipeLocked) return;
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('input, textarea, select'))) return;
      if (e.key === 'ArrowLeft') handleSwipe('h', 1, -60, 0);
      if (e.key === 'ArrowRight') handleSwipe('h', -1, 60, 0);
      if (e.key === 'ArrowUp') { e.preventDefault(); handleSwipe('v', 1, 0, -60); }
      if (e.key === 'ArrowDown') { e.preventDefault(); handleSwipe('v', -1, 0, 60); }
      if (e.key === 'Enter') handleTap();
      if (e.key === 'Escape' && props.childMode) props.onExitChildMode();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [animating, swipeLocked, handleSwipe, handleTap, props]);

  const registerArrows = useRegisterCarouselArrows();
  useEffect(() => {
    registerArrows({
      left: () => handleSwipe('h', 1, -60, 0),   // prev card  (ArrowLeft)
      right: () => handleSwipe('h', -1, 60, 0),  // next card  (ArrowRight)
      up: () => handleSwipe('v', 1, 0, -60),     // prev identity (ArrowUp)
      down: () => handleSwipe('v', -1, 0, 60),   // next identity (ArrowDown)
      ...computeArrowState(row, rows.length),
    });
    return () => registerArrows(null);
  }, [registerArrows, handleSwipe, row, rows.length]);

  return (
    <div className="carousel-viewport" data-theme="dark" ref={viewportRef}>
      <div
        className={`carousel-screen${longPressEngaged ? ' carousel-screen-engaged' : ''}`}
        ref={currentScreenRef}
      >
        {rows[row] && renderCard(rows[row], col, props.activeIdentity, props)}
      </div>

      {incomingCard && rows[incomingCard.row] && (
        <div
          className="carousel-screen"
          ref={incomingScreenRef}
          data-testid="carousel-incoming-screen"
          style={{
            transform: `translate(${incomingCard.baseX + dragOffsetRef.current.x}px, ${incomingCard.baseY + dragOffsetRef.current.y}px)`,
            transition: 'none',
          }}
        >
          {renderCard(
            rows[incomingCard.row],
            incomingCard.col,
            resolveActiveIdentity(rows[incomingCard.row]),
            props,
          )}
        </div>
      )}

      <NavDots col={col} row={row} rows={rows} />

      {props.childMode && props.childDependant && (
        <div className="child-banner">
          <span>Viewing as: {props.childDependant.displayName}</span>
          <button className="child-banner-exit" onClick={props.onExitChildMode}>
            Exit (PIN)
          </button>
        </div>
      )}

      {props.children}
    </div>
  );
}
