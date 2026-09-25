import { useState } from 'react';
import type { EffectiveContact } from '../types';
export function ContactsCard({ name, contacts, available, onOpen }: {
  name: string; contacts: readonly EffectiveContact[]; available: boolean;
  onOpen(action: 'view' | 'new', query: string): Promise<void>;
}) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const visible = contacts.filter(contact => !contact.blocked && !contact.archived && contact.lifecycle === 'active');
  const recent = visible.filter(contact => !query || contact.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const open = async (action: 'view' | 'new') => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onOpen(action, query); } catch { setError('Could not open these contacts.'); }
    finally { setBusy(false); }
  };
  return <div className="card section" style={{ margin: 16 }}>
    <h2>{name}’s contacts</h2>
    {available ? <>
      <p>{visible.length} contacts · {visible.filter(c => c.effectiveTier === 'kin').length} Kin · {visible.filter(c => c.effectiveTier === 'kith').length} Kith · {visible.filter(c => c.effectiveTier === 'ken').length} Ken</p>
      <label>Search this identity’s contacts<input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ul>{recent.map(contact => <li key={contact.contactId}>{contact.displayName}</li>)}</ul>
    </> : <p>Open this identity’s contacts to view its private list.</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn btn-primary" disabled={busy} onClick={() => void open('view')}>View contacts</button>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void open('new')}>Add contact</button>
  </div>;
}
