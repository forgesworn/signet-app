import { useState } from 'react';
import type { FollowsImportState } from '../types';
import type { FollowsImportOutcome, UnfollowedContact } from '../lib/follows-import-flow';

interface Props {
  /** The persona's display name, for the copy. */
  personaName: string;
  /** The device-local record of the last import, if there has been one. */
  last?: FollowsImportState;
  /** Read the persona's kind 3 and file the follows as contacts. Never publishes. */
  onImport: () => Promise<FollowsImportOutcome>;
  /** Take contacts off this persona's list (never removes a contact). Resolves to how many were taken off. */
  onUnlink: (contactIds: string[]) => Promise<number>;
  /** `offer` is the one-off prompt at the end of an nsec import ("Not now" / "Import"). */
  variant?: 'block' | 'offer';
  onNotNow?: () => void;
}

const SHOWN_UNFOLLOWED = 20;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function summaryLine(o: Extract<FollowsImportOutcome, { status: 'done' }>): string {
  const parts: string[] = [];
  parts.push(`Added ${o.added}`);
  if (o.linked > 0) parts.push(`${o.linked} you already had, now on this list`);
  if (o.unchanged > 0) parts.push(`${o.unchanged} already there`);
  return parts.join(' · ');
}

/**
 * "Import who this account follows" — read-only against Nostr: Signet never
 * changes who an account follows. Shared by a persona's Advanced page and the
 * offer that follows an nsec import.
 */
export function FollowsImportPanel({ personaName, last, onImport, onUnlink, variant = 'block', onNotNow }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<FollowsImportOutcome | null>(null);
  const [unfollowed, setUnfollowed] = useState<UnfollowedContact[]>([]);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkNote, setUnlinkNote] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    setOutcome(null);
    setUnfollowed([]);
    setUnlinkNote('');
    try {
      const result = await onImport();
      setOutcome(result);
      if (result.status === 'done') setUnfollowed(result.unfollowed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setUnlinking(true);
    setError('');
    try {
      const n = await onUnlink(unfollowed.map(u => u.contactId));
      setUnlinkNote(`Took ${n} ${plural(n, 'account', 'accounts')} off ${personaName}'s list.`);
      setUnfollowed([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the list. Please try again.');
    } finally {
      setUnlinking(false);
    }
  }

  const offer = variant === 'offer';
  const importLabel = busy
    ? 'Reading Nostr…'
    : last ? 'Refresh from Nostr' : 'Import who this account follows';

  return (
    <div className="card section" role="group" aria-label="Nostr follows">
      <div className="section-title">{offer ? 'Import who this account follows?' : 'Nostr follows'}</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
        Adds them to {personaName}'s contacts as Ken. Signet never changes who you follow.
      </p>
      {!offer && last && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          Last updated {new Date(last.importedAt).toLocaleDateString()} · {last.count} {plural(last.count, 'follow', 'follows')}
        </p>
      )}

      {outcome?.status === 'unreachable' && (
        <p role="status" style={{ fontSize: '0.85rem', margin: '0 0 12px' }}>
          Couldn't reach Nostr relays. Try again in a moment.
        </p>
      )}
      {outcome?.status === 'empty' && (
        <p role="status" style={{ fontSize: '0.85rem', margin: '0 0 12px' }}>
          {outcome.found ? "This account doesn't follow anyone yet." : 'No follow list found on Nostr for this account.'}
        </p>
      )}
      {outcome?.status === 'done' && (
        <div role="status" style={{ fontSize: '0.85rem', margin: '0 0 12px', lineHeight: 1.5 }}>
          <div>{summaryLine(outcome)}</div>
          {outcome.trimmedNotice && <div style={{ marginTop: 6 }}>{outcome.trimmedNotice}</div>}
        </div>
      )}

      {unfollowed.length > 0 && (
        <div style={{ margin: '0 0 12px' }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            {unfollowed.length} {plural(unfollowed.length, 'account', 'accounts')} you no longer follow — remove {plural(unfollowed.length, 'it', 'them')} from {personaName}'s list?
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '6px 0 8px', overflowWrap: 'anywhere' }}>
            {unfollowed.slice(0, SHOWN_UNFOLLOWED).map(u => u.name).join(', ')}
            {unfollowed.length > SHOWN_UNFOLLOWED ? ` and ${unfollowed.length - SHOWN_UNFOLLOWED} more` : ''}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => { void unlink(); }} disabled={unlinking}>
              {unlinking ? 'Removing…' : `Remove from ${personaName}'s list`}
            </button>
            <button className="btn btn-ghost" onClick={() => setUnfollowed([])} disabled={unlinking}>Keep them</button>
          </div>
        </div>
      )}
      {outcome?.status === 'done' && outcome.unfollowedKept > 0 && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          {outcome.unfollowedKept} {plural(outcome.unfollowedKept, 'account you no longer follow is', 'accounts you no longer follow are')} only
          on {personaName}'s list, so Signet keeps {plural(outcome.unfollowedKept, 'it', 'them')}. Remove {plural(outcome.unfollowedKept, 'it', 'them')} from Contacts if you want {plural(outcome.unfollowedKept, 'it', 'them')} gone.
        </p>
      )}
      {unlinkNote && <p role="status" style={{ fontSize: '0.85rem', margin: '0 0 12px' }}>{unlinkNote}</p>}
      {error && <p role="alert" style={{ fontSize: '0.85rem', color: 'var(--danger, #c0392b)', margin: '0 0 12px' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {offer && outcome?.status === 'done' ? (
          <button className="btn btn-primary" onClick={onNotNow}>Done</button>
        ) : (
          <>
            <button className={offer ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => { void run(); }} disabled={busy || unlinking}>
              {offer && !busy ? 'Import' : importLabel}
            </button>
            {offer && <button className="btn btn-ghost" onClick={onNotNow} disabled={busy}>Not now</button>}
          </>
        )}
      </div>
    </div>
  );
}
