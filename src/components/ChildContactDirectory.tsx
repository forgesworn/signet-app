import type { ChildContactDirectory as Directory } from '../lib/child-contact-directory';
import type { ContactIdentityList } from '../lib/contacts-v2-identity-lists';
import { ContactTierChip } from './ContactTierChip';

/** No contact mutation callbacks or remote avatar fetching on this surface. */
export function ChildContactDirectory({ view, lists, selectedList, onSelectList }: {
  view: Directory | null; lists: ContactIdentityList[]; selectedList: string; onSelectList(key: string): void;
}) {
  const available = lists.filter(list => view?.personas.includes(list.ownerIdentityPubkey));
  const selected = selectedList === 'all' || available.some(l => l.ownerIdentityPubkey === selectedList) ? selectedList : 'all';
  const entries = view?.entries.filter(entry => selected === 'all' || entry.lists.includes(selected)) ?? [];
  return <section aria-label="Contacts from your guardian" className="stack">
    <h2>Contacts from your guardian</h2>
    <p className="field-hint">Read-only. Names and contact levels reflect your guardian’s current shared directory.</p>
    {!view ? <p role="status">Waiting for your guardian’s current contact directory.</p> : <>
      <label>Identity list
        <select value={selected} onChange={event => onSelectList(event.target.value)}>
          <option value="all">All shared identities</option>
          {available.map(list => <option key={list.ownerIdentityPubkey} value={list.ownerIdentityPubkey}>{list.label}</option>)}
        </select>
      </label>
      {entries.length === 0 ? <p role="status">No contacts shared for this identity.</p> : <ul style={{ listStyle: 'none', padding: 0 }}>
        {entries.map(entry => <li key={entry.id} className="row" style={{ display: 'block' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{entry.name || 'Unnamed contact'}</strong><ContactTierChip tier={entry.tier} /></div>
          {entry.identities.map(key => <code key={key} style={{ display: 'block', overflowWrap: 'anywhere', fontSize: '0.75rem' }}>{key}</code>)}
        </li>)}
      </ul>}
    </>}
  </section>;
}
