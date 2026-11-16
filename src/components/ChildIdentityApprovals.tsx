/**
 * The ready-check checklist (child-direct pairing), on both phones: one row
 * per identity that needs a Heartwood press, each waiting for a press, ready
 * or skipped. Each row also shows the identity line the Heartwood card shows
 * (`npub1` + 8 characters), because every child persona reads "dependan" in
 * the card heading. A row waiting on the device says to press and hold; a
 * failed one offers "Try again", a pending one "Later", a skipped one
 * "Approve now". The guardian's phone passes no `onDefer`.
 */
import type { ReadyRow } from '../lib/child-ready-check';
import { deviceShortNpub } from '../lib/child-ready-check';
import { CHILD_READY_COPY as COPY } from '../lib/child-ready-copy';

interface Props {
  rows: ReadyRow[];
  onRetry?(pubkey: string): void;
  onDefer?(pubkey: string): void;
  /** One line under the list (the guardian's note on the child's presses). */
  hint?: string;
}

const muted = { color: 'var(--text-muted)', fontSize: '0.85rem' } as const;

export function ChildIdentityApprovals({ rows, onRetry, onDefer, hint }: Props) {
  if (rows.length === 0) return null;
  return (
    <div data-testid="ready-checklist">
      {rows.map(r => {
        // Never for the guardian's own row: that key is the guardian's real
        // identity, which may be dormant (its card heading already reads "natural-").
        const npub = r.who === 'child' ? deviceShortNpub(r.pubkey) : '';
        return (
          <div key={`${r.who}:${r.pubkey}`} data-testid={`ready-row-${r.pubkey}`} style={{ padding: '6px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ minWidth: 0 }}>
                <span>{r.name}</span>
                {npub ? <span style={{ ...muted, display: 'block', fontSize: '0.75rem' }}>{COPY.onHeartwood(npub)}</span> : null}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={muted}>{COPY.state[r.state]}</span>
                {r.state === 'skipped' && onRetry ? (
                  <button className="btn btn-sm" onClick={() => onRetry(r.pubkey)}>{COPY.approveNow}</button>
                ) : null}
                {r.state === 'waiting' && r.failed && onRetry ? (
                  <button className="btn btn-sm" onClick={() => onRetry(r.pubkey)}>{COPY.retry}</button>
                ) : null}
                {r.state === 'waiting' && onDefer && r.who === 'child' ? (
                  <button className="btn btn-sm" onClick={() => onDefer(r.pubkey)}>{COPY.later}</button>
                ) : null}
              </span>
            </div>
            {r.probing ? <p role="status" style={{ ...muted, marginTop: 4 }}>{COPY.pressAndHold}</p> : null}
          </div>
        );
      })}
      {hint ? <p style={{ ...muted, marginTop: 8 }}>{hint}</p> : null}
    </div>
  );
}
