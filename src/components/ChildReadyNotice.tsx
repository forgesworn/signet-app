/**
 * The ready-check notice (child-direct pairing), on both phones, chosen by
 * `readySummary` alone:
 *   owed     "Not ready away from home", how many presses, "Finish now"
 *            (opens the checklist and asks again for what is owed);
 *   full     the Heartwood cannot remember any more identities for this
 *            phone: no press count, no "Finish now";
 *   unknown  this phone cannot confirm: no "Ready", no count, no button;
 *   paused   one line, no nag;
 *   ready    "Ready to use away from home." only when `showReady`.
 * `compact` drops the card frame, for a notice inside another card.
 */
import { useState } from 'react';
import type { ReadyRow, ReadySummary } from '../lib/child-ready-check';
import { CHILD_READY_COPY as COPY } from '../lib/child-ready-copy';
import { ChildIdentityApprovals } from './ChildIdentityApprovals';

interface Props {
  rows: ReadyRow[];
  summary: ReadySummary;
  /** The child's name, for the full / unknown / paused lines on the guardian's phone. */
  name: string;
  /** Whose phone: on the child's own the lines speak to the child (`CHILD_READY_COPY.child`). Default guardian. */
  viewer?: 'guardian' | 'child';
  /** Show the ready line once everything is confirmed. */
  showReady: boolean;
  /** Show the checklist without a tap (setup surfaces, or while a first probe runs). */
  open?: boolean;
  compact?: boolean;
  onFinishNow(): void;
  onRetry?(pubkey: string): void;
  onDefer?(pubkey: string): void;
  hint?: string;
}

const secondary = { color: 'var(--text-secondary)', fontSize: '0.85rem' } as const;

export function ChildReadyNotice({ rows, summary, name, viewer = 'guardian', showReady, open, compact, onFinishNow, onRetry, onDefer, hint }: Props) {
  const [opened, setOpened] = useState(false);
  const child = viewer === 'child';
  if (summary.kind === 'empty') return null;
  if (summary.kind === 'ready' && !showReady) return null;
  const frame = compact
    ? { className: 'card-ready-notice', style: { padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-card-alt)', border: '1px solid var(--border)', fontSize: '0.85rem', textAlign: 'left' as const } }
    : { className: 'card section', style: { padding: 16, marginBottom: 12 } };
  const list = (
    <div style={{ marginBottom: 12 }}>
      <ChildIdentityApprovals rows={rows} {...(onRetry ? { onRetry } : {})} {...(onDefer ? { onDefer } : {})} {...(hint ? { hint } : {})} />
    </div>
  );
  // Inside a card that opens on a tap: keep taps on the notice to the notice.
  const stop = compact ? { onClick: (e: { stopPropagation(): void }) => e.stopPropagation() } : {};
  return (
    <div className={frame.className} role="status" data-testid="ready-notice" data-summary={summary.kind} style={frame.style} {...stop}>
      {summary.kind === 'ready' ? (
        <div style={{ fontWeight: 600 }}>{COPY.ready}</div>
      ) : summary.kind === 'paused' ? (
        <div style={secondary}>{child ? COPY.child.paused : COPY.paused(name)}</div>
      ) : summary.kind === 'unknown' ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{COPY.unknownHeading}</div>
          <p style={{ ...secondary, margin: 0 }}>{child ? COPY.child.unknownBody : COPY.unknownBody(name)}</p>
        </>
      ) : summary.kind === 'full' ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{COPY.fullHeading}</div>
          <p style={{ ...secondary, marginBottom: compact ? 0 : 12 }}>{child ? COPY.child.fullBody : COPY.fullBody(name)}</p>
          {compact ? null : list}
        </>
      ) : (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{COPY.notReadyHeading}</div>
          <p style={{ ...secondary, marginBottom: 4 }}>{COPY.pressesOwed(summary.owed)}</p>
          <p style={{ ...secondary, marginBottom: 12 }}>{COPY.doAtHome}</p>
          {open || opened || rows.some(r => r.probing) ? list : null}
          <button className="btn btn-primary btn-sm" onClick={() => { setOpened(true); onFinishNow(); }}>{COPY.finishNow}</button>
        </>
      )}
    </div>
  );
}
