import { useState } from 'react';
import { CONTACT_ORIGIN_LABELS, CONTACT_ORIGIN_METHODS, type ContactOrigin } from '../lib/contact-origins';
import { newContactId } from '../lib/contacts-v2-ids';
export function ContactOrigins({ origins, knownSince, onSave, onRemove }: {
  origins: ContactOrigin[]; knownSince: number;
  onSave?: (origin: Omit<ContactOrigin, 'ownerIdentityPubkey'>) => Promise<void>; onRemove?: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Omit<ContactOrigin, 'ownerIdentityPubkey'>>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); setDraft(undefined); } catch { setError('Could not save contact history.'); } finally { setBusy(false); }
  };
  return <section className="card section">
    <h2>How added</h2>
    <p>Known since {new Date(origins.length ? Math.min(...origins.map(origin => origin.addedAt)) : knownSince).toLocaleDateString()}</p>
    <p>This history stays private in Signet.</p>
    {origins.map(origin => <div key={origin.id}>
      <p>{CONTACT_ORIGIN_LABELS[origin.method]} · {new Date(origin.addedAt).toLocaleDateString()}</p>
      {origin.inviteName && <p>Via your invite: {origin.inviteName}</p>}
      {origin.caption && <p>Invite caption: {origin.caption}</p>}
      {origin.appName && <p>App: {origin.appName}</p>}
      {onSave && <button className="btn btn-ghost" disabled={busy} onClick={() => setDraft(origin)}>Edit how added</button>}
      {onRemove && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => onRemove(origin.id))}>Remove history record</button>}
    </div>)}
    {onSave && !draft && <button className="btn btn-secondary" onClick={() => setDraft({ id: newContactId(), method: 'manual', addedAt: knownSince })}>Add history record</button>}
    {draft && onSave && <form onSubmit={event => { event.preventDefault(); void run(() => onSave(draft)); }}>
      <label htmlFor="origin-method">How added</label><select id="origin-method" className="input" value={draft.method} onChange={event => setDraft({ ...draft, method: event.target.value as ContactOrigin['method'] })}>
        {CONTACT_ORIGIN_METHODS.map(method => <option value={method} key={method}>{CONTACT_ORIGIN_LABELS[method]}</option>)}
      </select>
      <label htmlFor="origin-date">Date added</label><input id="origin-date" className="input" type="date" required value={new Date(draft.addedAt).toISOString().slice(0, 10)} onChange={event => {
        const addedAt = Date.parse(event.target.value); if (Number.isFinite(addedAt)) setDraft({ ...draft, addedAt });
      }} />
      <label htmlFor="origin-invite">Private invite name</label><input id="origin-invite" className="input" value={draft.inviteName ?? ''} maxLength={200} onChange={event => setDraft({ ...draft, inviteName: event.target.value })} />
      <label htmlFor="origin-caption">Invite caption</label><input id="origin-caption" className="input" value={draft.caption ?? ''} maxLength={200} onChange={event => setDraft({ ...draft, caption: event.target.value })} />
      <label htmlFor="origin-app">App name</label><input id="origin-app" className="input" value={draft.appName ?? ''} maxLength={200} onChange={event => setDraft({ ...draft, appName: event.target.value })} />
      <button className="btn btn-primary" disabled={busy}>Save history record</button><button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setDraft(undefined)}>Cancel</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
