/**
 * My Keep: a read-only list of the Keep(s) this identity has claimed, and
 * whether each is online. Plain relay reads, so it works on web too.
 *
 * Nothing here writes to the network. A nickname is stored on this device
 * only (`keep-nicknames.ts`) and never published. Managing a Keep (revoke,
 * pair, rename on the network) is not built yet; the footnote says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { loadStoredKeeps } from '../lib/keep-service';
import { Icon } from '../components/Icon';
import { loadMyKeeps, type KeepLoadResult } from '../lib/keep-load';
import {
  displayName, formatBytes, presenceLabel, presenceOf, roleLabel, type Keep,
} from '../lib/keep';
import { NICKNAME_MAX, loadNicknames, setNickname } from '../lib/keep-nicknames';
import { KEEP_PREVIEW_BANNER, keepPreviewEnabled, keepPreviewKeeps } from '../lib/keep-preview';
import { AddKeep, KeepDetail, StoredKeepRows, useStoredKeeps, type KeepHost } from './KeepManage';

interface Props {
  /** Every public key a claim of this user's may be signed by (see `keepAuthorPubkeys`), hex. */
  ownedPubkeys: string[];
  /** Identity id; nicknames are saved per identity. */
  scope: string;
  onBack: () => void;
  /** What adding and managing a Keep needs from the app. Absent where that is not offered. */
  keepHost?: KeepHost;
}

type State = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; keeps: Keep[]; now: number };

/** Dev builds only: `?keep-preview` shows sample Keeps. Every use below is also behind `import.meta.env.DEV`, so a production build drops the preview code. */
const previewOn = () => import.meta.env.DEV && keepPreviewEnabled(import.meta.env.DEV, window.location.search);

const FOOTNOTE = 'Managing a Keep from here is coming later.';
const FOOTNOTE_WITH_HOST = 'Keeps set up with the Bothy app can\u2019t be managed from here yet.';

type View = { t: 'list' } | { t: 'add' } | { t: 'detail'; keep: string; note?: string };

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

function Footnote({ text = FOOTNOTE }: { text?: string }) {
  return <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 16, textAlign: 'center' }}>{text}</p>;
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
          <button type="submit" className="btn btn-ghost" style={{ fontSize: '0.8rem', padding: '6px 12px', width: 'auto', flexShrink: 0 }}>Save</button>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} style={{ fontSize: '0.8rem', padding: '6px 12px', width: 'auto', flexShrink: 0 }}>Cancel</button>
        </form>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{displayName(claim, nickname)}</div>
          <button
            className="btn btn-ghost"
            onClick={() => { setDraft(nickname ?? ''); setEditing(true); }}
            style={{ fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0, width: 'auto' }}
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

export function MyKeep({ ownedPubkeys, scope, onBack, keepHost }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [nicknames, setNicknames] = useState<Record<string, string>>(() => loadNicknames(scope));
  const [attempt, setAttempt] = useState(0);
  const ownedKey = ownedPubkeys.join(',');
  const [preview] = useState(previewOn);
  const [view, setView] = useState<View>({ t: 'list' });
  const { keeps: stored, setKeeps: setStored } = useStoredKeeps(keepHost);

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

  if (keepHost && view.t === 'add') {
    return (
      <AddKeep
        host={keepHost}
        onCancel={() => setView({ t: 'list' })}
        onDone={(keep, note) => {
          loadStoredKeeps(keepHost.deps.encryptionKey).then(setStored, () => undefined);
          setView({ t: 'detail', keep, note });
        }}
      />
    );
  }
  const openKeep = keepHost && view.t === 'detail' ? stored.find(k => k.keep === view.keep) : undefined;
  if (keepHost && openKeep) {
    return (
      <KeepDetail
        host={keepHost}
        keep={openKeep}
        note={view.t === 'detail' ? view.note : undefined}
        setKeeps={setStored}
        onBack={() => setView({ t: 'list' })}
        onGone={() => setView({ t: 'list' })}
      />
    );
  }

  const storedBlock = keepHost && stored.length > 0
    ? (
      <div style={{ marginBottom: 16 }}>
        <StoredKeepRows host={keepHost} keeps={stored} onOpen={keep => setView({ t: 'detail', keep })} />
      </div>
    ) : null;
  const addButton = keepHost
    ? (
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <button className="btn btn-primary" onClick={() => setView({ t: 'add' })} style={{ width: 'auto' }}>Add a Keep</button>
      </div>
    ) : null;

  if (state.phase === 'loading') {
    return (
      <div className="fade-in" role="main">
        <Intro />
        {storedBlock}
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
        {storedBlock}
        <div className="empty-state">
          <p className="empty-state-text" role="alert">Couldn&apos;t reach the network. Try again.</p>
          <button className="btn btn-secondary" onClick={retry}>Try again</button>
          {addButton}
        </div>
      </div>
    );
  }

  if (state.keeps.length === 0) {
    if (storedBlock) {
      return (
        <div className="fade-in" role="main">
          <Intro />
          {storedBlock}
          {addButton}
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <button className="btn btn-secondary" onClick={onBack}>Back to Settings</button>
          </div>
        </div>
      );
    }
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="home" size={36} /></div>
          <h3 className="empty-state-title">No Keep yet.</h3>
          <p className="empty-state-text">
            A Keep is a small device at home that looks after your things. You can set one up with the Bothy app.
          </p>
          {keepHost && <button className="btn btn-primary" onClick={() => setView({ t: 'add' })}>Add a Keep</button>}
          <button className="btn btn-secondary" onClick={onBack}>Back to Settings</button>
          {!keepHost && <Footnote />}
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      {import.meta.env.DEV && preview && <PreviewBanner />}
      <Intro />
      {storedBlock}
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
      <Footnote text={keepHost ? FOOTNOTE_WITH_HOST : FOOTNOTE} />
      {addButton}
      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <button className="btn btn-secondary" onClick={onBack}>Back to Settings</button>
      </div>
    </div>
  );
}
