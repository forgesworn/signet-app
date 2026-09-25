import { useEffect, useRef, useState } from 'react';
import { parseBotAuthRequest, type BotAuthSelection } from '../lib/bot-auth';
import type { AuthRequest } from '../lib/qr-router';
import { QRScanner } from './QRScanner';

export function BotSignIn({ pubkey, label, onApprove }: {
  pubkey: string; label: string;
  onApprove(selection: BotAuthSelection, request: AuthRequest, current: () => boolean): Promise<void>;
}) {
  const [scanning, setScanning] = useState(false), [paste, setPaste] = useState('');
  const [request, setRequest] = useState<AuthRequest | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const epoch = useRef(0), pending = useRef(false);
  useEffect(() => () => { epoch.current++; }, [pubkey]);
  const scan = (raw: string) => {
    if (pending.current) return;
    setScanning(false); setError(''); setDone(false); setRequest(null);
    try { setRequest(parseBotAuthRequest(raw)); setPaste(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Invalid sign-in QR'); }
  };
  return <section aria-label="Bot sign-in">
    <p>Sign in as {label} · Bot</p>
    {request ? <>
      <p>Request from <strong>{new URL(request.origin).origin}</strong></p>
      <p>This shares the bot’s public key and a sign-in proof. It grants no ongoing signing access.</p>
      <p style={{ overflowWrap: 'anywhere' }}>{pubkey}</p>
      <button className="btn btn-primary" disabled={busy} onClick={async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        const version = epoch.current, current = () => epoch.current === version;
        try {
          await onApprove({ source: 'bot', botPubkey: pubkey }, { ...request }, current);
          if (current()) { setDone(true); setRequest(null); }
        } catch (e) { if (current()) setError(e instanceof Error ? e.message : 'Bot sign-in failed'); }
        finally { pending.current = false; if (current()) setBusy(false); }
      }}>Approve bot sign-in</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => { epoch.current++; setRequest(null); setError(''); }}>Decline</button>
    </> : <>
      {scanning && <QRScanner active compact onScan={scan} />}
      <button className="btn btn-primary" onClick={() => setScanning(value => !value)}>{scanning ? 'Stop camera' : 'Scan bot sign-in QR'}</button>
      <textarea className="input" aria-label="Paste bot sign-in QR" value={paste} onChange={e => setPaste(e.target.value)} />
      <button className="btn btn-secondary" disabled={!paste.trim()} onClick={() => scan(paste.trim())}>Review bot sign-in</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {done && <p role="status">Bot sign-in delivered.</p>}
  </section>;
}
