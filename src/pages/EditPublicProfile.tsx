/**
 * EditPublicProfile — narrowed in Phase 2 T28 to two responsibilities only:
 *
 *   1. **Paired-child read-only view (§6.6.11)** — the kid's surface for the
 *      public Nostr profile their guardian set up. All slot config is shown
 *      read-only with "your guardian set this up" framing and a single
 *      "Done" button that just closes.
 *
 *   2. **Race-recovery dialog (§5.3)** — when the publish flow on
 *      PersonaAdvanced's PublishBlock detects a newer kind-0 on the relay,
 *      it routes here to show the user a load-latest / keep-mine choice.
 *
 * Everything else that used to live here — the field editor (display name,
 * about, picture, banner, nip05, lud16, website), the Save button, the
 * Publish button, typed-name confirm, upload handling — has moved:
 *   - field editing → persona card via SlotProfileFields (Phase 2 T21)
 *   - publish + typed-name confirm → PersonaAdvanced's PublishBlock (T23)
 *
 * The prop shape is intentionally minimal so the surface can't drift back
 * into a field editor by accident. Phase 2F wires the race-recover entry
 * point through PersonaAdvanced.
 */

import type { PersonaPublicProfile, PublicProfileConfig } from '../types';
import { safeImageOrLinkUrl } from '../lib/public-profile-publish';
import { Icon } from '../components/Icon';

export type EditPublicProfileViewerMode = 'paired-child' | 'race-recover';

export interface EditPublicProfileProps {
  /** Read-only display of the slot config the editor is presenting. */
  config: PublicProfileConfig;
  /** Read-only display of the publication state — drives "Last published". */
  state?: PersonaPublicProfile;
  /** Fallback for empty `config.displayName` (matches the kind-0 build path). */
  fallbackDisplayName: string;
  /** Narrowed in Phase 2: 'paired-child' (read-only) or 'race-recover' (modal-y dialog). */
  viewerMode: EditPublicProfileViewerMode;
  /** Display name of the dependant — paired-child mode uses this in the lede. */
  dependantDisplayName?: string;
  /** Always wired — primary close on both modes. */
  onCancel: () => void;
  /** Race-recover only — user taps "Load latest" to fetch fresh kind-0 and abandon local edits. */
  onLoadLatest?: () => Promise<void>;
  /** Race-recover only — user taps "Keep my version" → caller resumes publish with their local config. */
  onKeepMine?: () => Promise<void>;
}

export function EditPublicProfile({
  config,
  state,
  fallbackDisplayName,
  viewerMode,
  dependantDisplayName,
  onCancel,
  onLoadLatest,
  onKeepMine,
}: EditPublicProfileProps) {
  if (viewerMode === 'race-recover') {
    return (
      <RaceRecoverDialog
        onLoadLatest={onLoadLatest}
        onKeepMine={onKeepMine}
        onCancel={onCancel}
      />
    );
  }

  return (
    <PairedChildReadOnly
      config={config}
      state={state}
      fallbackDisplayName={fallbackDisplayName}
      dependantDisplayName={dependantDisplayName}
      onCancel={onCancel}
    />
  );
}

// ─── Paired-child read-only view (§6.6.11) ────────────────────────────────

function PairedChildReadOnly({
  config,
  state,
  fallbackDisplayName,
  dependantDisplayName,
  onCancel,
}: {
  config: PublicProfileConfig;
  state?: PersonaPublicProfile;
  fallbackDisplayName: string;
  dependantDisplayName?: string;
  onCancel: () => void;
}) {
  const displayName = config.displayName || fallbackDisplayName;
  const safePicture = config.pictureUrl && safeImageOrLinkUrl(config.pictureUrl) ? config.pictureUrl : undefined;
  const safeBanner = config.bannerUrl && safeImageOrLinkUrl(config.bannerUrl) ? config.bannerUrl : undefined;
  const safeWebsite = config.website && safeImageOrLinkUrl(config.website) ? config.website : undefined;
  const lede = dependantDisplayName
    ? `Your guardian set up ${dependantDisplayName}'s public Nostr profile. It's visible to anyone on the relay.`
    : "Your guardian set up this public Nostr profile. It's visible to anyone on the relay.";

  return (
    <div className="fade-in">
      {/* No in-page <h2> — the Layout header already reads "Public profile". */}
      <div role="note" style={{
        padding: '10px 12px',
        background: 'var(--info-light, var(--accent-light))',
        color: 'var(--info, var(--accent-text))',
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.85rem',
        marginBottom: 14,
      }}>
        <Icon name="key" size={14} className="icon-inline" /><strong>Your guardian set this up.</strong> To change your public profile, ask them.
      </div>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 18 }}>
        {lede}
      </p>

      <ReadOnlyField label="Display name" value={displayName} />
      {config.about && <ReadOnlyField label="About" value={config.about} multiline />}

      {safePicture && (
        <ReadOnlyImage label="Picture" url={safePicture} aspect="square" />
      )}
      {safeBanner && (
        <ReadOnlyImage label="Banner" url={safeBanner} aspect="wide" />
      )}

      {config.nip05 && <ReadOnlyField label="NIP-05" value={config.nip05} />}
      {config.lud16 && <ReadOnlyField label="Lightning address" value={config.lud16} />}
      {safeWebsite && <ReadOnlyField label="Website" value={safeWebsite} />}

      {state?.lastPublishedAt && (
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 14, marginBottom: 4 }}>
          Last published: {new Date(state.lastPublishedAt * 1000).toLocaleString()}
          {state.lastPublishedRelay && <> · to {state.lastPublishedRelay}</>}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button className="btn btn-primary" onClick={onCancel} style={{ flex: 1 }}>Done</button>
      </div>
    </div>
  );
}

// ─── Race-recover dialog (§5.3) ───────────────────────────────────────────

function RaceRecoverDialog({
  onLoadLatest,
  onKeepMine,
  onCancel,
}: {
  onLoadLatest?: () => Promise<void>;
  onKeepMine?: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0,
        background: 'var(--scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16,
      }}
    >
      <div className="card" style={{ maxWidth: 480, width: '100%', padding: 20 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Your profile was updated elsewhere</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
          Looks like you edited this profile on another device. Load the latest version to review, or keep your version and re-publish to overwrite.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary"
            onClick={() => { onCancel(); }}
            style={{ flex: 1 }}
          >
            Cancel
          </button>
          {onKeepMine && (
            <button
              className="btn btn-secondary"
              onClick={() => { void onKeepMine(); }}
              style={{ flex: 1 }}
            >
              Keep my version
            </button>
          )}
          {onLoadLatest && (
            <button
              className="btn btn-primary"
              onClick={() => { void onLoadLatest(); }}
              style={{ flex: 1 }}
            >
              Load latest
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Read-only field primitives ───────────────────────────────────────────

function ReadOnlyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{
        padding: '8px 10px',
        background: 'var(--bg-secondary)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.9rem',
        color: 'var(--text-primary)',
        whiteSpace: multiline ? 'pre-wrap' : 'normal',
        wordBreak: 'break-word',
      }}>
        {value}
      </div>
    </div>
  );
}

function ReadOnlyImage({ label, url, aspect }: { label: string; url: string; aspect: 'square' | 'wide' }) {
  const aspectRatio = aspect === 'wide' ? '3 / 1' : '1 / 1';
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{
        width: '100%',
        aspectRatio,
        background: 'var(--bg-secondary)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <img
          src={url}
          alt={label}
          referrerPolicy="no-referrer"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {/* TODO(security audit 2026-05-18): preview-gate external (non-pictureBlossomHash)
            URLs behind a "Tap to load" affordance, matching ImageRow's pattern.
            For now, referrerPolicy=no-referrer prevents the host from learning
            which Signet profile is rendering the asset. */}
      </div>
    </div>
  );
}
