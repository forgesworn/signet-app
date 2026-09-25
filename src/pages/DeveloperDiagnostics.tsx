import { useEffect, useState } from 'react';
import {
  getAuthRequestLog,
  clearAuthRequestLog,
  subscribeAuthRequestLog,
} from '../lib/auth-request-log';
import type { AuthRequestLogEntry } from '../lib/auth-request-log';

/**
 * Developer diagnostics page — power-mode only.
 *
 * Shows the last ~20 inbound Sign-in-with-Signet requests with parser
 * warnings and the user's eventual outcome. Useful when a consumer is
 * integrating and wants to see what their URL actually produced.
 *
 * No persistence — the log lives in memory for privacy reasons.
 */
export function DeveloperDiagnostics() {
  const [entries, setEntries] = useState<AuthRequestLogEntry[]>(() => getAuthRequestLog());

  useEffect(() => {
    const unsubscribe = subscribeAuthRequestLog(() => setEntries(getAuthRequestLog()));
    return unsubscribe;
  }, []);

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>Auth request log</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          The last {entries.length === 0 ? 'few' : entries.length} Sign-in-with-Signet requests this tab has seen.
          Not saved to disk — clears when the app reloads.
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="card section" style={{ textAlign: 'center', padding: 24 }}>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0 }}>
            No requests yet. Launch a sign-in from a consumer to see it here.
          </p>
        </div>
      ) : (
        <div className="card card-flush">
          {entries.map((entry, i) => (
            <div
              key={`${entry.at}-${i}`}
              style={{
                padding: '12px 16px',
                borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {extractHost(entry.origin)}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {formatTime(entry.at)}
                </span>
              </div>
              <OutcomeLine entry={entry} />
              <HintLine entry={entry} />
              {entry.warnings.length > 0 && (
                <div style={{ marginTop: 4, fontSize: '0.75rem', color: 'var(--warning)' }}>
                  warnings: <span style={{ fontFamily: 'var(--font-mono)' }}>{entry.warnings.join(', ')}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {entries.length > 0 && (
        <div className="section" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => clearAuthRequestLog()} style={{ color: 'var(--danger)' }}>
            Clear log
          </button>
        </div>
      )}
    </div>
  );
}

function OutcomeLine({ entry }: { entry: AuthRequestLogEntry }) {
  if (!entry.outcome) {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>pending</div>;
  }
  const colour =
    entry.outcome === 'approved' ? 'var(--success)' :
    entry.outcome === 'denied' ? 'var(--danger)' :
    'var(--text-muted)';
  return (
    <div style={{ fontSize: '0.75rem', color: colour }}>
      {entry.outcome}{entry.chosen ? ` → ${entry.chosen}` : ''}
    </div>
  );
}

function HintLine({ entry }: { entry: AuthRequestLogEntry }) {
  if (!entry.hint) {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>no accept= hint</div>;
  }
  const parts: string[] = [];
  if (entry.hint.allow.length > 0) parts.push(`accept=${entry.hint.allow.join(',')}`);
  if (entry.hint.prefer) parts.push(`prefer=${entry.hint.prefer}`);
  if (entry.hint.reason) parts.push(`reason="${entry.hint.reason.slice(0, 40)}${entry.hint.reason.length > 40 ? '…' : ''}"`);
  return (
    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
      {parts.join(' · ') || '(hint present but empty)'}
    </div>
  );
}

function extractHost(origin: string): string {
  try { return new URL(origin).host; }
  catch { return origin.slice(0, 64); }
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
