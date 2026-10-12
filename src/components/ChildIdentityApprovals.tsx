/**
 * Child phone, child-direct pairing: the per-persona "press ALLOW AS on the
 * Heartwood" checklist (spec §4 step 6). Each pending row can be put off
 * ("Later"); a deferred row is approved when the child first needs it, or on
 * "Approve now". Once every row is approved or deferred the ceremony is
 * finished and the card shrinks to the deferred rows only.
 */
import { CHILD_SIDE_COPY as KID } from '../lib/child-device-copy';

type Approval = 'approved' | 'waiting' | 'failed' | 'deferred';

interface Props {
  personas: { pubkey: string; name: string; approval: Approval }[];
  onRetry(pubkey: string): void;
  onDefer?(pubkey: string): void;
}

export function ChildIdentityApprovals({ personas, onRetry, onDefer }: Props) {
  if (personas.length === 0 || personas.every(p => p.approval === 'approved')) return null;
  const finished = personas.every(p => p.approval === 'approved' || p.approval === 'deferred');
  const rows = finished ? personas.filter(p => p.approval === 'deferred') : personas;
  return (
    <div className="card section" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{finished ? KID.approvals.finishedHeading : KID.approvals.heading}</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>{finished ? KID.approvals.finishedBody : KID.approvals.body}</p>
      {rows.map(p => (
        <div key={p.pubkey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0' }}>
          <span>{p.name}</span>
          {p.approval === 'deferred' ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{KID.approvals.deferred}</span>
              <button className="btn btn-sm" onClick={() => onRetry(p.pubkey)}>{KID.approvals.approveNow}</button>
            </span>
          ) : p.approval === 'approved' ? (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{KID.approvals.approved}</span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {p.approval === 'failed' ? (
                <button className="btn btn-sm" onClick={() => onRetry(p.pubkey)}>{KID.approvals.retry}</button>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{KID.approvals.waiting}</span>
              )}
              {onDefer ? <button className="btn btn-sm" onClick={() => onDefer(p.pubkey)}>{KID.approvals.later}</button> : null}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
