import { useState } from 'react';
import type { EffectiveContact } from '../types';
import { contactDisplayName } from '../lib/contacts-v2-name';
import { IMPORT_FOLLOWING_LABEL } from '../lib/contacts-v2-copy';
import { ContactAvatar } from './ContactAvatar';
import { ContactTierChip } from './ContactTierChip';
import { Icon } from './Icon';
export type ContactsCardAction = 'view' | 'new' | 'follows';
export function ContactsCard({ name, contacts, available, followsAvailable = false, onOpen }: {
  name: string; contacts: readonly EffectiveContact[]; available: boolean;
  /** "Import following" — only for an owner persona with a public Nostr profile. */
  followsAvailable?: boolean;
  onOpen(action: ContactsCardAction, query: string): Promise<void>;
}) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const visible = contacts.filter(contact => !contact.blocked && !contact.archived && contact.lifecycle === 'active');
  const search = query.trim().toLocaleLowerCase();
  const recent = visible.filter(contact => !search || contactDisplayName(contact).toLocaleLowerCase().includes(search))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const open = async (action: ContactsCardAction) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onOpen(action, query); } catch { setError('Could not open these contacts.'); }
    finally { setBusy(false); }
  };
  const empty = available && visible.length === 0;
  return (
    <section className="contacts-card" aria-label={`${name}’s contacts`} aria-busy={busy}>
      <header className="contacts-card-header">
        <div className="contacts-card-heading">
          <span className="contacts-card-emblem"><Icon name="users" size={24} /></span>
          <div>
            <h2>Contacts</h2>
            <p className="contacts-card-persona" title={name}>{name || 'This persona'}</p>
          </div>
        </div>
        {available && <span className="contacts-card-total">{visible.length} {visible.length === 1 ? 'contact' : 'contacts'}</span>}
      </header>

      <div className={`contacts-card-body${empty || !available ? ' contacts-card-body-centred' : ''}`}>
        {!available ? (
          <div className="contacts-card-empty">
            <span className="contacts-card-state-icon"><Icon name="key" size={32} /></span>
            <h3>A private contact list</h3>
            <p>Open this identity’s contacts to view its private list.</p>
          </div>
        ) : empty ? (
          <div className="contacts-card-empty">
            <span className="contacts-card-state-icon"><Icon name="users" size={32} /></span>
            <h3>No contacts yet</h3>
            <p>Add someone you know to this persona’s private list.</p>
          </div>
        ) : (
          <>
            <dl className="contacts-card-tiers" aria-label="Contact trust tiers">
              {(['kin', 'kith', 'ken'] as const).map(tier => (
                <div key={tier} className={`contacts-card-tier contacts-card-tier-${tier}`}>
                  <dt><span aria-hidden="true" />{tier}</dt>
                  <dd>{visible.filter(contact => contact.effectiveTier === tier).length}</dd>
                </div>
              ))}
            </dl>

            <form className="contacts-card-search" onSubmit={event => { event.preventDefault(); void open('view'); }} role="search">
              <Icon name="search" size={19} />
              <input className="input" type="search" value={query} placeholder="Find a contact"
                aria-label="Search this identity’s contacts" onChange={event => setQuery(event.target.value)} />
            </form>

            <div className="contacts-card-preview-heading">
              <h3>{search ? 'Matching contacts' : 'Recently updated'}</h3>
              {!search && <span>Latest {recent.length}</span>}
            </div>
            {recent.length > 0 ? (
              <ul className="contacts-card-list">
                {recent.map(contact => {
                  const displayName = contactDisplayName(contact) || 'Unnamed contact';
                  return (
                    <li key={contact.contactId}>
                      <span className="contacts-card-avatar"><ContactAvatar url={null} name={displayName}
                        pubkey={contact.identities?.[0]?.pubkey ?? contact.contactId} size={40} /></span>
                      <span className="contacts-card-contact-name" title={displayName}>{displayName}</span>
                      <span className="contacts-card-contact-tier"><ContactTierChip tier={contact.effectiveTier} source={contact.tierSource} compact /></span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="contacts-card-no-results" role="status">
                <p>No contacts match your search.</p>
                <button className="btn btn-ghost btn-sm" onClick={() => setQuery('')}>Clear search</button>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="contacts-card-footer">
        {error && <p className="contacts-card-error" role="alert">{error}</p>}
        <div className="contacts-card-actions">
          <button className={`btn ${empty ? 'btn-secondary' : 'btn-primary'}`} disabled={busy} onClick={() => void open('view')}>View contacts</button>
          <button className={`btn ${empty ? 'btn-primary' : 'btn-secondary'}`} disabled={busy} onClick={() => void open('new')}>
            <span aria-hidden="true">+</span> Add contact
          </button>
        </div>
        {followsAvailable && (
          <button className="btn btn-ghost contacts-card-import" disabled={busy} onClick={() => void open('follows')}>
            <Icon name="download" size={17} />{IMPORT_FOLLOWING_LABEL}
          </button>
        )}
      </footer>
    </section>
  );
}
