import { useState } from 'react';
import type { BotMetadata } from '../hooks/useBotInventory';
import type { CarouselColumn } from '../types';
import { buildContactQR } from '../lib/contact-qr';
import { QRCode } from './QRCode';
import { BotSignIn } from './BotSignIn';
import type { ComponentProps } from 'react';
export function BotCarouselCard({ bot, col, onOpen, onHide, onSignIn }: {
  bot: BotMetadata; col: CarouselColumn; onOpen(contacts: boolean): void; onHide(): Promise<void>;
  onSignIn?: ComponentProps<typeof BotSignIn>['onApprove'];
}) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const label = `${bot.label} · Bot`;
  return <div className="card section" style={{ margin: 16 }}>
    <h2>{label}</h2>
    {col === 0 && <><p>Bot identity</p><p style={{ overflowWrap: 'anywhere' }}>{bot.publicKey}</p><p>This bot has its own trust, separate from its owner.</p></>}
    {col === 1 && <><QRCode data={buildContactQR({ pubkey: bot.publicKey, name: label })} /><p>Share this bot’s public key.</p></>}
    {col === 2 && <><p>Contacts for {label}</p><button className="btn btn-primary" onClick={() => onOpen(true)}>View bot contacts</button></>}
    {col === 3 && <><button className="btn btn-primary" onClick={() => onOpen(false)}>Manage bot</button>
      <button className="btn btn-secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); try { await onHide(); } catch { setError('Could not hide this bot.'); } finally { setBusy(false); }
      }}>Hide bot from carousel</button></>}
    {col === 4 && (onSignIn ? <BotSignIn key={bot.publicKey} pubkey={bot.publicKey} label={bot.label} onApprove={onSignIn} />
      : <><p>Camera signing for bots is not available yet.</p><button className="btn btn-secondary" onClick={() => onOpen(false)}>Manage bot keys</button></>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
