import { useEffect, useRef, useState } from 'react';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';
import { sanitizeDisplayName } from '../lib/text-sanitize';

/** A scanned or pasted contact invite: choose who it comes from, then send. */
export function ContactInviteSend({ invite, personas, defaultPersona, ownPubkeys, onSend, onDone, onCancel }: {
  invite: ContactInvite;
  personas: { pubkey: string; label: string }[];
  defaultPersona: string;
  ownPubkeys: string[];
  onSend(persona: string): Promise<void>;
  onDone(): void;
  onCancel(): void;
}) {
  const [persona, setPersona] = useState(() => personas.some(p => p.pubkey === defaultPersona) ? defaultPersona : personas[0]?.pubkey ?? '');
  const [sending, setSending] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const own = ownPubkeys.includes(invite.recipient);
  const caption = invite.caption ? sanitizeDisplayName(invite.caption, 80) : '';
  const npub = isValidHexKey(invite.recipient) ? encodeNpub(hexToBytes(invite.recipient)) : invite.recipient;
  const to = caption || `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  const from = personas.find(p => p.pubkey === persona)?.label ?? '';

  const send = async () => {
    if (inFlight.current || !persona) return;
    inFlight.current = true; setSending(true); setError('');
    try { await onSend(persona); if (mounted.current) setSent(true); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error && reason.message ? reason.message : 'The request could not be sent.'); }
    finally { inFlight.current = false; if (mounted.current) setSending(false); }
  };

  return <div style={{ padding: 16 }}>
    <h2>Send a contact request</h2>
    <p>To: <strong>{to}</strong></p>
    {personas.length > 1
      ? <label>From<select className="input" value={persona} disabled={sending || sent} onChange={e => setPersona(e.target.value)}>
        {personas.map(p => <option key={p.pubkey} value={p.pubkey}>{p.label}</option>)}
      </select></label>
      : <p>From: <strong>{from}</strong></p>}
    {own && <p role="alert">This is your own invite.</p>}
    {error && <p role="alert">{error}</p>}
    {sent
      ? <>
        <p role="status">Request sent. You&apos;ll both be added once they accept.</p>
        <button className="btn btn-primary" onClick={onDone}>Done</button>
      </>
      : <>
        {!own && <button className="btn btn-primary" disabled={sending || !persona} onClick={() => void send()}>{sending ? 'Sending…' : 'Send request'}</button>}
        <button className="btn btn-ghost" disabled={sending} onClick={onCancel}>Cancel</button>
      </>}
  </div>;
}
