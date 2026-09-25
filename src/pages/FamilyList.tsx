import type { DependantIdentity } from '../types';
import { MANAGE_FAMILY_CONTACTS_LABEL } from '../lib/contacts-v2-copy';
import { Icon } from '../components/Icon';

interface Props {
  dependants: DependantIdentity[];
  onSelect: (dependantId: string) => void;
  /** Navigate to the add-dependant flow. Omit to hide the add button (e.g. the paired-child surface). */
  onAddDependant?: () => void;
  /** Navigate to the ken-add flow (recognise a public key) */
  onAddKen?: () => void;
  /** Navigate to the cross-family contacts manager. Omit to hide the entry (e.g. the paired-child surface). */
  onManageContacts?: () => void;
}

/**
 * Lightweight dependant-list page. One row per dep with name + pairing
 * status badge. Tapping a row sets activeDependantId and navigates to
 * GuardianSettings for that dep. The "+ Add dependant" row routes to
 * the existing add-dependant flow.
 *
 * Intentionally thin — no controls, just routing. All management lives
 * in Dependant settings. Spec §3.5.
 */
export function FamilyList({ dependants, onSelect, onAddDependant, onAddKen, onManageContacts }: Props) {
  if (dependants.length === 0) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state" style={{ paddingTop: 64 }}>
          <div className="empty-state-icon"><Icon name="users" size={36} /></div>
          <h3 className="empty-state-title">No dependants yet</h3>
          <p className="empty-state-text">
            Add a dependant to manage their identity, pair their phone, and oversee their sign-ins.
          </p>
          {onAddDependant && (
            <button className="btn btn-primary" onClick={onAddDependant}>
              + Add dependant
            </button>
          )}
          {onAddKen && (
            <button className="btn btn-secondary" onClick={onAddKen}>
              Add a contact (ken)
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {dependants.map((dep, i) => {
          const paired = !!dep.bunkerEndpoint?.authorizedClientPubkey;
          return (
            <button
              key={dep.id}
              onClick={() => onSelect(dep.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '14px 16px',
                background: 'none',
                border: 'none',
                borderBottom: i < dependants.length - 1 ? '1px solid var(--border)' : 'none',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text-primary)',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{dep.displayName}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  <Icon name="smartphone" size={13} className="icon-inline" />
                  {paired ? 'Paired' : 'No phone paired'}
                </div>
              </div>
              <span style={{ color: 'var(--text-muted)' }}>&rsaquo;</span>
            </button>
          );
        })}
      </div>

      {onManageContacts && (
        <button className="btn btn-secondary" style={{ marginTop: 16, width: '100%' }} onClick={onManageContacts}>
          {MANAGE_FAMILY_CONTACTS_LABEL}
        </button>
      )}

      {onAddDependant && (
        <button
          className="btn btn-secondary"
          onClick={onAddDependant}
          style={{ marginTop: 16, width: '100%' }}
        >
          + Add dependant
        </button>
      )}
      {onAddKen && (
        <button
          className="btn btn-ghost"
          onClick={onAddKen}
          style={{ marginTop: 8, width: '100%' }}
        >
          Add a contact (ken)
        </button>
      )}
    </div>
  );
}
