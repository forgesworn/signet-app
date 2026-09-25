import { useEffect, useState, type ReactNode } from 'react';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { StoredContactInvite } from '../lib/contact-invite-store';
import { contactInviteLink } from '../lib/contact-invite-link';
import { QRCode } from './QRCode';

/** Only the selected identity's reusable invites reach its carousel card. */
export function ContactInviteQRCard({ service, identityPubkey, name, relays, version, publicCard, onManage }: {
  service: ContactInviteService; identityPubkey: string; name: string; relays: string[];
  version: number; publicCard: ReactNode; onManage(): void;
}) {
  const [loaded, setLoaded] = useState<{ service: ContactInviteService; key: string; rows: StoredContactInvite[] } | null>(null);
  const [selected, setSelected] = useState('');
  const [showPublic, setShowPublic] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void service.read().then(value => {
      if (!cancelled) setLoaded({ service, key: identityPubkey, rows: value.invites.filter(i => i.identityPubkey === identityPubkey) });
    }).catch(() => { if (!cancelled) setError('Could not load contact invites.'); });
    return () => { cancelled = true; };
  }, [service, identityPubkey, version]);
  const ready = loaded?.service === service && loaded.key === identityPubkey;
  const invites = ready ? loaded.rows.filter(i => i.enabled && i.mode === 'standing'
    && (i.invite.expiresAt === undefined || i.invite.expiresAt > now)) : [];
  const invite = invites.find(i => i.id === selected) ?? invites[0];
  if (showPublic) return <>{publicCard}<button className="btn btn-secondary" onClick={() => setShowPublic(false)}>Show contact invite</button></>;
  return <div className="qr-view">
    <h2>{name}</h2>
    <p>Scan to send a contact request. This invite can be used more than once.</p>
    {error && <p role="alert">{error}</p>}
    {!ready && !error && <p>Loading contact invite…</p>}
    {invite && <>
      <label>Private invite name<select className="input" value={invite.id} onChange={e => setSelected(e.target.value)}>
        {invites.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
      </select></label>
      <div className="qr-box"><QRCode data={contactInviteLink(invite.invite, window.location.origin)} size={260} /></div>
    </>}
    {ready && !invite && <button className="btn btn-primary" disabled={busy} onClick={() => {
      setBusy(true); setError('');
      void service.create(identityPubkey, 'My contact card', relays, 'standing', Math.floor(Date.now() / 1000))
        .then(row => { setLoaded({ service, key: identityPubkey, rows: [row] }); setSelected(row.id); })
        .catch(() => setError('Could not create an invite. Open Invites to review your active invites.'))
        .finally(() => setBusy(false));
    }}>{busy ? 'Creating invite…' : 'Create reusable contact invite'}</button>}
    <button className="btn btn-secondary" onClick={onManage}>Manage invites</button>
    <button className="btn btn-ghost" onClick={() => setShowPublic(true)}>Show public key instead</button>
  </div>;
}
