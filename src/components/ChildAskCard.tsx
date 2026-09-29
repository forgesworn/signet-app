/**
 * One child's fresh request, for the guardian (child-direct, spec §7). Used by
 * the approval modal and by the Bunker panel's "Family asks" list. Shows who
 * is asking, as which persona, on which site/app, what it is, and — A12 — a
 * visible line whenever part of the request was cut for size.
 */
import { useState } from 'react';
import type { PendingChildAsk, ChildAskDecideReason } from '../hooks/useChildAsks';
import { describeEventTemplate } from '../lib/nip46-server';
import { CHILD_ASK_COPY as COPY } from '../lib/child-device-copy';

export type ChildAskDecide = (id: string, verdict: 'once' | 'always' | 'deny', opts?: { alwaysDeny?: boolean }) => Promise<{ sent: boolean; reason?: ChildAskDecideReason }>;

interface Props {
  pending: PendingChildAsk;
  /** Hide "Always allow" (full-control: every request is asked for). */
  alwaysAvailable: boolean;
  onDecide: ChildAskDecide;
  /** Called with every outcome (the caller keeps an error visible after the ask leaves the list). */
  onOutcome?: (r: { sent: boolean; reason?: ChildAskDecideReason }) => void;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** "Part of this request is hidden" lines (A12). */
export function hiddenLines(p: PendingChildAsk): string[] {
  const out: string[] = [];
  const a = p.ask;
  if (a.contentTruncated && a.template && typeof a.contentLength === 'number') {
    out.push(COPY.hidden(Math.max(0, a.contentLength - a.template.content.length)));
  }
  if (a.tagsTruncated) out.push(COPY.hiddenTags);
  return out;
}

export function ChildAskCard({ pending, alwaysAvailable, onDecide, onOutcome }: Props) {
  const [busy, setBusy] = useState(false);
  const [alwaysDeny, setAlwaysDeny] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const a = pending.ask;
  const child = clip(pending.dependantName, 40);
  const persona = clip(pending.personaName, 40);
  const target = clip(a.targetLabel || a.target, 60);
  const heading = a.method === 'sign_event' && a.template
    ? COPY.heading(child, describeEventTemplate(a.template))
    : COPY.headingCrypto(child);

  const act = async (verdict: 'once' | 'always' | 'deny') => {
    setBusy(true); setMessage(null);
    try {
      const r = await onDecide(a.id, verdict, verdict === 'deny' ? { alwaysDeny } : undefined);
      if (r.reason) setMessage({ text: COPY.reasons[r.reason] ?? COPY.reasons['publish-failed'], error: true });
      else if (r.sent) setMessage({ text: COPY.sent[verdict], error: false });
      if (!r.sent) setBusy(false);
      onOutcome?.(r);
    } catch {
      setMessage({ text: COPY.reasons['publish-failed'], error: true });
      setBusy(false);
    }
  };

  return (
    <div data-testid="child-ask-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
          {COPY.eyebrow}
        </div>
        <div style={{ fontSize: '1.05rem', fontWeight: 600, lineHeight: 1.3 }}>{heading}</div>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <div>{COPY.as(persona)}</div>
        <div>{COPY.on(target)}</div>
        {a.template && a.template.content && (
          <div style={{ marginTop: 6, padding: 8, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>
            {clip(a.template.content, 500)}
          </div>
        )}
        {hiddenLines(pending).map(line => (
          <div key={line} role="note" style={{ marginTop: 6, fontWeight: 600, color: 'var(--warning)' }}>{line}</div>
        ))}
      </div>
      {message && (
        <div role={message.error ? 'alert' : 'status'} aria-live="polite"
          style={{ fontSize: '0.85rem', fontWeight: 600, color: message.error ? 'var(--danger)' : 'var(--success)' }}>
          {message.text}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => { void act('once'); }}>{COPY.allowOnce}</button>
        {alwaysAvailable && (
          <button className="btn btn-secondary" disabled={busy} onClick={() => { void act('always'); }}>{COPY.allowAlways(target, persona)}</button>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={() => { void act('deny'); }} style={{ color: 'var(--danger)' }}>{COPY.deny}</button>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={alwaysDeny} disabled={busy} onChange={(e) => setAlwaysDeny(e.target.checked)} />
          {COPY.alwaysDeny}
        </label>
      </div>
    </div>
  );
}

/** The guardian-facing line for a verdict outcome, or null when it went as asked. */
export function childAskOutcomeText(r: { sent: boolean; reason?: ChildAskDecideReason }): string | null {
  return r.reason ? (COPY.reasons[r.reason] ?? COPY.reasons['publish-failed']) : null;
}
