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
import { shortNpub } from '../lib/signet';
import type { ChildSignAsk } from '../lib/child-sign-asks';
import { appPermissionAskDetails } from '../lib/app-permission';

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

/**
 * A36: what the guardian sees as the target — derived from the verified
 * `ask.target` (site origin host / peer npub / app id), never from the
 * child-supplied label.
 */
export function askTargetText(target: string): string {
  if (target === '*') return COPY.anywhere;
  if (target.startsWith('site:')) {
    const origin = target.slice(5);
    try { return new URL(origin).host || origin; } catch { return origin; }
  }
  if (target.startsWith('peer:')) return shortNpub(target.slice(5));
  if (target === 'app:mysignet') return COPY.appMySignet;
  if (target.startsWith('app:nip55:')) return target.slice(10);
  if (target.startsWith('app:')) return COPY.appHex(`${target.slice(4, 12)}…`);
  return target;
}

/** "sign-in to", "public posts on", … or "kind N requests on" for an unclassified kind. */
export function askScopePhrase(a: Pick<ChildSignAsk, 'scope' | 'kind'>): string {
  return (a.scope && COPY.scopePhrase[a.scope]) || COPY.kindPhrase(a.kind);
}

/**
 * Part B: the card input for My Signet's own relay-mode sign-in on a direct
 * child — a marked (`signIn`) kind-21236 signature in scope sign-in on a
 * site target. Null for anything else, which keeps today's card.
 */
export function signInAskDetails(a: ChildSignAsk): { site: string; sharesHandle: boolean } | null {
  if (!a.signIn || typeof a.signIn.sharesHandle !== 'boolean') return null;
  if (a.method !== 'sign_event' || a.scope !== 'sign-in' || a.kind !== 21236) return null;
  if (!a.template || a.template.kind !== 21236 || !a.target.startsWith('site:')) return null;
  return { site: a.targetLabel ?? '', sharesHandle: a.signIn.sharesHandle };
}

export function ChildAskCard({ pending, alwaysAvailable, onDecide, onOutcome }: Props) {
  const [busy, setBusy] = useState(false);
  const [alwaysDeny, setAlwaysDeny] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const a = pending.ask;
  const child = clip(pending.dependantName, 40);
  const persona = clip(pending.personaName, 40);
  const target = clip(askTargetText(a.target), 60);
  const label = clip(a.targetLabel ?? '', 60);
  const showLabel = label.length > 0 && label.toLowerCase() !== target.toLowerCase();
  const unsent = pending.unsent?.verdict;
  // D10: a valid app-permission ask gets its own fixed wording. `null` for any
  // other ask, and for an app-permission one that fails the checks (a claimless
  // 30420 from an external app): that one falls through to the generic card.
  const permission = appPermissionAskDetails(a);
  // Part B: a marked sign-in gets its own plain card; null keeps today's.
  const signIn = permission ? null : signInAskDetails(a);
  // The scope is asked for every time, whatever the stage: never "Always".
  const showAlways = alwaysAvailable && a.scope !== 'app-permission';
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

  const PC = COPY.appPermission;
  const until = permission ? new Date(permission.validUntil * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  return (
    <div data-testid="child-ask-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
          {COPY.eyebrow}
        </div>
        <div style={{ fontSize: '1.05rem', fontWeight: 600, lineHeight: 1.3 }}>
          {permission ? PC.heading(clip(permission.name, 64), child)
            : signIn ? COPY.signIn.heading(child, clip(signIn.site, 60) || target)
            : heading}
        </div>
      </div>
      {signIn ? (
        <div data-testid="child-ask-sign-in" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{COPY.signIn.from(target)}</div>
          <div>{COPY.signIn.sharesHandle(child, signIn.sharesHandle)}</div>
          <div>{COPY.as(persona)}</div>
          {hiddenLines(pending).map(line => (
            <div key={line} role="note" style={{ marginTop: 6, fontWeight: 600, color: 'var(--warning)' }}>{line}</div>
          ))}
        </div>
      ) : permission ? (
        <div data-testid="child-ask-app-permission" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* M8: which of the child's identities the statement binds. */}
          <div>{COPY.as(persona)}</div>
          <div>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>{PC.appSaysLabel}</div>
            {/* M7: the app's own words, framed apart from My Signet's. */}
            <div data-testid="child-ask-app-permission-reason" style={{ marginTop: 4, padding: 8, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{permission.reason}</div>
          </div>
          <div>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>{PC.allowsTitle}</div>
            <div style={{ color: 'var(--text-primary)' }}>{PC.allows[permission.permission](clip(permission.name, 64), child, persona, until)}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{PC.from(target)}</div>
            <details>
              <summary>{PC.details}</summary>
              <div>{PC.appId}: {permission.appId}</div>
              <div>{PC.installKey}: {`${permission.installKey.slice(0, 8)}…${permission.installKey.slice(-4)}`}</div>
              <div>{PC.validUntil}: {until}</div>
            </details>
          </div>
        </div>
      ) : (
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <div>{COPY.as(persona)}</div>
        <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{COPY.on(target)}</div>
        {showLabel && <div data-testid="child-ask-label" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{COPY.labelNote(label)}</div>}
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
      )}
      {message && (
        <div role={message.error ? 'alert' : 'status'} aria-live="polite"
          style={{ fontSize: '0.85rem', fontWeight: 600, color: message.error ? 'var(--danger)' : 'var(--success)' }}>
          {message.text}
        </div>
      )}
      {unsent ? (
        // A34: the answer is fixed; only the same verdict can be sent again.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!message && <div role="status" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{COPY.unsentNote(COPY.choiceName[unsent])}</div>}
          <button className="btn btn-primary" disabled={busy} onClick={() => { void act(unsent); }}>{COPY.sendAgain(COPY.choiceName[unsent])}</button>
        </div>
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => { void act('once'); }}>{permission ? PC.allow : COPY.allowOnce}</button>
        {showAlways && (
          <button className="btn btn-secondary" disabled={busy} onClick={() => { void act('always'); }}>{COPY.allowAlways(askScopePhrase(a), target, persona)}</button>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={() => { void act('deny'); }} style={{ color: 'var(--danger)' }}>{COPY.deny}</button>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={alwaysDeny} disabled={busy} onChange={(e) => setAlwaysDeny(e.target.checked)} />
          {COPY.alwaysDeny}
        </label>
      </div>
      )}
    </div>
  );
}

/** The guardian-facing line for a verdict outcome, or null when it went as asked. */
export function childAskOutcomeText(r: { sent: boolean; reason?: ChildAskDecideReason }): string | null {
  return r.reason ? (COPY.reasons[r.reason] ?? COPY.reasons['publish-failed']) : null;
}
