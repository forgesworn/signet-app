/**
 * My Keep: a read-only list of the Keep(s) this identity has claimed, and
 * whether each is online. Plain relay reads, so it works on web too.
 *
 * Nothing here writes to the network. A nickname is stored on this device
 * only (`keep-nicknames.ts`) and never published. Managing a Keep (revoke,
 * pair, rename on the network) is not built yet; the footnote says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { loadMyKeeps, type KeepLoadResult } from '../lib/keep-load';
import {
  displayName, formatBytes, presenceLabel, presenceOf, roleLabel, type Keep,
} from '../lib/keep';
import { NICKNAME_MAX, loadNicknames, setNickname } from '../lib/keep-nicknames';
import { KEEP_PREVIEW_BANNER, keepPreviewEnabled, keepPreviewKeeps } from '../lib/keep-preview';

interface Props {
  /** Every public key a claim of this user's may be signed by (see `keepAuthorPubkeys`), hex. */
  ownedPubkeys: string[];
  /** Identity id; nicknames are saved per identity. */
  scope: string;
  onBack: () => void;
}

type State = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; keeps: Keep[]; now: number };

/** Dev builds only: `?keep-preview` shows sample Keeps. Every use below is also behind `import.meta.env.DEV`, so a production build drops the preview code. */
const previewOn = () => import.meta.env.DEV && keepPreviewEnabled(import.meta.env.DEV, window.location.search);

const FOOTNOTE = 'Managing a Keep from here is coming later.';

const INTRO = 'See the Keep you\u2019ve set up at home and whether it\u2019s online.';

function Intro() {
  return <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>{INTRO}</p>;
}

function PreviewBanner() {
  return (
    <div className="card card-warning" role="note" data-testid="keep-preview-banner" style={{ fontSize: '0.85rem', marginBottom: 16 }}>
      {KEEP_PREVIEW_BANNER}
    </div>
  );
}

function Footnote() {
  return <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 16, textAlign: 'center' }}>{FOOTNOTE}</p>;
}

function KeepRow({ keep, now, nickname, last, onNickname }: {
  keep: Keep; now: number; nickname?: string; last: boolean; onNickname: (node: string, value: string) => void;
}) {
  const { claim, status } = keep;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const presence = presenceOf(status, now);
  const online = presence.state === 'online';
  const facts = [
    roleLabel(claim.role),
    claim.region,
    status?.freeBytes !== undefined ? `${formatBytes(status.freeBytes)} free` : undefined,
    status?.software ? status.software.replace('/', ' ') : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <div data-testid="keep-row" style={{ padding: '14px 16px', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      {editing ? (
        <form
          onSubmit={e => { e.preventDefault(); onNickname(claim.node, draft); setEditing(false); }}
          style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}
        >
          <input
            className="input"
            aria-label="Nickname"
            value={draft}
            maxLength={NICKNAME_MAX}
            placeholder={claim.name || 'Your Keep'}
            onChange={e => setDraft(e.target.value)}
            autoFocus
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="submit" className="btn btn-ghost" style={{ fontSize: '0.8rem', padding: '6px 12px' }}>Save</button>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} style={{ fontSize: '0.8rem', padding: '6px 12px' }}>Cancel</button>
        </form>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2, minWidth: 0 }}>{displayName(claim, nickname)}</div>
          <button
            className="btn btn-ghost"
            onClick={() => { setDraft(nickname ?? ''); setEditing(true); }}
            style={{ fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0 }}
          >
            Rename
          </button>
        </div>
      )}
      <div style={{ fontSize: '0.85rem', color: online ? 'var(--success)' : 'var(--text-secondary)', fontWeight: 500 }}>
        {presenceLabel(presence)}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{facts}</div>
      {editing && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
          Only shown on this device. Leave empty to use the original name.
        </div>
      )}
    </div>
  );
}

export function MyKeep({ ownedPubkeys, scope, onBack }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [nicknames, setNicknames] = useState<Record<string, string>>(() => loadNicknames(scope));
  const [attempt, setAttempt] = useState(0);
  const ownedKey = ownedPubkeys.join(',');
  const [preview] = useState(previewOn);

  // Settings keeps its window scroll when this page opens; start at the top.
  useEffect(() => { try { window.scrollTo?.(0, 0); } catch { /* no scrolling here */ } }, []);

  useEffect(() => {
    let cancelled = false;
    if (import.meta.env.DEV && preview) {
      // Sample data (dev only): no relay is read, the rows render as real ones do.
      const now = Math.floor(Date.now() / 1000);
      setState({ phase: 'ready', keeps: keepPreviewKeeps(ownedKey.split(',')[0] || '0'.repeat(64), now), now });
      return;
    }
    setState({ phase: 'loading' });
    loadMyKeeps(ownedKey ? ownedKey.split(',') : []).then(
      (r: KeepLoadResult) => {
        if (cancelled) return;
        setState(r.ok ? { phase: 'ready', keeps: r.keeps, now: r.now } : { phase: 'error' });
      },
      () => { if (!cancelled) setState({ phase: 'error' }); },
    );
    return () => { cancelled = true; };
  }, [ownedKey, attempt, preview]);

  const retry = useCallback(() => setAttempt(n => n + 1), []);

  if (state.phase === 'loading') {
    return (
      <div className="fade-in" role="main">
        <Intro />
        <p role="status" style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', textAlign: 'center', padding: 24 }}>
          Looking for your Keep&hellip;
        </p>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="fade-in" role="main">
        <Intro />
        <div className="empty-state">
          <p className="empty-state-text" role="alert">Couldn&apos;t reach the network. Try again.</p>
          <button className="btn btn-secondary" onClick={retry}>Try again</button>
        </div>
      </div>
    );
  }

  if (state.keeps.length === 0) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="home" size={36} /></div>
          <h3 className="empty-state-title">No Keep yet.</h3>
          <p className="empty-state-text">
            A Keep is a small device at home that looks after your things. You can set one up with the Bothy app.
          </p>
          <button className="btn btn-secondary" onClick={onBack}>Back to Settings</button>
          <Footnote />
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      {import.meta.env.DEV && preview && <PreviewBanner />}
      <Intro />
      <div className="card card-flush">
        {state.keeps.map((keep, i) => (
          <KeepRow
            key={keep.claim.node}
            keep={keep}
            now={state.now}
            nickname={nicknames[keep.claim.node]}
            last={i === state.keeps.length - 1}
            onNickname={(node, value) => setNicknames(setNickname(scope, node, value))}
          />
        ))}
      </div>
      <Footnote />
      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <button className="btn btn-secondary" onClick={onBack}>Back to Settings</button>
      </div>
    </div>
  );
}
