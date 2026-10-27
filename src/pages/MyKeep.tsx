/**
 * My Keep: the Keep(s) this identity has claimed, and whether each is online. Plain relay reads, so it
 * works on web too.
 *
 * Privacy: opening this page asks the relays nothing unless a Keep is already saved on this device, and
 * then only about that Keep's own keys, one request per Keep. With nothing saved, the person picks ONE
 * key to look under ("Look for my Keep"); a lookup that finds a Keep is remembered, encrypted, and later
 * opens ask about just that key. No request ever carries more than one owner's key set, never the
 * dormant real-name key, and the Heartwood master only when picked.
 *
 * A nickname is stored on this device only (`keep-nicknames.ts`) and never published.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadKeepLookups, loadStoredKeeps, rememberKeepLookup } from '../lib/keep-service';
import { keepLookupGroups } from '../lib/keep-owner';
import { KEEPS_UNREADABLE_TEXT } from '../lib/keep-store';
import { Icon } from '../components/Icon';
import { loadMyKeeps, type KeepLoadResult } from '../lib/keep-load';
import {
  displayName, formatBytes, presenceLabel, presenceOf, roleLabel, type Keep,
} from '../lib/keep';
import { NICKNAME_MAX, loadNicknames, setNickname } from '../lib/keep-nicknames';
import { KEEP_PREVIEW_BANNER, keepPreviewEnabled, keepPreviewKeeps } from '../lib/keep-preview';
import { AddKeep, KeepDetail, StoredKeepRows, useStoredKeeps, type KeepHost } from './KeepManage';

interface Props {
  /**
   * The Heartwood's own master key, hex, only on a bunker install (see `heartwoodLookupKey`). Queried alone, and
   * only when the person picks "My Heartwood" (or it was remembered from that pick).
   */
  heartwoodKey?: string | null;
  /** A Keep was saved here or a lookup found one: the app turns the My Keep row on in Settings. */
  onKeepsFound?: () => void;
  /** Identity id; nicknames are saved per identity. */
  scope: string;
  onBack: () => void;
  /** What adding and managing a Keep needs from the app. Absent where that is not offered. */
  keepHost?: KeepHost;
  /**
   * Set while the app is locked ('locked') or has the key and is still opening the saved identity
   * ('unlocking'). The saved Keeps are encrypted and a persona's key is needed to sign, so neither
   * the list nor "No Keep yet" is shown then: a locked app must not look like one with no Keep.
   */
  lock?: { state: 'locked'; onUnlock: () => void } | { state: 'unlocking' };
}

type State = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; keeps: Keep[]; now: number };

/** The "Look for my Keep" flow: choosing a key, asking, and what came back. */
type Lookup =
  | { t: 'pick' }
  | { t: 'searching'; label: string }
  | { t: 'none'; label: string }
  | { t: 'error' };

interface LookupOption { key: string; label: string; sub?: string }

const HEARTWOOD_LABEL = 'My Heartwood';
const HEARTWOOD_SUB = 'If the Keep was set up with your Heartwood';
const PICK_NOTE = 'Only the one you pick is sent to the network.';

/** Dev builds only: `?keep-preview` shows sample Keeps. Every use below is also behind `import.meta.env.DEV`, so a production build drops the preview code. */
const previewOn = () => import.meta.env.DEV && keepPreviewEnabled(import.meta.env.DEV, window.location.search);

const FOOTNOTE = 'Managing a Keep from here is coming later.';
const FOOTNOTE_WITH_HOST = 'Keeps set up outside My Signet can\u2019t be managed from here yet.';

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

/** The remembered lookup keys, read once the app is unlocked. Cleared when it locks. */
function useRememberedLookups(host: KeepHost | undefined) {
  const key = host?.deps.encryptionKey ?? '';
  const [keys, setKeys] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!key) { setKeys([]); setLoaded(false); return; }
    let cancelled = false;
    loadKeepLookups(key).then(list => { if (!cancelled) { setKeys(list); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [key]);
  const remember = useCallback((lookupKey: string) => {
    if (key) void rememberKeepLookup(key, lookupKey).catch(() => undefined);
  }, [key]);
  return { keys, loaded, remember };
}

/** Keeps from several lookups as one list, one row per Keep (later lists win). */
function mergeKeeps(...lists: Keep[][]): Keep[] {
  const byNode = new Map<string, Keep>();
  for (const list of lists) for (const keep of list) byNode.set(keep.claim.node, keep);
  return [...byNode.values()].sort((a, b) => b.claim.createdAt - a.claim.createdAt || (a.claim.node < b.claim.node ? -1 : 1));
}

function LookupPicker({ options, onPick, onCancel }: { options: LookupOption[]; onPick: (o: LookupOption) => void; onCancel: () => void }) {
  return (
    <div className="card card-flush" data-testid="keep-lookup-picker" role="group" aria-label="Look for my Keep under">
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', padding: '14px 16px 4px', margin: 0 }}>
        Which of you set up the Keep? {PICK_NOTE}
      </p>
      {options.map(o => (
        <button
          key={o.key}
          className="row-button"
          onClick={() => onPick(o)}
          style={{ width: '100%', textAlign: 'left', padding: '12px 16px', borderTop: '1px solid var(--border)' }}
        >
          <span style={{ fontWeight: 600, fontSize: '0.95rem', display: 'block', overflowWrap: 'anywhere' }}>{o.label}</span>
          {o.sub && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block' }}>{o.sub}</span>}
        </button>
      ))}
      <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
        <button className="btn btn-ghost" onClick={onCancel} style={{ width: 'auto' }}>Cancel</button>
      </div>
    </div>
  );
}

export function MyKeep({ heartwoodKey, onKeepsFound, scope, onBack, keepHost, lock }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [nicknames, setNicknames] = useState<Record<string, string>>(() => loadNicknames(scope));
  const [attempt, setAttempt] = useState(0);
  const [preview] = useState(previewOn);
  const [view, setView] = useState<View>({ t: 'list' });
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [found, setFound] = useState<{ keeps: Keep[]; now: number }>({ keeps: [], now: 0 });
  const { keeps: stored, setKeeps: setStored, loaded: storedLoaded, unreadable } = useStoredKeeps(keepHost);
  const remembered = useRememberedLookups(keepHost);
  const locked = !!lock;
  // Bumped on lock so a lookup that was in flight cannot land after it.
  const epochRef = useRef(0);
  const notifiedRef = useRef(false);

  // What the relays are asked about: each saved Keep's own keys, each remembered key alone. Nothing else.
  const groups = useMemo(() => keepLookupGroups(stored, remembered.keys), [stored, remembered.keys]);
  const groupsKey = JSON.stringify(groups);
  const ready = !keepHost || (storedLoaded && remembered.loaded);

  // Settings keeps its window scroll when this page opens; start at the top.
  useEffect(() => { try { window.scrollTo?.(0, 0); } catch { /* no scrolling here */ } }, []);

  // Locked: nothing decrypted stays on screen or in memory (the stored Keeps are cleared by their hook).
  useEffect(() => {
    if (!locked) return;
    epochRef.current += 1;
    setView({ t: 'list' });
    setLookup(null);
    setFound({ keeps: [], now: 0 });
    setState({ phase: 'loading' });
  }, [locked]);

  useEffect(() => {
    let cancelled = false;
    const nowS = () => Math.floor(Date.now() / 1000);
    if (import.meta.env.DEV && preview) {
      // Sample data (dev only): no relay is read, the rows render as real ones do.
      setState({ phase: 'ready', keeps: keepPreviewKeeps('0'.repeat(64), nowS()), now: nowS() });
      return;
    }
    if (locked || !ready) return;
    const asks = JSON.parse(groupsKey) as string[][];
    if (asks.length === 0) {
      // Nothing saved here and nothing remembered: the relays are not asked anything.
      setState({ phase: 'ready', keeps: [], now: nowS() });
      return;
    }
    setState({ phase: 'loading' });
    // One separate request per saved Keep / remembered key, so no request ties one key set to another.
    Promise.all(asks.map(authors => loadMyKeeps(authors).catch((): KeepLoadResult => ({ ok: false })))).then(results => {
      if (cancelled) return;
      const good = results.filter((r): r is Extract<KeepLoadResult, { ok: true }> => r.ok);
      if (good.length === 0) { setState({ phase: 'error' }); return; }
      setState({ phase: 'ready', keeps: mergeKeeps(...good.map(r => r.keeps)), now: Math.max(...good.map(r => r.now)) });
    });
    return () => { cancelled = true; };
  }, [groupsKey, ready, locked, attempt, preview]);

  const retry = useCallback(() => setAttempt(n => n + 1), []);

  const options = useMemo<LookupOption[]>(() => {
    const list: LookupOption[] = (keepHost?.personas ?? []).map(p => ({ key: p.pubkey.toLowerCase(), label: p.name }));
    if (heartwoodKey) list.push({ key: heartwoodKey.toLowerCase(), label: HEARTWOOD_LABEL, sub: HEARTWOOD_SUB });
    return list;
  }, [keepHost, heartwoodKey]);

  const runLookup = async (option: LookupOption) => {
    const epoch = epochRef.current;
    setLookup({ t: 'searching', label: option.label });
    let result: KeepLoadResult;
    try { result = await loadMyKeeps([option.key]); } catch { result = { ok: false }; }
    if (epoch !== epochRef.current) return;
    if (!result.ok) { setLookup({ t: 'error' }); return; }
    if (result.keeps.length === 0) { setLookup({ t: 'none', label: option.label }); return; }
    setFound(f => ({ keeps: mergeKeeps(f.keeps, result.keeps), now: result.now }));
    setLookup(null);
    remembered.remember(option.key);
  };

  const keeps = useMemo(
    () => (state.phase === 'ready' ? mergeKeeps(found.keeps, state.keeps) : mergeKeeps(found.keeps)),
    [state, found],
  );
  const listNow = state.phase === 'ready' ? Math.max(state.now, found.now) : found.now;

  // A saved Keep or a found one: the app turns the Settings row on (once per visit).
  const hasKeep = !preview && (stored.length > 0 || keeps.length > 0);
  useEffect(() => {
    if (!hasKeep || notifiedRef.current) return;
    notifiedRef.current = true;
    onKeepsFound?.();
  }, [hasKeep, onKeepsFound]);

  if (lock) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="home" size={36} /></div>
          {lock.state === 'locked' ? (
            <>
              <h3 className="empty-state-title" data-testid="keep-locked">Locked.</h3>
              <p className="empty-state-text">Unlock to see your Keeps and add one.</p>
              <button className="btn btn-primary" onClick={lock.onUnlock}>Unlock</button>
            </>
          ) : (
            <p className="empty-state-text" role="status" data-testid="keep-unlocking">Unlocking&hellip;</p>
          )}
          <button className="btn btn-secondary" onClick={onBack}>Back to Settings</button>
        </div>
      </div>
    );
  }

  if (keepHost && view.t === 'add') {
    return (
      <AddKeep
        host={keepHost}
        known={stored}
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

  const storedBlock = keepHost && unreadable
    ? (
      <p role="alert" data-testid="keeps-unreadable" style={{ fontSize: '0.9rem', margin: '0 0 16px' }}>{KEEPS_UNREADABLE_TEXT}</p>
    ) : keepHost && stored.length > 0
    ? (
      <div style={{ marginBottom: 16 }}>
        <StoredKeepRows host={keepHost} keeps={stored} onOpen={keep => setView({ t: 'detail', keep })} />
      </div>
    ) : null;
  const addButton = keepHost && !unreadable
    ? (
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <button className="btn btn-primary" onClick={() => setView({ t: 'add' })} style={{ width: 'auto' }}>Add a Keep</button>
      </div>
    ) : null;

  if (state.phase === 'loading' && keeps.length === 0) {
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

  if (state.phase === 'error' && keeps.length === 0) {
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

  if (keeps.length === 0) {
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
    const canLook = !!keepHost && !unreadable && options.length > 0;
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="home" size={36} /></div>
          <h3 className="empty-state-title">No Keep yet.</h3>
          <p className="empty-state-text">
            A Keep is a small device at home that looks after your things.
          </p>
          {lookup?.t === 'pick' || lookup?.t === 'none' || lookup?.t === 'error' ? (
            <>
              {lookup.t === 'none' && <p role="status" className="empty-state-text">No Keep found under {lookup.label}. Try another.</p>}
              {lookup.t === 'error' && <p role="alert" className="empty-state-text">Couldn&apos;t reach the network. Try again.</p>}
              <LookupPicker options={options} onPick={o => { void runLookup(o); }} onCancel={() => setLookup(null)} />
            </>
          ) : lookup?.t === 'searching' ? (
            <p role="status" className="empty-state-text">Looking under {lookup.label}&hellip;</p>
          ) : (
            canLook && <button className="btn btn-primary" onClick={() => setLookup({ t: 'pick' })}>Look for my Keep</button>
          )}
          {keepHost && !unreadable && <button className="btn btn-secondary" onClick={() => setView({ t: 'add' })}>Add a Keep</button>}
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
        {keeps.map((keep, i) => (
          <KeepRow
            key={keep.claim.node}
            keep={keep}
            now={listNow}
            nickname={nicknames[keep.claim.node]}
            last={i === keeps.length - 1}
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
