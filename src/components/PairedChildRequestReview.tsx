import { useState } from 'react';
import type { GuardianChildRequest, GuardianChildStuckRequest } from '../hooks/useGuardianChildContactRequests';
import { decideChildContactRequest, GUARDIAN_CHILD_HISTORY_LABEL } from '../lib/child-contact-lifecycle';
import type { ChildContactExchangePlan } from '../lib/child-contact-review';
import type { ChildRequestStatus } from '../lib/child-contact-requests';
import { sanitizeDisplayName } from '../lib/text-sanitize';

export function PairedChildRequestReview({ requests, stuck = [], history = [], keyMaterial, now, current, mayConnect, childName, onExecute, onAbandon, onReply, onCancel, onChanged }: {
  requests: GuardianChildRequest[]; stuck?: GuardianChildStuckRequest[];
  /** D4: the 10 most recent terminal receipts per dependant, read-only. */
  history?: GuardianChildRequest[]; keyMaterial: string; now(): number; current(): boolean;
  mayConnect(peer: string, item: GuardianChildRequest): boolean | Promise<boolean>; onChanged(): void;
  childName(child: string): string;
  /** Sign and persist the approved exchange; nothing may publish yet. */
  onExecute(item: GuardianChildRequest, plan: ChildContactExchangePlan): Promise<void>;
  onAbandon(item: GuardianChildRequest, plan: ChildContactExchangePlan): Promise<void>;
  onReply(item: GuardianChildRequest, plan: ChildContactExchangePlan, status: 'pending' | 'denied'): Promise<void>;
  onCancel(item: GuardianChildStuckRequest): Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (requests.length === 0 && stuck.length === 0 && history.length === 0) return null;
  const name = (child: string) => sanitizeDisplayName(childName(child), 64) || 'your child';
  const run = async (id: string, work: () => Promise<unknown>, fallback: string) => {
    setBusy(id); setError(null);
    try { await work(); }
    catch (cause) { setError((cause instanceof Error ? cause.message : fallback).slice(0, 160)); }
    finally { setBusy(null); onChanged(); }
  };
  const decide = (item: GuardianChildRequest, decision: 'approve' | 'deny') => run(`${item.source.scope.client}:${item.receipt.id}`,
    () => decideChildContactRequest({ scope: item.source.scope, key: keyMaterial, requestId: item.receipt.id, fingerprint: item.receipt.fingerprint,
      decision, now, isCurrent: current, mayConnect: peer => mayConnect(peer, item),
      execute: plan => onExecute(item, plan), abandon: plan => onAbandon(item, plan), reply: (plan, status) => onReply(item, plan, status) }),
    'Unable to review this request');
  const disabled = busy !== null;
  return <section aria-label="Paired-child contact requests" className="stack">
    <h2>Requests from paired children</h2>
    <p className="field-hint">Review each request before any contact exchange starts.</p>
    {error && <p role="alert" className="field-hint">{error}</p>}
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {stuck.map(item => {
        const id = `${item.source.scope.client}:${item.plan.requestId}`;
        return <li key={`stuck:${id}`} className="row" style={{ display: 'block' }}>
          <strong>{sanitizeDisplayName(item.plan.request.invite.caption ?? '', 100) || 'Contact exchange request'}</strong>
          <p className="field-hint">This request stopped partway. Cancel it so {name(item.source.scope.child)} can ask again.</p>
          <button className="btn btn-ghost" disabled={disabled} onClick={() => { void run(id, () => onCancel(item), 'Unable to cancel this request'); }}>Cancel request</button>
        </li>;
      })}
      {requests.map(item => {
        const request = item.receipt.request!; const id = `${item.source.scope.client}:${item.receipt.id}`;
        return <li key={id} className="row" style={{ display: 'block' }}>
          <strong>{sanitizeDisplayName(request.invite.caption ?? '', 100) || 'Contact exchange request'}</strong>
          <p className="field-hint">Persona <code>{request.persona.slice(0, 12)}…</code> wants to connect with <code>{request.invite.recipient.slice(0, 12)}…</code>.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={disabled} onClick={() => { void decide(item, 'approve'); }}>Approve</button>
            <button className="btn btn-ghost" disabled={disabled} onClick={() => { void decide(item, 'deny'); }}>Deny</button>
          </div>
        </li>;
      })}
    </ul>
    {history.length > 0 && <>
      <h3>Recent decisions</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {history.map(item => {
          const id = `history:${item.source.scope.client}:${item.receipt.id}`;
          const label = GUARDIAN_CHILD_HISTORY_LABEL[item.receipt.status as Exclude<ChildRequestStatus, 'pending'>];
          return <li key={id} className="row field-hint">{name(item.source.scope.child)} — {label}</li>;
        })}
      </ul>
    </>}
  </section>;
}
