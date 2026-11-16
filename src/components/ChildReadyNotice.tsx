/**
 * The ready-check notice (child-direct pairing), on both phones. While any
 * Heartwood press is still owed it stays put, says how many, and offers
 * "Finish now", which opens the checklist and asks again for what is owed.
 * Nothing owed: "Ready to use away from home." when `showReady`, else nothing.
 */
import { useState } from 'react';
import type { ReadyRow } from '../lib/child-ready-check';
import { owedPresses } from '../lib/child-ready-check';
import { CHILD_READY_COPY as COPY } from '../lib/child-ready-copy';
import { ChildIdentityApprovals } from './ChildIdentityApprovals';

interface Props {
  rows: ReadyRow[];
  /** Show the ready line once nothing is owed. */
  showReady: boolean;
  /** Show the checklist without a tap (setup surfaces, or while a first probe runs). */
  open?: boolean;
  onFinishNow(): void;
  onRetry?(pubkey: string): void;
  onDefer?(pubkey: string): void;
  hint?: string;
}

export function ChildReadyNotice({ rows, showReady, open, onFinishNow, onRetry, onDefer, hint }: Props) {
  const [opened, setOpened] = useState(false);
  if (rows.length === 0) return null;
  const owed = owedPresses(rows);
  if (owed === 0) {
    return showReady ? (
      <div className="card section" role="status" data-testid="ready-notice" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>{COPY.ready}</div>
      </div>
    ) : null;
  }
  const showList = open || opened || rows.some(r => r.probing);
  return (
    <div className="card section" role="status" data-testid="ready-notice" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{COPY.notReadyHeading}</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 4 }}>{COPY.pressesOwed(owed)}</p>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>{COPY.doAtHome}</p>
      {showList ? (
        <div style={{ marginBottom: 12 }}>
          <ChildIdentityApprovals rows={rows} {...(onRetry ? { onRetry } : {})} {...(onDefer ? { onDefer } : {})} {...(hint ? { hint } : {})} />
        </div>
      ) : null}
      <button className="btn btn-primary btn-sm" onClick={() => { setOpened(true); onFinishNow(); }}>{COPY.finishNow}</button>
    </div>
  );
}
