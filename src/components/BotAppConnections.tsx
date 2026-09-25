import { useEffect, useRef, useState } from 'react';
import { loadBotAppGrants, type BotAppGrant } from '../lib/bot-app-grants';
import { parseNostrConnectURI, type NostrConnectRequest } from '../lib/nip46';

export interface BotAppConnectionActions {
  connect(bot: string, request: NostrConnectRequest, kinds: number[], duration: number, current: () => boolean): Promise<void>;
  revoke(id: string, current: () => boolean): Promise<void>;
}
const KINDS = [[1, 'Write notes'], [7, 'React to posts'], [0, 'Update the bot profile'], [5, 'Request deletion of bot posts'], [42, 'Write channel messages']] as const;
export function BotAppConnections({ root, encryptionKey, botPubkey, label, version, actions }: {
  root: string; encryptionKey: string; botPubkey: string; label: string; version: number; actions: BotAppConnectionActions;
}) {
  const [grants, setGrants] = useState<BotAppGrant[]>([]), [raw, setRaw] = useState('');
  const [request, setRequest] = useState<NostrConnectRequest | null>(null), [kinds, setKinds] = useState<number[]>([]);
  const [duration, setDuration] = useState(86400), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const epoch = useRef(0), running = useRef(false);
  useEffect(() => () => { epoch.current++; }, [root, encryptionKey, botPubkey]);
  useEffect(() => {
    let active = true;
    void loadBotAppGrants(root, encryptionKey).then(rows => { if (active) setGrants(rows.filter(g => g.botPubkey === botPubkey)); })
      .catch(() => { if (active) setMessage('Could not open bot app permissions.'); });
    return () => { active = false; };
  }, [root, encryptionKey, botPubkey, version]);
  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (running.current) return;
    const value = epoch.current, current = () => epoch.current === value;
    running.current = true; setBusy(true); setMessage('');
    try { await work(current); if (current()) setGrants((await loadBotAppGrants(root, encryptionKey)).filter(g => g.botPubkey === botPubkey)); }
    catch (error) { if (current()) setMessage(error instanceof Error ? error.message : 'Bot app permission failed'); }
    finally { running.current = false; if (current()) setBusy(false); }
  };
  return <section aria-label={`Apps for ${label} · Bot`}>
    <h3>Connected apps</h3>
    <p>These permissions apply only to this bot, while Signet is unlocked on this device. Restoring your recovery words requires connecting apps again.</p>
    {grants.map(grant => <div key={grant.id}>
      <strong>{grant.appName}</strong>
      <p>{grant.revokedAt !== undefined ? 'Revoked' : grant.expiresAt <= Date.now() / 1000 ? 'Expired' : `Expires ${new Date(grant.expiresAt * 1000).toLocaleString()}`}</p>
      <p>{grant.eventKinds.map(kind => KINDS.find(([id]) => id === kind)?.[1] ?? `Event kind ${kind}`).join(', ')}</p>
      {grant.revokedAt === undefined && <button className="btn btn-secondary" disabled={busy} onClick={() => void run(current => actions.revoke(grant.id, current))}>Revoke {grant.appName}</button>}
    </div>)}
    {!request ? <>
      <label>Bot app connection QR text<textarea className="input" value={raw} disabled={busy} onChange={event => setRaw(event.target.value)} /></label>
      <button className="btn btn-secondary" disabled={busy || !raw.trim()} onClick={() => {
        const parsed = parseNostrConnectURI(raw.trim());
        if (!parsed) { setMessage('Paste a valid nostrconnect app connection QR.'); return; }
        setRequest(parsed); setKinds([]); setRaw(''); setMessage('');
      }}>Review bot app permissions</button>
    </> : <>
      <p>Connect {request.appName} as <strong>{label} · Bot</strong>?</p>
      <p>App labels are supplied by the requesting app. Check the client key before approving.</p>
      <p style={{ overflowWrap: 'anywhere' }}>{request.clientPubkey}</p>
      <p style={{ overflowWrap: 'anywhere' }}>{request.relayUrl}</p>
      <p>Choose actions the app may perform without asking again. Reading messages and sharing owner credentials are not included.</p>
      {KINDS.map(([kind, name]) => <label key={kind} style={{ display: 'block' }}><input type="checkbox" checked={kinds.includes(kind)} disabled={busy}
        onChange={event => setKinds(values => event.target.checked ? [...values, kind] : values.filter(value => value !== kind))} /> {name}</label>)}
      <label>Bot app permission duration<select className="input" value={duration} disabled={busy} onChange={event => setDuration(Number(event.target.value))}>
        <option value={3600}>One hour</option><option value={86400}>One day</option><option value={604800}>One week</option>
      </select></label>
      <button className="btn btn-primary" disabled={busy || kinds.length === 0} onClick={() => void run(async current => {
        await actions.connect(botPubkey, request, kinds, duration, current);
        if (current()) { setRequest(null); setMessage('Bot app connected.'); }
      })}>Allow selected bot actions</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => { setRequest(null); setKinds([]); }}>Cancel bot connection</button>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
