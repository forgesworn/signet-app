import { checkNip05, parseNip05 } from '../lib/nip05-check';
import { useId, useState } from 'react';
import type { ContactCheck } from '../lib/contact-checks';
import { CONTACT_CHECK_SOURCES } from '../lib/contact-checks';
import type { ContactIdentity } from '../types';
const METHODS = { words: 'Words', 'in-person': 'In person', nip05: 'NIP-05', 'app-attested': 'App attestation' };
const SOURCES = { nip05: 'NIP-05', facebook: 'Facebook', instagram: 'Instagram', x: 'X', youtube: 'YouTube', website: 'Website', 'printed-card': 'Printed card', other: 'Other' };
export function ContactChecks({ checks, identities, onRecord, onUpdate, onRemove }: {
  checks: ContactCheck[]; identities: ContactIdentity[];
  onRecord?: (check: Omit<ContactCheck, 'id' | 'ownerIdentityPubkey'>) => Promise<void>;
  onUpdate?: (check: Omit<ContactCheck, 'ownerIdentityPubkey'>) => Promise<void>;
  onRemove?: (id: string) => Promise<void>;
}) {
  const sourceId = useId();
  const [editing, setEditing] = useState<ContactCheck | null>(null);
  const [nip05, setNip05] = useState('');
  const [notice, setNotice] = useState('');
  const [method, setMethod] = useState<ContactCheck['method']>('in-person');
  const [source, setSource] = useState<ContactCheck['source']>();
  const [peer, setPeer] = useState(identities[0]?.pubkey ?? '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); setEvidence(''); setEditing(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the check.'); }
    finally { setBusy(false); }
  };
  return <div className="card section">
    <h3>Checks</h3>
    <p>Record how you checked this person’s key. Sources and evidence stay private.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {checks.map(check => <div key={check.id}>
      <p>{METHODS[check.method]} · {new Date(check.checkedAt).toLocaleDateString()} · {check.identityPubkey.slice(0, 12)}…</p>
      {check.source && <p>Private source: {SOURCES[check.source]}</p>}
      {check.evidence && <p style={{ whiteSpace: 'pre-wrap' }}>{check.evidence}</p>}
      {onUpdate && <button className="btn btn-ghost" disabled={busy} onClick={() => {
        setEditing(check); setMethod(check.method); setSource(check.source); setPeer(check.identityPubkey);
        setDate(new Date(check.checkedAt).toISOString().slice(0, 10)); setEvidence(check.evidence ?? '');
      }}>Edit check</button>}
      {onRemove && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => onRemove(check.id))}>Remove check</button>}
    </div>)}
    {onRecord && identities.length > 0 && <>
      <label>Key checked<select className="input" value={peer} onChange={event => setPeer(event.target.value)}>
        {identities.map(identity => <option key={identity.pubkey} value={identity.pubkey}>{identity.label || identity.pubkey.slice(0, 16) + '…'}</option>)}
      </select></label>
      <label>Check method<select className="input" value={method} onChange={event => setMethod(event.target.value as ContactCheck['method'])}>
        {Object.entries(METHODS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Date checked<input className="input" type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <label htmlFor={sourceId}>Private source</label><select id={sourceId} className="input" value={source ?? ''} onChange={event => setSource(event.target.value ? event.target.value as ContactCheck['source'] : undefined)}>
        <option value="">No source recorded</option>{CONTACT_CHECK_SOURCES.map(value => <option key={value} value={value}>{SOURCES[value]}</option>)}
      </select>
      <label>Private evidence or link<textarea className="input" value={evidence} maxLength={2000} onChange={event => setEvidence(event.target.value)} /></label>
      <button className="btn btn-secondary" disabled={busy || !peer || !date || (!editing && checks.length >= 128)} onClick={() => void run(() => {
        const checkedAt = editing && date === new Date(editing.checkedAt).toISOString().slice(0, 10)
          ? editing.checkedAt : new Date(date + 'T00:00:00Z').getTime();
        const value = { identityPubkey: peer, method, checkedAt, ...(source ? { source } : {}), ...(evidence.trim() ? { evidence: evidence.trim() } : {}) };
        return editing && onUpdate ? onUpdate({ ...value, id: editing.id }) : onRecord(value);
      })}>{editing ? 'Save check' : 'Record check'}</button>
      {editing && <button className="btn btn-ghost" disabled={busy} onClick={() => { setEditing(null); setEvidence(''); }}>Cancel edit</button>}
      {!editing && <>
        <label>NIP-05 address to check<input className="input" value={nip05} maxLength={320} onChange={event => setNip05(event.target.value)} /></label>
        <p>Checking contacts this address’s server. It only confirms the server lists the selected key.</p>
        <button className="btn btn-secondary" disabled={busy || !peer || !parseNip05(nip05) || checks.length >= 128} onClick={() => void run(async () => {
          const parsed = parseNip05(nip05)!;
          const address = `${parsed.name}@${parsed.domain}`;
          const result = await checkNip05(address, peer);
          if (result !== 'match') throw new Error(result === 'mismatch' ? 'This address lists a different key.'
            : result === 'not-found' ? 'This address does not list a key.' : 'Could not reach this address’s server.');
          await onRecord({ identityPubkey: peer, method: 'nip05', checkedAt: Date.now(), source: 'nip05', evidence: address });
          setNotice('The address lists this key. NIP-05 check recorded.');
        })}>Check address and record match</button>
      </>}
    </>}
  </div>;
}
