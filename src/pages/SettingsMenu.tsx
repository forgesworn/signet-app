import { useState } from 'react';
import type { SignetIdentity, AppPreferences, Page } from '../types';
import { ANDROID_APP_URL, isAndroidWeb } from '../lib/android-promo';
import { UpdateStatusLine } from '../components/UpdateStatusLine';

interface Props {
  identity: SignetIdentity;
  preferences: AppPreferences;
  onSetTheme: (theme: 'system' | 'light' | 'dark') => void;
  onDeleteIdentity: () => void;
  /**
   * Called when the user taps "Delete MySignet". Must prompt for a fresh
   * PIN / biometric and resolve `true` only after successful auth. Returning
   * `false` (or throwing) leaves the menu untouched.
   *
   * The PIN-first ordering is deliberate: the user
   * must prove presence before even seeing the "Delete forever" confirm
   * card, so there's no chance of tapping into a dead end if they've
   * forgotten their PIN.
   */
  onRequestDeleteAuth: () => Promise<boolean>;
  powerMode: boolean;
  onSetPowerMode: (enabled: boolean) => void;
  onNavigate: (page: Page) => void;
  /**
   * True when the device holds more than one paired-child record (shared
   * family iPad). Surfaces a "Switch to another
   * child" button that navigates to the picker page.
   */
  showPairedChildSwitcher?: boolean;
  /** Number of authorized (connected) sites for display in the Connections row. */
  connectedSiteCount?: number;
  /**
   * Number of dependants on this device. When `> 0`, surfaces a Family
   * entry between Personas and Security that routes to the
   * `family-list` page. Restores the conventional discoverability path:
   * chrome gear → Settings → Family → pick dep → manage them. The
   * carousel-swipe path remains available.
   */
  dependantsCount: number;
  /** Number of active companion-app data-rail grants, for the Companion apps row. */
  companionGrantCount?: number;
  /** Web only: a new service-worker build is installed and waiting. */
  webUpdateReady?: boolean;
  /** Web only: apply the waiting build (skipWaiting + reload). */
  onApplyWebUpdate?: () => void;
}

export function SettingsMenu({ identity, preferences, onSetTheme, onDeleteIdentity, onRequestDeleteAuth, powerMode, onSetPowerMode, onNavigate, showPairedChildSwitcher, connectedSiteCount = 0, dependantsCount, companionGrantCount = 0, webUpdateReady = false, onApplyWebUpdate }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [versionTaps, setVersionTaps] = useState(0);

  function handleVersionTap() {
    const next = versionTaps + 1;
    setVersionTaps(next);
    if (next >= 5) {
      setVersionTaps(0);
      alert('Verifier mode activated!');
    }
  }

  return (
    <div className="fade-in" role="main">
      {/* D10 — one flush card of row-buttons for the primary navigation items,
          in the existing order, every onNavigate/condition kept as-is. */}
      <div className="card card-flush section">
        <button className="row-button" onClick={() => onNavigate('settings-profile')}>
          <span className="row-main">
            <span className="row-label" style={{ fontWeight: 600 }}>Profile</span>
            <span className="row-sub">Name, photo, badge tier, connected sites</span>
          </span>
          <span className="row-chevron">&rsaquo;</span>
        </button>

        <button className="row-button" onClick={() => onNavigate('settings-personas')}>
          <span className="row-main">
            <span className="row-label" style={{ fontWeight: 600 }}>Personas</span>
            <span className="row-sub">Real-name keypair, anonymous keypairs</span>
          </span>
          <span className="row-chevron">&rsaquo;</span>
        </button>

        {/* Family — only when this device has ≥1 dependant. Conventional
            discoverability path: chrome gear → Settings → Family → pick
            dep → manage them. The carousel-swipe path remains. */}
        {dependantsCount > 0 && (
          <button className="row-button" onClick={() => onNavigate('family-list')}>
            <span className="row-main">
              <span className="row-label" style={{ fontWeight: 600 }}>Family</span>
              <span className="row-sub">Dependants on this device</span>
            </span>
            <span className="row-meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {dependantsCount}
              <span className="row-chevron">&rsaquo;</span>
            </span>
          </button>
        )}

        {preferences.signingMode !== 'paired-child' && <button className="row-button" onClick={() => onNavigate('bots')}>
          <span className="row-main"><span className="row-label">Bots</span><span className="row-sub">Keys and persona ownership</span></span>
          <span className="row-chevron" aria-hidden="true">&rsaquo;</span>
        </button>}
        <button className="row-button" onClick={() => onNavigate('settings-security')}>
          <span className="row-main">
            <span className="row-label" style={{ fontWeight: 600 }}>Security &amp; Backup</span>
            <span className="row-sub">PIN, biometrics, backup words, verification tier</span>
          </span>
          <span className="row-chevron">&rsaquo;</span>
        </button>

        <button className="row-button" onClick={() => onNavigate('connections')}>
          <span className="row-main">
            <span className="row-label" style={{ fontWeight: 600 }}>Connections</span>
            <span className="row-sub">Sites signed in with Signet</span>
          </span>
          <span className="row-meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {connectedSiteCount > 0 && connectedSiteCount}
            <span className="row-chevron">&rsaquo;</span>
          </span>
        </button>

        <button className="row-button" onClick={() => onNavigate('companion-apps')}>
          <span className="row-main">
            <span className="row-label" style={{ fontWeight: 600 }}>Companion apps</span>
            <span className="row-sub">Apps with a live copy of your contacts</span>
          </span>
          <span className="row-meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {companionGrantCount > 0 && companionGrantCount}
            <span className="row-chevron">&rsaquo;</span>
          </span>
        </button>
      </div>

      {/* Appearance */}
      <div className="card section">
        <div className="section-title">Appearance</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['system', 'light', 'dark'] as const).map(theme => (
            <button
              key={theme}
              className={`btn ${preferences.theme === theme ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onSetTheme(theme)}
              style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem' }}
            >
              {theme.charAt(0).toUpperCase() + theme.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Power Mode toggle + sections grouped together */}
      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div className="section-title" style={{ marginBottom: 0 }}>Power Mode</div>
          <button
            onClick={() => onSetPowerMode(!powerMode)}
            style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              background: powerMode ? 'var(--accent)' : 'var(--border)',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              transition: 'background 0.2s',
              flexShrink: 0,
            }}
            aria-label={powerMode ? 'Disable Power Mode' : 'Enable Power Mode'}
          >
            <span
              style={{
                position: 'absolute',
                top: 3,
                left: powerMode ? 23 : 3,
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: 'var(--bg-card)',
                transition: 'left 0.2s',
                display: 'block',
              }}
            />
          </button>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
          Show advanced features like Signet IQ breakdown, identity bridge, and relay settings.
        </p>
      </div>

      {/* Get the Android app — always visible on Android web, snooze-independent */}
      {isAndroidWeb() && (
        <div className="card section">
          <button
            className="btn btn-secondary"
            onClick={() => window.open(ANDROID_APP_URL, '_blank', 'noopener')}
            style={{ width: '100%', padding: '14px 16px', textAlign: 'left', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Get the Android app</div>
              <div style={{ fontSize: '0.8rem', fontWeight: 400, opacity: 0.8 }}>Fingerprint unlock + always-on approvals</div>
            </div>
            <span style={{ fontSize: '0.85rem', opacity: 0.5 }}>&rsaquo;</span>
          </button>
        </div>
      )}

      {powerMode && (
        <div style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 12, marginLeft: 4 }}>
          <div className="card section" style={{ background: 'var(--bg-secondary)' }}>
            <button
              className="btn btn-secondary"
              onClick={() => onNavigate('settings-advanced')}
              style={{ width: '100%', padding: '14px 16px', textAlign: 'left', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Advanced</div>
                <div style={{ fontSize: '0.8rem', fontWeight: 400, opacity: 0.8 }}>Bridge, roster, relay, remote signer</div>
              </div>
              <span style={{ fontSize: '0.85rem', opacity: 0.5 }}>&rsaquo;</span>
            </button>
          </div>
        </div>
      )}

      {/* Shared-device pairing switcher */}
      {showPairedChildSwitcher && (
        <div className="card section">
          <div className="section-title">This device</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            More than one child is paired to this device.
          </p>
          <button className="btn btn-secondary" onClick={() => onNavigate('paired-child-switcher')}>
            Switch to another child
          </button>
        </div>
      )}

      {/* Re-pair (paired-child surface). When the
          guardian's per-dep bunker endpoint has been revoked + regenerated
          (typically because the guardian replaced their phone) the existing
          PairedChildRecord points at a dead endpoint and every NIP-46 round-
          trip silently fails. This entry surfaces the fix — scan a fresh QR,
          update the record in place, keep PIN / audit / settings. */}
      {preferences.signingMode === 'paired-child' && (
        <div className="card section">
          <div className="section-title">Re-pair with your guardian</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            If your guardian got a new phone, you'll need a fresh code from them so this app can
            reconnect. Your PIN and history stay the same.
          </p>
          <button className="btn btn-secondary" onClick={() => onNavigate('paired-child-repair')}>
            Scan new code
          </button>
        </div>
      )}

      {/* Activity (paired-child surface, v2). The
          guardian's app dual-addresses audit gift-wraps when visibility
          resolves true for this dep; the child's device decrypts them
          with its bunker client privkey. The Activity page handles
          empty / hidden states — we always surface the entry-point. */}
      {preferences.signingMode === 'paired-child' && (
        <div className="card section">
          <div className="section-title">Activity</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Things you've signed recently.
          </p>
          <button className="btn btn-secondary" onClick={() => onNavigate('activity')}>
            View activity
          </button>
        </div>
      )}

      {/* Delete — Power Mode only (2026-06-10). Destructive + irreversible;
          hidden from the default surface, revealed when Power Mode is on. */}
      {powerMode && (
      <div className="section" style={{ marginTop: 32 }}>
        {!confirmDelete ? (
          <button
            className="btn btn-ghost"
            onClick={async () => {
              try {
                const ok = await onRequestDeleteAuth();
                if (ok) setConfirmDelete(true);
              } catch {
                // Auth failure or cancellation — leave the menu untouched.
              }
            }}
            style={{ color: 'var(--danger)' }}
          >
            Delete MySignet
          </button>
        ) : (
          (() => {
            // §6.9 — when any of the user's keypair slots has an active
            // public profile we surface the relay-retract clause. The
            // deletion code (App.tsx handleDeleteIdentity) fires the kind-5
            // + tombstone loop regardless, but the user deserves to know
            // BEFORE confirming that relay state is also being targeted.
            const hasActiveProfile =
              identity.naturalPerson.publicProfile?.enabled === true ||
              identity.persona.publicProfile?.enabled === true ||
              identity.professionalPersona?.publicProfile?.enabled === true ||
              (identity.extraPersonas ?? []).some(p => p.publicProfile?.enabled === true);
            return (
              <div className="card" style={{ borderColor: 'var(--danger)' }}>
                <p style={{ marginBottom: 12, fontSize: '0.9rem' }}>
                  This will permanently delete your identity from this device. Make sure you've saved your backup words.
                </p>
                {hasActiveProfile && (
                  <p style={{ marginBottom: 12, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                    Signet will also ask Nostr relays to delete your public profiles. Some relays may keep a copy — your verifications and other relay events stay, only your kind-0 profiles are retracted.
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-danger" onClick={onDeleteIdentity} style={{ flex: 1 }}>Delete forever</button>
                  <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)} style={{ flex: 1 }}>Cancel</button>
                </div>
              </div>
            );
          })()
        )}
      </div>
      )}

      {/* About */}
      <div style={{ textAlign: 'center', marginTop: 32, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        <div
          onClick={handleVersionTap}
          style={{ cursor: 'pointer', userSelect: 'none', padding: '4px 0' }}
        >
          MySignet v{__APP_VERSION__}{import.meta.env.DEV ? '-dev' : ''}
        </div>
        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>
          {__BUILD_TIME__.replace('T', ' ').slice(0, 16)} · {__GIT_SHA__}
        </div>
        <UpdateStatusLine webUpdateReady={webUpdateReady} onApplyWebUpdate={onApplyWebUpdate} />
        <div>Open source identity verification</div>
      </div>
    </div>
  );
}
