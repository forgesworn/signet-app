import type { DependantIdentity } from '../types';
import { MANAGE_FAMILY_CONTACTS_LABEL } from '../lib/contacts-v2-copy';
import { Icon } from '../components/Icon';
import type { IndependenceArchive } from '../lib/independence-store';
import { shortNpub } from '../lib/signet';

interface Props {
  dependants: DependantIdentity[];
  onSelect: (dependantId: string) => void;
  /** Navigate to the add-dependant flow. Omit to hide the add button (e.g. the paired-child surface). */
  onAddDependant?: () => void;
  /** Navigate to the ken-add flow (recognise a public key) */
  onAddKen?: () => void;
  /** Navigate to the cross-family contacts manager. Omit to hide the entry (e.g. the paired-child surface). */
  onManageContacts?: () => void;
  /** The guardian's own recovery words are not yet written down. Guardian surface only. */
  backupPending?: boolean;
  /** Open Security → Backup Words. */
  onBackup?: () => void;
  independenceArchives?: IndependenceArchive[];
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
export function FamilyList({ dependants, onSelect, onAddDependant, onAddKen, onManageContacts, backupPending, onBackup, independenceArchives = [] }: Props) {
  const history = independenceArchives.length ? <div className="section">
    <h3>Independent family members</h3>
    {independenceArchives.map(archive => <details className="card" key={archive.dependantId} style={{ marginBottom: 12 }}>
      <summary>{archive.displayName} — {archive.choice === 'archive' ? 'read-only archive' : 'family copy deleted'}</summary>
      <p>Handover completed {new Date(archive.completedAt).toLocaleDateString()}. Their identity is managed on their own device.</p>
      {archive.contacts && <>
        <p>This encrypted archive stays on this device. It cannot change their contacts.</p>
        <ul>{archive.contacts.filter(c => c.lifecycle !== 'removed').map(contact => <li key={contact.contactId}>
          {contact.displayName || 'Unnamed contact'} — {contact.tier}
          {contact.blocks.some(b => !b.liftedByOperationId) ? ' (Blocked)' : ''}
          {contact.identities.map(identity => <p key={identity.itemId}>{identity.label ? `${identity.label}: ` : ''}{shortNpub(identity.pubkey)}</p>)}
          {contact.contactMethods.map(method => <p key={method.itemId}>{method.label || method.kind}: {method.value}</p>)}
          {contact.notes && <p>{contact.notes}</p>}
        </li>)}</ul>
      </>}
    </details>)}
  </div> : null;
  const backupLine = backupPending && onBackup ? (
    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
      Their keys are inside yours.{' '}
      <button
        type="button"
        onClick={onBackup}
        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', font: 'inherit', cursor: 'pointer' }}
      >
        Back up →
      </button>
    </p>
  ) : null;

  if (dependants.length === 0) {
    return (
      <div className="fade-in" role="main">
        {backupLine}
        {history}
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
      {backupLine}
      {history}
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
