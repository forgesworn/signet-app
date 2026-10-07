import { useEffect, useRef, useState } from 'react';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';
import { sanitizeDisplayName } from '../lib/text-sanitize';
import { ContactCardPhotoError, defaultCardChoice } from '../lib/contact-card-share';
import type { ContactCardChoice, ContactCardInfo } from '../lib/contact-card-share';
import { ShareCardChips } from '../components/ShareCardChips';
import { CARD_PHOTO_FAILED_COPY, SEND_WITHOUT_PHOTO_LABEL } from '../lib/contacts-v2-copy';

/** A scanned or pasted contact invite: choose who it comes from, then send. */
export function ContactInviteSend({ invite, personas, defaultPersona, ownPubkeys, cardInfoFor, onSend, onDone, onCancel }: {
  invite: ContactInvite;
  personas: { pubkey: string; label: string }[];
  defaultPersona: string;
  ownPubkeys: string[];
  /** What the "They'll see:" chips offer for a persona; null (or absent) hides them. */
  cardInfoFor?(persona: string): ContactCardInfo | null;
  /** `card` is set only when chips are shown. It may reject with `ContactCardPhotoError` when the photo cannot be shared. */
  onSend(persona: string, card?: ContactCardChoice): Promise<void>;
  onDone(): void;
  onCancel(): void;
}) {
  const [persona, setPersona] = useState(() => personas.some(p => p.pubkey === defaultPersona) ? defaultPersona : personas[0]?.pubkey ?? '');
  const [sending, setSending] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  const [choices, setChoices] = useState<Record<string, ContactCardChoice>>({});
  const [photoFailed, setPhotoFailed] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const own = ownPubkeys.includes(invite.recipient);
  const caption = invite.caption ? sanitizeDisplayName(invite.caption, 80) : '';
  const npub = isValidHexKey(invite.recipient) ? encodeNpub(hexToBytes(invite.recipient)) : invite.recipient;
  const to = caption || `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  const from = personas.find(p => p.pubkey === persona)?.label ?? '';

  const info = cardInfoFor?.(persona) ?? null;
  const choice = info ? choices[persona] ?? defaultCardChoice(info) : null;

  const send = async (withPhoto = true) => {
    if (inFlight.current || !persona) return;
    inFlight.current = true; setSending(true); setError(''); setPhotoFailed(false);
    try {
      if (info && choice) await onSend(persona, { name: choice.name && !!info.name, photo: withPhoto && choice.photo && info.hasPhoto });
      else await onSend(persona);
      if (mounted.current) setSent(true);
    }
    catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ContactCardPhotoError) { setPhotoFailed(true); setError(CARD_PHOTO_FAILED_COPY); }
      else setError(reason instanceof Error && reason.message ? reason.message : 'The request could not be sent.');
    }
    finally { inFlight.current = false; if (mounted.current) setSending(false); }
  };

  return <div style={{ padding: 16 }}>
    <h2>Send a contact request</h2>
    <p>To: <strong>{to}</strong></p>
    {personas.length > 1
      ? <label>From<select className="input" value={persona} disabled={sending || sent} onChange={e => { setPersona(e.target.value); setPhotoFailed(false); setError(''); }}>
        {personas.map(p => <option key={p.pubkey} value={p.pubkey}>{p.label}</option>)}
      </select></label>
      : <p>From: <strong>{from}</strong></p>}
    {own && <p role="alert">This is your own invite.</p>}
    {info && choice && !sent && <ShareCardChips info={info} value={choice} disabled={sending}
      onChange={next => { setChoices(old => ({ ...old, [persona]: next })); setPhotoFailed(false); }} />}
    {error && <p role="alert">{error}</p>}
    {sent
      ? <>
        <p role="status">Request sent. You&apos;ll both be added once they accept.</p>
        <button className="btn btn-primary" onClick={onDone}>Done</button>
      </>
      : <>
        {!own && <button className="btn btn-primary" disabled={sending || !persona} onClick={() => void send()}>{sending ? 'Sending…' : 'Send request'}</button>}
        {!own && photoFailed && <button className="btn btn-secondary" disabled={sending} onClick={() => void send(false)}>{SEND_WITHOUT_PHOTO_LABEL}</button>}
        <button className="btn btn-ghost" disabled={sending} onClick={onCancel}>Cancel</button>
      </>}
  </div>;
}
