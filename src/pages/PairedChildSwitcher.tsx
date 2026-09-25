/**
 * Multi-pairing switcher for shared family devices.
 *
 * On a device with more than one paired dependant (shared family iPad
 * scenario), this page lists every stored pairing and lets the user
 * flip the active one. Public metadata only — no decryption needed, so
 * it can safely render before the user has unlocked.
 *
 * Each row shows the dependant's display name + when the pair
 * happened + a check if that row is currently active.
 */

import type { PairedChildMeta } from '../lib/db';

interface Props {
  metas: PairedChildMeta[];
  activePubkey?: string;
  /**
   * Called when the user taps one of the rows. Caller is responsible
   * for persisting the `activeAccountId` flip and triggering whatever
   * re-auth / relay teardown the switch needs.
   */
  onSelect: (dependantPubkey: string) => void;
  onBack: () => void;
}

export function PairedChildSwitcher({ metas, activePubkey, onSelect, onBack }: Props) {
  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 8 }}>Who's using this device?</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
        Tap your name below. The next unlock will sign you in as that account.
      </p>

      {metas.length === 0 ? (
        <div style={{
          padding: 20,
          borderRadius: 'var(--radius)',
          background: 'var(--bg-secondary)',
          color: 'var(--text-secondary)',
          fontSize: '0.9rem',
          textAlign: 'center',
        }}>
          No pairings on this device yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {metas.map(meta => {
            const isActive = meta.dependantPubkey === activePubkey;
            return (
              <button
                key={meta.dependantPubkey}
                onClick={() => onSelect(meta.dependantPubkey)}
                disabled={isActive}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '14px 16px',
                  borderRadius: 'var(--radius)',
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                  background: isActive ? 'var(--accent-light)' : 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  textAlign: 'left',
                  cursor: isActive ? 'default' : 'pointer',
                  opacity: isActive ? 1 : 1,
                }}
                aria-label={isActive ? `${meta.dependantName} (active)` : `Switch to ${meta.dependantName}`}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600 }}>{meta.dependantName}</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Paired {new Date(meta.pairedAt * 1000).toLocaleDateString()}
                  </span>
                </span>
                {isActive && (
                  <span style={{
                    fontSize: '0.75rem',
                    color: 'var(--accent)',
                    fontWeight: 600,
                  }}>
                    Active
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <button
        className="btn btn-ghost"
        onClick={onBack}
        style={{ marginTop: 24, width: '100%' }}
      >
        Back
      </button>
    </div>
  );
}
