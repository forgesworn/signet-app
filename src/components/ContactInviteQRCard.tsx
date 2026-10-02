import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { StoredContactInvite } from '../lib/contact-invite-store';
import { contactInviteLink, contactInviteOrigin } from '../lib/contact-invite-link';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import type { QRCardSlots } from './QRCard';
import { sanitizeDisplayName } from '../lib/text-sanitize';
import { MiniIdBadge } from './MiniIdBadge';
import { QRCode } from './QRCode';

type Tab = 'mysignet' | 'npub';
const tabKey = (pubkey: string) => `signet:qr-tab:${pubkey}`;
const nameKey = (pubkey: string) => `signet:qr-share-name:${pubkey}`;
const NAME_MAX = 100;

function readShareName(pubkey: string): boolean {
  try { return localStorage.getItem(nameKey(pubkey)) !== '0'; } catch { return true; }
}
function writeShareName(pubkey: string, on: boolean): void {
  try { localStorage.setItem(nameKey(pubkey), on ? '1' : '0'); } catch { /* storage unavailable: the choice just isn't remembered */ }
}

function readTab(pubkey: string): Tab {
  try { return localStorage.getItem(tabKey(pubkey)) === 'npub' ? 'npub' : 'mysignet'; } catch { return 'mysignet'; }
}
function writeTab(pubkey: string, tab: Tab): void {
  try { localStorage.setItem(tabKey(pubkey), tab); } catch { /* storage unavailable: the choice just isn't remembered */ }
}

/**
 * One frame, two tabs. "MySignet" shows this persona's reusable contact invite;
 * "Nostr npub" shows the public-key card. Only the selected identity's reusable
 * invites reach its carousel card. While the app is locked the invite vault
 * cannot be read, so the npub tab is shown and the invite tab asks to unlock.
 */
export function ContactInviteQRCard({ service, identityPubkey, resolved, relays, version, renderPublicCard, onManage, locked, onRequestUnlock }: {
  service: ContactInviteService; identityPubkey: string; resolved: ResolvedIdentity; relays: string[];
  version: number; renderPublicCard: (slots?: QRCardSlots) => ReactNode; onManage(): void;
  locked: boolean; onRequestUnlock(): void;
}) {
  const [remembered, setRemembered] = useState<Tab>(() => readTab(identityPubkey));
  const [loaded, setLoaded] = useState<{ service: ContactInviteService; key: string; rows: StoredContactInvite[]; requests: number } | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false), [createFailed, setCreateFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [shareName, setShareName] = useState(() => readShareName(identityPubkey));
  // One automatic attempt per mount for each chip state; a failure waits for "Try again".
  const autoTried = useRef(new Set<'named' | 'plain'>());
  const caption = resolved.displayNameIsSet ? sanitizeDisplayName(resolved.displayName, NAME_MAX) : '';
  const nameAvailable = caption !== '';
  const withName = nameAvailable && shareName;
  const tab: Tab = locked ? 'npub' : remembered;
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (locked) { setLoaded(null); setLoadFailed(false); return; }
    let cancelled = false;
    setLoadFailed(false);
    void service.read().then(value => {
      if (cancelled) return;
      setLoaded({
        service, key: identityPubkey,
        rows: value.invites.filter(i => i.identityPubkey === identityPubkey),
        requests: value.arrivals.filter(a => a.identityPubkey === identityPubkey && a.dismissedAt === undefined && a.channel !== 'exchange').length,
      });
    }).catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [service, identityPubkey, version, locked, retry]);
  const ready = !locked && loaded?.service === service && loaded.key === identityPubkey;
  const invites = ready ? loaded.rows.filter(i => i.enabled && i.mode === 'standing'
    && (i.invite.expiresAt === undefined || i.invite.expiresAt > now)
    && (withName ? i.invite.caption === caption : !i.invite.caption)) : [];
  const invite = invites.find(i => i.id === selected) ?? invites[0];
  const requests = ready ? loaded.requests : 0;

  const create = () => {
    setBusy(true); setCreateFailed(false);
    void service.create(identityPubkey, 'My contact card', relays, 'standing', Math.floor(Date.now() / 1000), undefined, withName ? caption : undefined)
      .then(row => {
        setLoaded(old => ({ service, key: identityPubkey, rows: [...(old?.service === service && old.key === identityPubkey ? old.rows : []), row], requests: old?.requests ?? 0 }));
        setSelected(row.id);
      })
      .catch(() => setCreateFailed(true))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    const state = withName ? 'named' : 'plain';
    if (tab !== 'mysignet' || !ready || invite || busy || autoTried.current.has(state)) return;
    autoTried.current.add(state);
    create();
  });

  const choose = (next: Tab) => {
    if (next === 'mysignet' && locked) { onRequestUnlock(); return; }
    setRemembered(next); writeTab(identityPubkey, next);
  };
  const toggleName = () => { setCreateFailed(false); setShareName(!shareName); writeShareName(identityPubkey, !shareName); };
  const tabs = <div className="qr-tabs" role="group" aria-label="QR type">
    {([['mysignet', 'MySignet'], ['npub', 'Nostr npub']] as const).map(([id, label]) =>
      <button type="button" key={id} className={`qr-tab${tab === id ? ' active' : ''}`} aria-pressed={tab === id} onClick={() => choose(id)}>{label}</button>)}
  </div>;
  const footer = <>
    {locked && <div className="qr-unlock">
      <span className="qr-share-note">Unlock for your MySignet invite</span>
      <button type="button" className="btn btn-secondary" onClick={onRequestUnlock}>Unlock</button>
    </div>}
    {requests > 0 && <button type="button" className="qr-requests" onClick={onManage}>● {requests} {requests === 1 ? 'request' : 'requests'} waiting ›</button>}
    <button type="button" className="btn btn-ghost" onClick={onManage}>Manage invites</button>
  </>;

  const publicCard = renderPublicCard({ tabs, footer });
  return <>
    <div style={{ display: tab === 'npub' ? 'contents' : 'none' }}>{publicCard}</div>
    {tab === 'mysignet' && <div className="qr-view qr-tabbed">
      <div><MiniIdBadge resolved={resolved} /></div>
      {tabs}
      <div className="qr-box">
        {invite && <QRCode data={contactInviteLink(invite.invite, contactInviteOrigin())} size={230} />}
      </div>
      <div className="qr-caption">{`Scan with MySignet. You'll both be added once you accept.`}</div>
      <div className="qr-controls">
        <div className="qr-sees">
          <span>They&apos;ll see</span>
          {nameAvailable && <button type="button" className={`qr-pill${withName ? ' active' : ''}`} aria-pressed={withName} onClick={toggleName}>{withName ? '✓ ' : ''}Your name</button>}
          <span>{withName ? `Your name (${caption}) and your npub` : 'Your npub only'}</span>
        </div>
        {loadFailed && <><p role="alert" className="qr-share-note danger">Could not load your invite.</p>
          <button type="button" className="btn btn-secondary" onClick={() => setRetry(n => n + 1)}>Try again</button></>}
        {!loadFailed && createFailed && <><p role="alert" className="qr-share-note danger">Could not set up your invite.</p>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={create}>Try again</button></>}
        {!loadFailed && !createFailed && !invite && <p role="status" className="qr-share-note">Setting up your invite…</p>}
        {invites.length > 1 && invite && <label className="qr-invite-select">Invite
          <select className="input" value={invite.id} onChange={e => setSelected(e.target.value)}>
            {invites.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
          </select>
          <span className="qr-share-note">Only you see invite names.</span>
        </label>}
      </div>
      <div className="qr-footer">{footer}</div>
    </div>}
  </>;
}
