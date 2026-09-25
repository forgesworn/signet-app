import type { DependantIdentity } from '../types';
import { Z } from '../lib/z-index';

interface Props {
  dependants: DependantIdentity[];
  /** The currently active dependant — excluded from the picker list. */
  activeDependantId: string;
  onSwitch: (dependantId: string) => void;
  onClose: () => void;
}

function ageFromDOB(dob: string | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/**
 * Modal overlay shown from the guardian banner when the guardian has more than
 * one dependant and wants to hand the phone to a different one without exiting
 * child-mode. No PIN is required here — the guardian is already holding the
 * device (they had to tap the banner). Exit-from-child-mode remains PIN-gated.
 *
 * See dependant-account-ux-spec §2 (dependant-to-dependant hand-off).
 */
export function DependantSwitchPicker({ dependants, activeDependantId, onSwitch, onClose }: Props) {
  const others = dependants.filter(d => d.id !== activeDependantId);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dep-switch-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: Z.modal,
      }}
    >
      <div
        className="card"
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          margin: 12,
          padding: 16,
          borderBottomLeftRadius: 'var(--radius)',
          borderBottomRightRadius: 'var(--radius)',
        }}
      >
        <h3 id="dep-switch-title" style={{ marginTop: 0, marginBottom: 4, fontSize: '1rem' }}>
          Hand phone to someone else
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          Pick who should use the phone now. No PIN needed — you're already in.
        </p>

        {others.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: 12 }}>
            You only have one dependant set up.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 12 }}>
            {others.map(dep => {
              const age = ageFromDOB(dep.dateOfBirth);
              return (
                <button
                  key={dep.id}
                  className="settings-row"
                  onClick={() => onSwitch(dep.id)}
                >
                  <span className="sr-label">{dep.displayName}</span>
                  <span className="sr-value">{age !== null ? `age ${age}` : ''}</span>
                  <span className="sr-chevron">&rsaquo;</span>
                </button>
              );
            })}
          </div>
        )}

        <button className="btn btn-ghost" onClick={onClose} style={{ width: '100%' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
