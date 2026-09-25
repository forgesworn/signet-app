import { parsePubkeyInput } from '../lib/pubkey-input';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { QRCode } from '../components/QRCode';
import { contactInviteLink, parseContactInviteLink } from '../lib/contact-invite-link';
import { useEffect, useRef, useState } from 'react';
import { contactVerificationWords } from '@forgesworn/signet-contacts';
import type { ContactExchangeState } from '@forgesworn/signet-contacts';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { conflictedContactExchanges } from '../lib/contact-invite-store';
import type { ContactInviteVault } from '../lib/contact-invite-store';

export function ContactInvites({ service, identityPubkey, identityName, relays, version, initialInvite,
  onAddContact, onBack, onApproveContact }: { service: ContactInviteService; identityPubkey: string; identityName: string;
  relays: string[]; version: number; initialInvite?: string;
  onAddContact(exchange: ContactExchangeState): Promise<void>; onBack(): void;
  onApproveContact?(peer: string): Promise<void> }) {
  const [state, setState] = useState<ContactInviteVault | null>(null);
  const [heardWords, setHeardWords] = useState<Record<string, string>>({});
  const [qrInvite, setQrInvite] = useState<string | null>(null);
  const [name, setName] = useState('My contact card');
  const [publicCaption, setPublicCaption] = useState(''), [shareCaption, setShareCaption] = useState(false);
  const [intendedRecipient, setIntendedRecipient] = useState('');
  const [allowDifferent, setAllowDifferent] = useState<Record<string, boolean>>({});
  const [expiryDays, setExpiryDays] = useState(0);
  const [mode, setMode] = useState<'standing' | 'single-use'>('standing');
  const [incoming, setIncoming] = useState(initialInvite ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void service.read().then(value => { if (!cancelled) setState(value); }).catch(() => { if (!cancelled) setError('Could not load private invites.'); });
    return () => { cancelled = true; };
  }, [service, version]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); const value = await service.read(); if (mounted.current) setState(value); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The invite could not be updated.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const now = () => Math.floor(Date.now() / 1000);
  const invites = state?.invites.filter(i => i.identityPubkey === identityPubkey) ?? [];
  const arrivals = state?.arrivals.filter(a => a.identityPubkey === identityPubkey && a.dismissedAt === undefined && a.channel !== 'exchange') ?? [];
  const exchanges = state?.exchanges.filter(e => (e.role === 'requester' ? e.request.from : e.request.to) === identityPubkey) ?? [];
  return <div style={{ padding: 16 }}>
    <h2>Invites for {identityName}</h2>
    <p>Only people with an active invite can send a request. Invite names stay private.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label>Private invite name<input className="input" value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>
    <label><input type="checkbox" checked={shareCaption} onChange={event => setShareCaption(event.target.checked)} /> Include a public caption</label>
    {shareCaption && <label>Public caption — anyone with the invite can read this<input className="input" value={publicCaption} maxLength={200} onChange={event => setPublicCaption(event.target.value)} /></label>}
    <label>Invite use<select className="input" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
      <option value="standing">Standing — reusable until switched off</option><option value="single-use">Single-use — one request</option>
    </select></label>
    {mode === 'single-use' && <label>Intended recipient public key (optional)<input className="input" value={intendedRecipient} onChange={e => setIntendedRecipient(e.target.value)} placeholder="npub or hex" /></label>}
    <label>Invite expiry<select className="input" value={expiryDays} onChange={e => setExpiryDays(Number(e.target.value))}>
      <option value={0}>No expiry</option><option value={1}>One day</option><option value={7}>One week</option><option value={30}>Thirty days</option>
    </select></label>
    <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void run(() => {
      const intended = mode === 'single-use' && intendedRecipient.trim() ? parsePubkeyInput(intendedRecipient.trim()) : undefined;
      if (intended && 'error' in intended) throw new Error(intended.error);
      return service.create(identityPubkey, name, relays, mode, now(), expiryDays ? now() + expiryDays * 86400 : undefined,
        shareCaption ? publicCaption : undefined, intended?.hex);
    })}>Create invite</button>
    <ul>{invites.map(invite => <li key={invite.id} style={{ marginBlock: 12 }}>
      <strong>{invite.name}</strong> · {invite.invite.expiresAt && invite.invite.expiresAt <= now() ? 'Expired' : invite.mode === 'single-use' && state?.arrivals.some(a => a.inviteId === invite.id) ? 'Used' : invite.enabled ? 'On' : 'Off'} · {state?.arrivals.filter(a => a.inviteId === invite.id).length ?? 0} requests
      <div><button className="btn btn-secondary" disabled={busy} onClick={() => void run(async () => {
        const link = contactInviteLink(invite.invite, window.location.origin);
        await navigator.clipboard.writeText(link); setNotice('Invite link copied.');
      })}>Copy invite link</button>
      <button className="btn btn-secondary" onClick={() => setQrInvite(qrInvite === invite.id ? null : invite.id)}>Show invite QR</button>
      {qrInvite === invite.id && <QRCode data={contactInviteLink(invite.invite, window.location.origin)} size={260} />}
      <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => service.setEnabled(invite.id, !invite.enabled, now()))}>{invite.enabled ? 'Switch off' : 'Switch on'}</button></div>
    </li>)}</ul>
    <h3>Received an invite?</h3>
    <label>Invite link<textarea className="input" value={incoming} onChange={e => setIncoming(e.target.value)} /></label>
    <button className="btn btn-secondary" disabled={busy || !incoming.trim()} onClick={() => void run(async () => {
      const invite = parseContactInviteLink(incoming, now());
      if (!invite) throw new Error('This invite is invalid or has expired.');
      if (onApproveContact) await onApproveContact(invite.recipient);
      await service.request(identityPubkey, invite, now()); setIncoming(''); setNotice('Request queued.');
      await service.flush(now());
    })}>{onApproveContact ? 'Approve and send contact request' : 'Send contact request'}</button>
    {onApproveContact && <p>Approving adds this public key to the dependant’s approved contacts. Requests stay pending until you approve them.</p>}
    <h3>Requests ({arrivals.length})</h3>
    <button className="btn btn-secondary" disabled={busy || !arrivals.some(a => !a.request)} onClick={() => void run(() => service.openInbox(now(), false, identityPubkey))}>Open request list</button>
    <p>Opening requests uses this identity’s signer. Up to 32 attempts are allowed per unlock.</p>
    {arrivals.map(a => {
      const intended = invites.find(i => i.id === a.inviteId)?.intendedPubkey;
      const different = !!(a.request && intended && a.request.from !== intended);
      return <div key={a.id} style={{ marginBlock: 12 }}>
      <p>{a.request ? `Request from ${a.request.from.slice(0, 12)}…` : 'Unopened contact request'}</p>
      {different && <><p role="alert">This request is from a different public key than the intended recipient.</p>
        <label><input type="checkbox" checked={!!allowDifferent[a.id]} onChange={event => setAllowDifferent(old => ({ ...old, [a.id]: event.target.checked }))} /> Accept this different contact</label></>}
      {a.request && <button className="btn btn-primary" disabled={busy || (different && !allowDifferent[a.id])} onClick={() => void run(async () => { if (onApproveContact) await onApproveContact(a.request!.from); await service.accept(a.id, now(), different && allowDifferent[a.id]); await service.flush(now()); })}>{onApproveContact ? 'Approve and accept request' : 'Accept request'}</button>}
      <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => service.dismiss(a.id, now()))}>Decline silently</button>
    </div>; })}
    <h3>Connections</h3>
    {exchanges.map(exchange => {
      const exchangeId = contactExchangeKey(exchange.request);
      const peer = exchange.role === 'requester' ? exchange.request.to : exchange.request.from;
      const conflicted = !!state && conflictedContactExchanges(state).has(exchangeId);
      if (conflicted) return <p key={exchangeId}>This exchange was accepted differently on two devices. Its transcripts are saved privately. Start a new request to compare words again.</p>;
      const words = exchange.phase === 'complete' && exchange.acceptance && exchange.reveal
        ? contactVerificationWords(exchange.request, exchange.acceptance, exchange.reveal, identityPubkey) : null;
      return <div key={exchangeId} style={{ marginBlock: 16 }}>
        <p>{peer.slice(0, 12)}… · {exchange.phase === 'complete' ? exchange.wordsConfirmedAt ? `Words checked ${new Date(exchange.wordsConfirmedAt * 1000).toLocaleDateString()}` : 'Connected — words not checked' : exchange.phase === 'declined' ? 'Cancelled' : exchange.request.expiresAt <= now() ? 'Expired' : 'Waiting for the exchange to finish'}</p>
        {!words && exchange.phase !== 'declined' && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => service.cancel(exchangeId))}>Cancel request silently</button>}
        {words && <><p>You say: <strong>{words.youSay}</strong></p><p>They say: <strong>{words.theySay}</strong></p>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => navigator.clipboard.writeText(words.youSay))}>Copy my words</button>
          {!exchange.wordsConfirmedAt && <div>
            <label>Words they told you<input className="input" value={heardWords[exchangeId] ?? ''} maxLength={200}
              onChange={event => setHeardWords(old => ({ ...old, [exchangeId]: event.target.value }))} /></label>
            <button className="btn btn-secondary" disabled={busy || !heardWords[exchangeId]?.trim()}
              onClick={() => void run(() => service.confirmWords(exchangeId, heardWords[exchangeId], now()))}>Confirm their words</button>
          </div>}
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { await onAddContact(exchange); setNotice('Contact opened.'); })}>Open contact</button>
        </>}
      </div>;
    })}
    <button className="btn btn-ghost" onClick={onBack}>Back to contacts</button>
  </div>;
}
