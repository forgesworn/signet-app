import { BotContacts } from './BotContacts';
import type { SignetIdentity } from '../types';
import { BotOwnershipControls } from '../components/BotOwnershipControls';
import { useEffect, useRef, useState } from 'react';
import type { BotRecord, BotRegistry } from '../lib/bot-registry';
import { loadBotRegistry, updateBotRegistry } from '../lib/bot-registry';
import { BotAppConnections, type BotAppConnectionActions } from '../components/BotAppConnections';
export function Bots({ root, encryptionKey, personas, version, onCreate, onExport, onOwnership, onChanged, identity, deviceId, relayUrl, initialContactsBot, appConnections }: {
  appConnections?: BotAppConnectionActions;
  initialContactsBot?: string;
  identity: SignetIdentity; deviceId: string; relayUrl: string;
  root: string; encryptionKey: string; personas: { publicKey: string; displayName: string }[]; version: number;
  onCreate(input: { ownerPersona: string; label: string; source: BotRecord['source']; importedKey?: string }): Promise<void>;
  onExport(publicKey: string): Promise<void>; onChanged(): void;
  onOwnership(publicKey: string, action: 'create' | 'publish' | 'revoke', days: number): Promise<void>;
}) {
  const [registry, setRegistry] = useState<BotRegistry>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(personas[0]?.publicKey ?? ''), [label, setLabel] = useState('');
  const [source, setSource] = useState<BotRecord['source']>('derived'), [importedKey, setImportedKey] = useState('');
  const [contactsBot, setContactsBot] = useState<string | undefined>(initialContactsBot);
  const [removing, setRemoving] = useState<string>();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void loadBotRegistry(root, encryptionKey).then(value => { if (current) setRegistry(value); })
      .catch(() => { if (current) setError('Could not open your bots.'); });
    return () => { current = false; };
  }, [root, encryptionKey, version]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await action();
      if (active.current) { setRegistry(await loadBotRegistry(root, encryptionKey)); onChanged(); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Could not save this bot.'); }
    finally { if (active.current) setBusy(false); }
  };
  const update = (change: (value: BotRegistry) => BotRegistry) => updateBotRegistry(root, encryptionKey, value => {
    if (!active.current) throw new Error('Bot session changed');
    return change(value);
  });
  const selectedBot = registry?.bots.find(bot => bot.publicKey === contactsBot && bot.removedAt === undefined);
  if (selectedBot) return <BotContacts key={selectedBot.publicKey} bot={selectedBot} identity={identity} deviceId={deviceId}
    encryptionKey={encryptionKey} relayUrl={relayUrl} version={version} onChanged={onChanged} onBack={() => setContactsBot(undefined)} />;
  return <div className="section">
    <p>Bots have their own keys and trust. Each bot belongs to one of your personas.</p>
    <p>Creating a bot does not publish an ownership link.</p>
    {error && <p role="alert">{error}</p>}
    {!registry ? <p>Opening bots…</p> : <>
      <label><input type="checkbox" checked={registry.showNew} disabled={busy} onChange={event => {
        const showNew = event.target.checked;
        void run(() => update(value => ({ ...value, showNew, preferenceUpdatedAt: Math.floor(Date.now() / 1000) })));
      }} /> Show new bots in the carousel</label>
      {registry.bots.filter(bot => bot.removedAt === undefined).map(bot => <section className="card" key={bot.publicKey}>
        <h2>{bot.label} · Bot</h2>
        <p>Owner: {personas.find(p => p.publicKey === bot.ownerPersona)?.displayName ?? 'Persona not available on this device'}</p>
        <p>{bot.source === 'derived' ? `Recovery-derived · ${bot.derivationName}` : bot.privateKey
          ? 'Separate key — export and keep a backup' : 'Key unavailable — import your original backup on this device'}</p>
        <p style={{ overflowWrap: 'anywhere' }}>{bot.publicKey}</p>
        {bot.privateKey && <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => onExport(bot.publicKey))}>Copy bot recovery key</button>}
        <button className="btn btn-secondary" disabled={busy || !deviceId} onClick={() => setContactsBot(bot.publicKey)}>View bot contacts</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => update(value => ({ ...value,
          bots: value.bots.map(row => row.publicKey === bot.publicKey ? { ...row, hidden: !row.hidden, updatedAt: Math.floor(Date.now() / 1000) } : row) }))) }>{bot.hidden ? 'Show bot in carousel' : 'Hide bot from carousel'}</button>
        <BotOwnershipControls bot={bot} busy={busy} onAction={(action, days) => { void run(() => onOwnership(bot.publicKey, action, days)); }} />
        {appConnections && <BotAppConnections root={root} encryptionKey={encryptionKey} botPubkey={bot.publicKey} label={bot.label} version={version} actions={appConnections} />}
        <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(bot.publicKey)}>Remove bot</button>
        {removing === bot.publicKey && <div>
          <p>Remove {bot.label} from Signet? This does not stop the bot elsewhere or revoke published ownership.</p>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setRemoving(undefined)}>Cancel</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => {
            await update(value => ({ ...value, bots: value.bots.map(row => row.publicKey === bot.publicKey
              ? { ...row, removedAt: Math.floor(Date.now() / 1000), privateKey: undefined } : row) })); setRemoving(undefined);
          })}>Confirm removal</button>
        </div>}
      </section>)}
      <h2>Add a bot</h2>
      <form onSubmit={event => { event.preventDefault(); void run(async () => {
        await onCreate({ ownerPersona: owner, label, source, ...(source === 'imported' ? { importedKey } : {}) });
        setLabel(''); setImportedKey('');
      }); }}>
        <label htmlFor="bot-owner">Owner persona</label>
        <select id="bot-owner" className="input" value={owner} onChange={event => setOwner(event.target.value)}>{personas.map(persona => <option key={persona.publicKey} value={persona.publicKey}>{persona.displayName}</option>)}</select>
        <label htmlFor="bot-label">Bot name</label><input id="bot-label" className="input" value={label} maxLength={100} onChange={event => setLabel(event.target.value)} />
        <label htmlFor="bot-source">Bot key</label><select id="bot-source" className="input" value={source} onChange={event => { setSource(event.target.value as BotRecord['source']); setImportedKey(''); }}>
          <option value="derived">Derive from my recovery tree</option><option value="generated">Generate a separate key</option><option value="imported">Import a separate key</option>
        </select>
        {source === 'imported' && <><label htmlFor="bot-key">Bot private key (nsec or hex)</label><input id="bot-key" className="input" type="password" autoComplete="off" value={importedKey} onChange={event => setImportedKey(event.target.value)} /></>}
        {source !== 'derived' && <p>This key will not return from your recovery words. Keep a separate copy.</p>}
        <button className="btn btn-primary" disabled={busy || !owner || !label.trim()}>{busy ? 'Saving…' : 'Create bot'}</button>
      </form>
    </>}
  </div>;
}
