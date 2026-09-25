import { useRef, useState } from 'react';
import type { PrivateVaultHealth } from '../hooks/usePrivateVaults';

export function PrivateVaultStatus({ health, importedDependants, onRotate }: {
  health: PrivateVaultHealth; importedDependants: number;
  onRotate?: (purpose: string) => Promise<string>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const running = useRef(false);
  const rotate = async (purpose: string) => {
    if (!onRotate || running.current) return;
    running.current = true; setBusy(purpose); setMessage('');
    try { setMessage(await onRotate(purpose)); }
    catch { setMessage('The backup key could not be changed. Your saved backups are retained. Try again after checking your connection.'); }
    finally { running.current = false; setBusy(null); }
  };
  const states = Object.values(health.datasets);
  const verified = states.filter(s => s.state === 'verified').length;
  const invalid = states.some(s => s.state === 'unusable');
  const unavailable = states.some(s => s.state === 'unavailable');
  const heading = health.phase === 'unsupported' ? 'Recovery-derived backups unavailable'
    : invalid ? 'A private backup needs attention'
    : health.phase === 'checking' ? 'Checking existing backups before migration'
    : health.phase === 'running' ? 'Checking private backups'
    : states.some(s => s.state === 'waiting-legacy') ? 'Waiting for existing backups before migration'
    : unavailable ? 'Private backups are waiting for a connection'
    : verified === states.length && verified > 0 ? `${verified} private datasets verified`
    : 'Private backup changes are waiting to upload';
  const confirmedAt = Math.max(0, ...states.map(s => s.confirmedAt ?? 0));
  return <details className="sync-backup-banner" style={{ padding: '8px 16px', fontSize: 13 }}>
    <summary>{heading}</summary>
    {health.phase === 'unsupported'
      ? <p>This identity needs its original Signet recovery tree or a compatible Heartwood connection for private vaults. Existing backup formats remain available.</p>
      : <p>Profiles, contacts, credentials and portable settings migrate separately after a complete encrypted copy is read back. Queued changes retry automatically while Signet is open.</p>}
    {invalid && <p>A backup could not be validated. Signet has paused replacement of that dataset and kept the local copy.</p>}
    {confirmedAt > 0 && <p>Last verified copy: {new Date(confirmedAt * 1000).toLocaleString()}.</p>}
    {states.length > 0 && <ul>{Object.entries(health.datasets).map(([purpose, status]) =>
      <li key={purpose} data-vault-purpose={purpose}>{purpose.replace('signet:vault:', '')}: {status.state === 'verified'
        ? `verified on ${status.confirmedRelays?.length ?? 0} relay(s)` : status.state}
        {status.rotation !== undefined && <span> · key version {status.rotation}</span>}
        {status.rotationPending !== undefined && <span> · key change unfinished</span>}
        {onRotate && (status.state === 'verified' || status.rotationPending !== undefined) && <button
          className="btn btn-ghost" disabled={busy !== null}
          aria-label={`${status.rotationPending !== undefined ? 'Resume key change for' : 'Change backup key for'} ${purpose.replace('signet:vault:', '')}`}
          onClick={() => void rotate(purpose)}>
          {busy === purpose ? 'Changing key…' : status.rotationPending !== undefined ? 'Resume key change' : 'Change backup key'}
        </button>}
      </li>)}</ul>}
    {onRotate && <p>Changing a backup key verifies a complete copy under the new key before linking it from the old backup. Your recovery words stay the same. This does not remove access from anyone who has those words. Heartwood may ask you to approve several operations.</p>}
    {message && <p role="status">{message}</p>}
    {importedDependants > 0 && <p>{importedDependants} imported dependant(s) have no recovery-tree path. Their contacts keep the existing backup format.</p>}
    <p>Recovery words do not restore separately imported private keys, generated or imported bot keys, identity documents or local photos. Keep their original recovery material and exports.</p>
  </details>;
}
