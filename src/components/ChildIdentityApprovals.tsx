/**
 * Child phone, child-direct pairing: the per-persona "press ALLOW AS on the
 * Heartwood" checklist (spec §4 step 6). Shown until every persona is approved.
 */
import { CHILD_SIDE_COPY as KID } from '../lib/child-device-copy';

interface Props {
  personas: { pubkey: string; name: string; approval: 'approved' | 'waiting' | 'failed' }[];
  onRetry(pubkey: string): void;
}

export function ChildIdentityApprovals({ personas, onRetry }: Props) {
  if (personas.length === 0 || personas.every(p => p.approval === 'approved')) return null;
  return (
    <div className="card section" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{KID.approvals.heading}</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>{KID.approvals.body}</p>
      {personas.map(p => (
        <div key={p.pubkey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0' }}>
          <span>{p.name}</span>
          {p.approval === 'failed' ? (
            <button className="btn btn-sm" onClick={() => onRetry(p.pubkey)}>{KID.approvals.retry}</button>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {p.approval === 'approved' ? KID.approvals.approved : KID.approvals.waiting}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
