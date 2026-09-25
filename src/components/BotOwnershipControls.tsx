import { useEffect, useState } from 'react';
import { readBotOwnership, type BotOwnershipResult } from 'signet-protocol/experimental';
import type { BotRecord } from '../lib/bot-registry';
export function BotOwnershipControls({ bot, busy, onAction }: {
  bot: BotRecord; busy: boolean; onAction(action: 'create' | 'publish' | 'revoke', days: number): void;
}) {
  const [result, setResult] = useState<BotOwnershipResult>(), [days, setDays] = useState(30), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let current = true;
    if (!bot.ownership) { setResult(undefined); return; }
    const read = () => { void readBotOwnership(bot.ownership!.event, { ownerPubkey: bot.ownerPersona, botPubkey: bot.publicKey,
      now: Math.floor(Date.now() / 1000) }).then(value => { if (current) setResult(value); }); };
    read(); const timer = setInterval(read, 60000);
    return () => { current = false; clearInterval(timer); };
  }, [bot]);
  return <div>
    <p>{!bot.ownership ? 'No ownership link signed' : result?.status === 'revoked' ? 'Ownership revoked'
      : result?.status === 'lapsed' ? 'Ownership not currently verified — expired'
      : result?.status === 'invalid' ? 'Ownership link could not be verified'
      : bot.ownership.publishRequested ? bot.ownership.publishedEventId === bot.ownership.event.id ? 'Ownership published' : 'Ownership waiting to publish'
      : 'Ownership private'}</p>
    {(result?.status === 'valid' || result?.status === 'lapsed') && <p>Expires {new Date(result.claim.expiresAt * 1000).toLocaleDateString()}</p>}
    <label htmlFor={`bot-days-${bot.publicKey}`}>Ownership lifetime</label>
    <select id={`bot-days-${bot.publicKey}`} className="input" value={days} disabled={busy} onChange={event => setDays(Number(event.target.value))}>
      {[1, 7, 30, 60, 90].map(value => <option key={value} value={value}>{value} days</option>)}
    </select>
    <p>Ownership gives this bot none of your trust. Existing links renew automatically; a Heartwood asks you to approve each signature.</p>
    <button className="btn btn-secondary" disabled={busy} onClick={() => onAction('create', days)}>{bot.ownership ? 'Replace ownership link' : 'Create private ownership link'}</button>
    {bot.ownership && !bot.ownership.publishRequested && result?.status === 'valid' && <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirm(true)}>Publish ownership</button>}
    {confirm && <div>
      <p>This publicly links {bot.label} · Bot to its owner persona. Renewals and revocation will also be published. Copies may remain with others.</p>
      <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel publication</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => { setConfirm(false); onAction('publish', days); }}>Confirm publication</button>
    </div>}
    {bot.ownership && result?.status !== 'revoked' && <button className="btn btn-secondary" disabled={busy} onClick={() => onAction('revoke', days)}>Revoke ownership</button>}
  </div>;
}
