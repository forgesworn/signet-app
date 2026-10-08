import { parsePubkeyInput } from '../lib/pubkey-input';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { QRCode } from '../components/QRCode';
import { contactInviteLink, contactInviteOrigin, parseContactInviteLink } from '../lib/contact-invite-link';
import { useEffect, useRef, useState } from 'react';
import { contactVerificationWords } from '@forgesworn/signet-contacts';
import type { ContactCard, ContactExchangeState } from '@forgesworn/signet-contacts';
import { ContactCardPhotoError, defaultCardChoice } from '../lib/contact-card-share';
import type { ContactCardChoice, ContactCardInfo } from '../lib/contact-card-share';
import { ShareCardChips } from '../components/ShareCardChips';
import { shortNpub } from '../lib/nostr-follows';
import { ACCEPT_WITHOUT_PHOTO_LABEL, CARD_PHOTO_FAILED_COPY, requestFromNamedCopy } from '../lib/contacts-v2-copy';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { conflictedContactExchanges } from '../lib/contact-invite-store';
import type { ContactInviteVault } from '../lib/contact-invite-store';

export function ContactInvites({ service, identityPubkey, identityName, relays, version, initialInvite,
  onAddContact, onBack, onApproveContact, cards }: { service: ContactInviteService; identityPubkey: string; identityName: string;
  relays: string[]; version: number; initialInvite?: string;
  onAddContact(exchange: ContactExchangeState): Promise<void>; onBack(): void;
  onApproveContact?(peer: string): Promise<void>;
  /** "They'll see:" on an opened request. Absent (a paired child, a dependant's list) means no chips and no card.
   * `build` uploads the share copy and publishes its pointer, so it runs only when Accept is pressed. */
  cards?: { infoFor(persona: string): ContactCardInfo | null; build(persona: string, choice: ContactCardChoice): Promise<ContactCard | undefined> } }) {
  const [state, setState] = useState<ContactInviteVault | null>(null);
  const [heardWords, setHeardWords] = useState<Record<string, string>>({});
  const [qrInvite, setQrInvite] = useState<string | null>(null);
  const [name, setName] = useState('My contact card');
  const [publicCaption, setPublicCaption] = useState(''), [shareCaption, setShareCaption] = useState(false);
  const [intendedRecipient, setIntendedRecipient] = useState('');
  const [allowDifferent, setAllowDifferent] = useState<Record<string, boolean>>({});
  const [cardChoices, setCardChoices] = useState<Record<string, ContactCardChoice>>({});
  const [photoFailed, setPhotoFailed] = useState<Record<string, boolean>>({});
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
  const accept = (arrivalId: string, request: NonNullable<ContactInviteVault['arrivals'][number]['request']>, different: boolean, withPhoto: boolean) => void run(async () => {
    const info = cards?.infoFor(request.to) ?? null;
    // The card is built by the service AFTER its pre-checks pass (M3), so a
    // refused accept never uploads a photo or publishes a pointer.
    let card: (() => Promise<ContactCard | undefined>) | undefined;
    if (cards && info) {
      const base = cardChoices[arrivalId] ?? defaultCardChoice(info);
      card = async () => {
        try { return await cards.build(request.to, { name: base.name && !!info.name, photo: withPhoto && base.photo && info.hasPhoto }); }
        catch (reason) {
          if (reason instanceof ContactCardPhotoError) { setPhotoFailed(old => ({ ...old, [arrivalId]: true })); throw new Error(CARD_PHOTO_FAILED_COPY); }
          throw reason;
        }
      };
    }
    setPhotoFailed(old => ({ ...old, [arrivalId]: false }));
    if (onApproveContact) await onApproveContact(request.from);
    await service.accept(arrivalId, now(), different, false, card); await service.flush(now());
  });
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
        const link = contactInviteLink(invite.invite, contactInviteOrigin());
        await navigator.clipboard.writeText(link); setNotice('Invite link copied.');
      })}>Copy invite link</button>
      <button className="btn btn-secondary" onClick={() => setQrInvite(qrInvite === invite.id ? null : invite.id)}>Show invite QR</button>
      {qrInvite === invite.id && <QRCode data={contactInviteLink(invite.invite, contactInviteOrigin())} size={260} />}
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
      {a.request?.card?.name
        ? <><p>{requestFromNamedCopy(a.request.card.name)}</p><p>{shortNpub(a.request.from)}</p></>
        : <p>{a.request ? `Request from ${a.request.from.slice(0, 12)}…` : 'Unopened contact request'}</p>}
      {different && <><p role="alert">This request is from a different public key than the intended recipient.</p>
        <label><input type="checkbox" checked={!!allowDifferent[a.id]} onChange={event => setAllowDifferent(old => ({ ...old, [a.id]: event.target.checked }))} /> Accept this different contact</label></>}
      {a.request && (() => {
        const info = cards?.infoFor(a.request.to) ?? null;
        return info ? <ShareCardChips info={info} value={cardChoices[a.id] ?? defaultCardChoice(info)} disabled={busy}
          onChange={next => { setCardChoices(old => ({ ...old, [a.id]: next })); setPhotoFailed(old => ({ ...old, [a.id]: false })); }} /> : null;
      })()}
      {a.request && <button className="btn btn-primary" disabled={busy || (different && !allowDifferent[a.id])} onClick={() => accept(a.id, a.request!, different && !!allowDifferent[a.id], true)}>{onApproveContact ? 'Approve and accept request' : 'Accept request'}</button>}
      {a.request && photoFailed[a.id] && <button className="btn btn-secondary" disabled={busy || (different && !allowDifferent[a.id])} onClick={() => accept(a.id, a.request!, different && !!allowDifferent[a.id], false)}>{ACCEPT_WITHOUT_PHOTO_LABEL}</button>}
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
