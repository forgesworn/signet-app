import { useState } from 'react';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { sanitizeDisplayName } from '../lib/text-sanitize';

/**
 * D6 — the paired-child branch of the contact-invite intake. Scanning or
 * opening a contact-invite QR/link on a paired-child install never connects
 * directly (that always requires the guardian's own key material); instead
 * it offers to ask the guardian to connect on the child's behalf, using
 * whichever owned persona is currently selected. The caller is responsible
 * for never offering the dormant real identity as that persona.
 */
export function ChildContactAsk({ invite, personaLabel, guardianName, onAsk, onBack }: {
  invite: ContactInvite;
  /** Null while this device has no owned, non-dormant persona to ask with. */
  personaLabel: string | null; guardianName: string | null;
  onAsk(): Promise<'sent' | 'full'>;
  onBack(): void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'full'>('idle');
  const [error, setError] = useState<string | null>(null);
  const guardian = sanitizeDisplayName(guardianName || 'your guardian', 64) || 'your guardian';
  const caption = invite.caption ? sanitizeDisplayName(invite.caption, 100) : '';
  const ask = async () => {
    setState('busy'); setError(null);
    try { setState(await onAsk()); }
    catch (cause) { setError((cause instanceof Error ? cause.message : 'Unable to send this request').slice(0, 160)); setState('idle'); }
  };
  if (state === 'sent') {
    return <div className="stack" style={{ padding: 16 }}>
      <h2>Request sent</h2>
      <p>{guardian} will review this request.</p>
      <button className="btn btn-primary" onClick={onBack}>Done</button>
    </div>;
  }
  return <div className="stack" style={{ padding: 16 }}>
    <h2>Ask to connect</h2>
    {caption && <p><strong>{caption}</strong></p>}
    {personaLabel
      ? <p className="field-hint">You'll ask {guardian} to connect using {personaLabel}.</p>
      : <p role="status" className="field-hint">Waiting for {guardian} to share your personas with this device.</p>}
    {state === 'full' && <p role="alert" className="field-hint">
      You already have too many requests waiting. Wait for {guardian} to review one before asking again.
    </p>}
    {error && <p role="alert" className="field-hint">{error}</p>}
    <div style={{ display: 'flex', gap: 8 }}>
      <button className="btn btn-primary" disabled={state === 'busy' || !personaLabel} onClick={() => { void ask(); }}>Ask {guardian} to connect</button>
      <button className="btn btn-ghost" disabled={state === 'busy'} onClick={onBack}>Cancel</button>
    </div>
  </div>;
}
