/**
 * Managing the Keeps this account has claimed (K1d): add one, see its state,
 * and decide who can play on it. Used from the My Keep screen.
 *
 * Everything here is sent to the Keep as owner-signed gift wraps (see
 * `keep-service.ts`). Only a persona whose key this device holds can do it; any
 * other persona sees "Not available for this persona yet". Invite links hold a
 * secret: they exist only inside the share and copy actions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EffectiveContact } from '../types';
import { parseKeepPairLink, type KeepPairLink } from '../lib/keep-link';
import {
  NotAnOwnerError, OwnerChangeRefusedError, PersonaNotAvailableError, ackPersonas, catchUp, changeOwners, claimKeep, createInvite,
  forgetKeep, keepShareLink, loadStoredKeeps, resendClaim, resendInvite, retryGamesInvite, revokeInvite, watchAcks,
  type KeepDeps, type OwnerChange,
} from '../lib/keep-service';
import {
  KEEPS_UNREADABLE_TEXT, KeepsUnreadableError, inviteStatusLabel, isExpired, refusalText, type KeepScope, type StoredInvite, type StoredKeep,
} from '../lib/keep-store';
import { canUnlink, gamesOn, gamesState, isActiveOwner, isLinked, playInvite, scopeLabel, updateFailedText } from '../lib/keep-owners';
import { KEEP_MAX_OWNER_PERSONAS } from '../lib/keep-wire';
import { inviteCandidates } from '../lib/keep-personas';
import { shareInviteLink } from '../lib/keep-share';
import { relayHostLabel } from '../lib/relay-url';

/** What the My Keep screen needs from the app to manage claimed Keeps. */
export interface KeepHost {
  deps: KeepDeps;
  /** Whether this device holds the signing key of a persona (only those can own a Keep for now). */
  canSign: (persona: string) => boolean;
  /** The persona that is active now: the one that would own a Keep added now. */
  activePersona: { pubkey: string; name: string } | null;
  /** Persona public key to the name the person gave it. */
  personaNames: Record<string, string>;
  /** Every persona of the account (dependants left out), with whether this device can sign for it. */
  personas: Array<{ pubkey: string; name: string; canSign: boolean }>;
  /**
   * Opens a link in the phone app registered for it. Only where that means something (the
   * Android app); absent on the web, where Play here is not offered.
   */
  openApp?: (link: string) => void;
  /** The owner directory's contacts; null when this view cannot offer them. */
  contacts: EffectiveContact[] | null;
  /** The PIN / biometric check before a Keep is claimed. True when confirmed. */
  confirmClaim: (keepName: string, personaName: string) => Promise<boolean>;
  /** The same check before an owner persona is linked to a Keep or unlinked from it. True when confirmed. */
  confirmOwnerChange: (keepName: string, personaName: string, linking: boolean) => Promise<boolean>;
}

export const NOT_AVAILABLE = 'Not available for this persona yet.';

const muted = { fontSize: '0.8rem', color: 'var(--text-muted)' } as const;
const smallBtn = { fontSize: '0.8rem', padding: '6px 12px', width: 'auto', flexShrink: 0 } as const;

const nameOf = (host: KeepHost) => (p: string) => host.personaNames[p] || `Persona ${p.slice(0, 8)}`;

/** "All of you" or "Only <persona names>", for every persona alike. Personas this device cannot link do not count against "All". */
export function keepScopeLabel(host: KeepHost, keep: StoredKeep): string {
  return scopeLabel(keep, host.personas.filter(p => p.canSign).map(p => p.pubkey), nameOf(host));
}

function errorText(e: unknown): string {
  if (e instanceof PersonaNotAvailableError) return NOT_AVAILABLE;
  if (e instanceof KeepsUnreadableError) return KEEPS_UNREADABLE_TEXT;
  if (e instanceof NotAnOwnerError) return 'This persona is not linked to the Keep, so it cannot change it.';
  if (e instanceof OwnerChangeRefusedError) return e.message;
  return 'Something went wrong. Try again.';
}

export function expiryText(expiration: number, now: number): string {
  if (expiration <= now) return 'Expired';
  // Nearest hour: `now` can be up to 30 s behind the clock, so a 24 hour pass must not read 25.
  const hours = Math.max(1, Math.round((expiration - now) / 3600));
  if (hours <= 48) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `Expires ${new Date(expiration * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/** The stored Keeps, kept fresh: loaded on open, caught up on acks, then live while mounted. */
export function useStoredKeeps(host: KeepHost | undefined) {
  const [keeps, setKeeps] = useState<StoredKeep[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const depsRef = useRef(host?.deps);
  depsRef.current = host?.deps;
  const key = host?.deps.encryptionKey ?? '';
  const watchKey = keeps.map(k => `${ackPersonas(k).join('+')}@${k.relays.join(',')}`).sort().join('|');

  useEffect(() => {
    const deps = depsRef.current;
    if (!deps) return;
    let cancelled = false;
    loadStoredKeeps(deps.encryptionKey).then(async list => {
      if (cancelled) return;
      setKeeps(list);
      setLoaded(true);
      if (list.length === 0) return;
      const fresh = await catchUp(deps).catch(() => list);
      if (!cancelled) setKeeps(fresh);
    }, e => {
      if (cancelled) return;
      setLoaded(true);
      if (e instanceof KeepsUnreadableError) setUnreadable(true);
    });
    return () => { cancelled = true; };
  }, [key]);

  useEffect(() => {
    const deps = depsRef.current;
    if (!deps || keeps.length === 0) return;
    return watchAcks(deps, keeps, list => setKeeps(list));
    // Re-subscribe only when the set of (persona, relays) to listen on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchKey, key]);

  return { keeps, setKeeps, loaded, unreadable };
}

function statusLine(keep: StoredKeep): string {
  return keep.status === 'paired' ? 'Connected' : 'Waiting for the Keep';
}

export function StoredKeepRows({ host, keeps, onOpen }: { host: KeepHost; keeps: StoredKeep[]; onOpen: (keep: string) => void }) {
  return (
    <div className="card card-flush" data-testid="stored-keeps">
      {keeps.map((keep, i) => (
        <button
          key={keep.keep}
          className="row-button"
          data-testid="stored-keep-row"
          onClick={() => onOpen(keep.keep)}
          style={{ width: '100%', textAlign: 'left', padding: '14px 16px', borderBottom: i === keeps.length - 1 ? 'none' : '1px solid var(--border)' }}
        >
          <div style={{ fontWeight: 600, fontSize: '0.95rem', overflowWrap: 'anywhere' }}>{keep.name}</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{statusLine(keep)}</div>
          <div style={muted}>{keepScopeLabel(host, keep)}</div>
        </button>
      ))}
    </div>
  );
}

// ---- Add a Keep ------------------------------------------------------------

export function AddKeep({ host, onDone, onCancel }: {
  host: KeepHost; onDone: (keep: string, note?: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [link, setLink] = useState<KeepPairLink | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<KeepScope>('all');
  const persona = host.activePersona;
  const canSign = !!persona && host.canSign(persona.pubkey);

  const next = () => {
    const parsed = parseKeepPairLink(text);
    if (!parsed) { setError('That is not a Keep link. Copy it again from the Keep’s own screen.'); return; }
    setError('');
    setLink(parsed);
  };

  const confirm = async () => {
    if (!link || !persona || !canSign || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!await host.confirmClaim(link.name, persona.name)) { setError('Not confirmed. Nothing was sent.'); return; }
      const result = await claimKeep(host.deps, link, persona.pubkey, scope);
      if (result.kind === 'exists') { onDone(result.keep.keep, 'You have already added this Keep.'); return; }
      if (result.kind === 'other-owner') {
        const owner = host.personaNames[result.keep.claimedBy] || 'another persona';
        setError(`This Keep already belongs to ${owner}. Switch to that persona to pair it again. Nothing was sent.`);
        return;
      }
      onDone(result.keep.keep, result.sent ? undefined : 'Couldn’t reach the Keep. Try Send again in a moment.');
    } catch (e) {
      setError(e instanceof PersonaNotAvailableError ? NOT_AVAILABLE
        : e instanceof KeepsUnreadableError ? KEEPS_UNREADABLE_TEXT : 'Something went wrong. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    return (
      <div className="fade-in" role="main">
        <div className="card" style={{ padding: 16 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '1.05rem', overflowWrap: 'anywhere' }}>Make {link.name} your Keep?</h3>
          {persona && (
            <p style={{ fontSize: '0.9rem', margin: '0 0 8px' }}>
              <strong>{persona.name}</strong> will set it up. Who can use it?
            </p>
          )}
          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }} disabled={busy}>
            <legend style={{ ...muted, padding: 0, marginBottom: 4 }}>Who can use this Keep</legend>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6, fontSize: '0.9rem' }}>
              <input type="radio" name="keep-scope" checked={scope === 'all'} onChange={() => setScope('all')} style={{ marginTop: 3 }} />
              <span>
                <strong>All my personas</strong>
                <span style={{ ...muted, display: 'block' }}>Every persona of yours can use and manage it, including ones you make later.</span>
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.9rem' }}>
              <input type="radio" name="keep-scope" checked={scope === 'one'} onChange={() => setScope('one')} style={{ marginTop: 3 }} />
              <span>
                <strong>Only this persona</strong>
                <span style={{ ...muted, display: 'block' }}>Just {persona?.name ?? 'this persona'}. You can link others later.</span>
              </span>
            </label>
          </fieldset>
          <p style={{ ...muted, margin: '0 0 12px' }}>Talks to: {link.relays.map(relayHostLabel).join(', ')}</p>
          {!canSign && <p role="alert" style={{ fontSize: '0.9rem', color: 'var(--danger, #b00020)' }}>{NOT_AVAILABLE}</p>}
          {error && <p role="alert" style={{ fontSize: '0.9rem', color: 'var(--danger, #b00020)' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={!canSign || busy} onClick={() => { void confirm(); }} style={{ width: 'auto' }}>
              {busy ? 'Sending…' : 'Make it my Keep'}
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={onCancel} style={{ width: 'auto' }}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '1.05rem' }}>Add a Keep</h3>
        <p style={{ fontSize: '0.9rem', margin: '0 0 8px', color: 'var(--text-secondary)' }}>
          Open the Keep’s own screen on the device it runs on, copy its link and paste it here.
        </p>
        <textarea
          className="input"
          aria-label="Keep link"
          rows={3}
          value={text}
          placeholder="signet-keep:pair?…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={e => { setText(e.target.value); setError(''); }}
          style={{ width: '100%', marginBottom: 8 }}
        />
        {error && <p role="alert" style={{ fontSize: '0.9rem', color: 'var(--danger, #b00020)', margin: '0 0 8px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={next} style={{ width: 'auto' }}>Continue</button>
          <button className="btn btn-secondary" onClick={onCancel} style={{ width: 'auto' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---- One Keep --------------------------------------------------------------

function InviteRow({ invite, now, busy, onShare, onRevoke, onResend }: {
  invite: StoredInvite; now: number; busy: boolean;
  onShare: (i: StoredInvite) => void; onRevoke: (i: StoredInvite) => void; onResend: (i: StoredInvite) => void;
}) {
  const dead = invite.status === 'revoked' || invite.status === 'refused';
  const expired = isExpired(invite, now);
  return (
    <div data-testid="invite-row" style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 600, fontSize: '0.95rem', overflowWrap: 'anywhere' }}>
        {invite.kind === 'guest' ? 'Guest pass' : (invite.label || 'A friend')}
      </div>
      <div style={{ fontSize: '0.85rem', color: invite.status === 'active' ? 'var(--success)' : 'var(--text-secondary)', fontWeight: 500 }}>
        {inviteStatusLabel(invite)}
      </div>
      <div style={muted}>{expiryText(invite.expiration, now)}</div>
      {!dead && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {!expired && <button className="btn btn-ghost" disabled={busy} onClick={() => onShare(invite)} style={smallBtn}>Share link</button>}
          {invite.status === 'waiting' && !invite.revokeSent && !expired && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => onResend(invite)} style={smallBtn}>Send again</button>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => onRevoke(invite)} style={smallBtn}>
            {invite.revokeSent ? 'Send revoke again' : 'Revoke'}
          </button>
        </div>
      )}
    </div>
  );
}

function SwitchRow({ label, sub, checked, disabled, onChange, testId }: {
  label: string; sub?: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void; testId?: string;
}) {
  return (
    <label
      data-testid={testId}
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, fontSize: '0.95rem', overflowWrap: 'anywhere' }}>{label}</span>
        {sub && <span style={{ ...muted, display: 'block' }}>{sub}</span>}
      </span>
      <input
        type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)} style={{ width: 22, height: 22, flexShrink: 0 }}
      />
    </label>
  );
}

export function KeepDetail({ host, keep, note, setKeeps, onBack, onGone }: {
  host: KeepHost; keep: StoredKeep; note?: string; setKeeps: (list: StoredKeep[]) => void;
  onBack: () => void; onGone: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(note ?? '');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const name = nameOf(host);
  const actor = host.activePersona;
  // Actions are for the signed-in persona only, and only when the Keep counts it as an active owner and this device holds its key.
  const actorIsOwner = !!actor && isActiveOwner(keep, actor.pubkey);
  const canAct = actorIsOwner && host.canSign(actor.pubkey);
  const canSign = host.canSign(keep.claimedBy);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  // Opening the Keep reads its acks again and sends again what it has not answered.
  useEffect(() => {
    let cancelled = false;
    catchUp(host.deps).then(list => { if (!cancelled) setKeeps(list); }, () => undefined);
    return () => { cancelled = true; };
    // Once per Keep opened; `host.deps` is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep.keep, host.deps.encryptionKey]);

  const reload = useCallback(async () => { setKeeps(await loadStoredKeeps(host.deps.encryptionKey)); }, [host.deps.encryptionKey, setKeeps]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try { await work(); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  };

  const change = (c: OwnerChange, done?: string) => run(async () => {
    if (!actor) return;
    // Linking or unlinking a persona asks for the PIN, as the claim does. Trying again repeats a change already confirmed.
    if ((c.kind === 'link' || c.kind === 'unlink') && !await host.confirmOwnerChange(keep.name, name(c.persona), c.kind === 'link')) {
      setMessage('Not confirmed. Nothing was sent.');
      return;
    }
    setKeeps(await changeOwners(host.deps, keep.keep, actor.pubkey, c));
    if (done) setMessage(done);
  });

  const shareOutcome = (outcome: string) => {
    if (outcome === 'copied') setMessage('Link copied.');
    else if (outcome === 'failed') setMessage('Couldn’t open the share sheet or copy the link. Use Share link on the invite.');
  };

  const makeInvite = (req: Parameters<typeof createInvite>[2]) => run(async () => {
    // The share sheet needs the tap that started this, so it opens as soon as the invite is
    // saved, while the wrap for the Keep is still being sent.
    let sharing: Promise<string> = Promise.resolve('');
    const made = await createInvite(host.deps, keep.keep, { ...req, actor: actor?.pubkey }, saved => {
      sharing = shareInviteLink(keepShareLink(keep.keep, saved.secret));
    });
    await reload();
    setPicking(false);
    if (!made.sent) setMessage('Couldn’t reach the Keep yet. Use Send again on the invite.');
    shareOutcome(await sharing);
  });

  // The link holds a secret: it is built here, in the tap, and handed to the phone's own app opener.
  const playHere = () => {
    const invite = actor ? playInvite(keep, actor.pubkey, Math.floor(Date.now() / 1000)) : null;
    if (!invite || !host.openApp) return;
    host.openApp(keepShareLink(keep.keep, invite.secret));
    setMessage('Opening Stampede…');
  };

  const candidates = picking && host.contacts && actor ? inviteCandidates(host.contacts, actor.pubkey) : [];
  // The owner personas' own games invites are managed by Used by, not listed as invites for members.
  const invites = keep.invites.filter(i => !i.gamesFor).sort((a, b) => b.createdAt - a.createdAt);
  const failedText = updateFailedText(keep.update);
  const linkableCount = keep.personas.length;
  const mine = actor && isLinked(keep, actor.pubkey);

  return (
    <div className="fade-in" role="main">
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: '1.05rem', overflowWrap: 'anywhere' }}>{keep.name}</div>
        <div style={{ fontSize: '0.85rem', color: keep.status === 'paired' ? 'var(--success)' : 'var(--text-secondary)', fontWeight: 500 }}>
          {statusLine(keep)}
        </div>
        <div style={muted} data-testid="keep-scope">{keepScopeLabel(host, keep)}</div>
        {keep.update && !keep.update.failed && keep.status === 'paired' && <div style={muted}>Updating the Keep…</div>}
      </div>

      {message && <p role="status" style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 12px' }}>{message}</p>}

      {keep.status === 'pending' ? (
        <div className="card" style={{ padding: 16 }}>
          <p style={{ fontSize: '0.9rem', margin: '0 0 12px', color: 'var(--text-secondary)' }}>
            Waiting for the Keep to answer. This needs the Keep to be switched on and online.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canSign && (
              <button className="btn btn-secondary" disabled={busy} style={{ width: 'auto' }}
                onClick={() => { void run(async () => { setMessage((await resendClaim(host.deps, keep)) ? 'Sent again.' : 'Couldn’t reach the Keep.'); }); }}>
                Send again
              </button>
            )}
            <button className="btn btn-ghost" disabled={busy} style={{ width: 'auto' }}
              onClick={() => { void run(async () => { setKeeps(await forgetKeep(host.deps, keep.keep)); onGone(); }); }}>
              Forget this Keep
            </button>
          </div>
        </div>
      ) : !actorIsOwner ? (
        <div className="card" style={{ padding: 16 }} data-testid="not-linked">
          <p style={{ fontSize: '0.9rem', margin: 0, color: 'var(--text-secondary)' }}>
            {mine
              ? `Waiting for the Keep to confirm ${actor ? name(actor.pubkey) : 'this persona'}.`
              : `${actor ? name(actor.pubkey) : 'This persona'} isn’t linked to this Keep.`}
            {' '}It is used and managed from {keep.personas.map(name).join(', ')}.
          </p>
        </div>
      ) : !canAct ? (
        <div className="card" style={{ padding: 16 }}>
          <p role="alert" style={{ fontSize: '0.9rem', margin: 0 }}>{NOT_AVAILABLE}</p>
        </div>
      ) : (
        <>
          <section aria-labelledby="keep-personas" style={{ marginBottom: 16 }}>
            <h3 id="keep-personas" className="section-title" style={{ margin: '0 0 8px' }}>Linked personas</h3>
            <div className="card" style={{ padding: '4px 16px 12px' }}>
              <p style={{ ...muted, margin: '8px 0 0' }}>The Keep will be able to tell that these personas are the same person, and the relays it uses may be able to as well. Nobody else can.</p>
              {host.personas.map(p => {
                const linked = isLinked(keep, p.pubkey);
                const confirmed = isActiveOwner(keep, p.pubkey);
                const last = linked && !canUnlink(keep, p.pubkey);
                const full = !linked && linkableCount >= KEEP_MAX_OWNER_PERSONAS;
                const sub = !p.canSign && !linked ? NOT_AVAILABLE
                  : last ? 'The Keep needs at least one persona it has confirmed.'
                  : full ? 'The most personas a Keep can have.'
                  : linked && !confirmed ? 'Waiting for the Keep' : undefined;
                return (
                  <SwitchRow
                    key={p.pubkey} testId="linked-persona" label={p.name} sub={sub} checked={linked}
                    disabled={busy || last || full || (!linked && !p.canSign)}
                    onChange={on => { void change({ kind: on ? 'link' : 'unlink', persona: p.pubkey }); }}
                  />
                );
              })}
              {failedText && (
                <div style={{ marginTop: 10 }}>
                  <p role="alert" style={{ fontSize: '0.85rem', margin: '0 0 6px' }}>{failedText}</p>
                  <button className="btn btn-secondary" disabled={busy} style={smallBtn} onClick={() => { void change({ kind: 'retry' }); }}>Try again</button>
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="keep-games">
            <h3 id="keep-games" className="section-title" style={{ margin: '0 0 8px' }}>Games</h3>
            <div className="card card-flush">
              <div style={{ padding: '14px 16px' }}>
                <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>Used by</div>
                <div data-testid="used-by">
                  {keep.personas.map(p => {
                    const state = gamesState(keep, p, now);
                    const on = gamesOn(keep, p);
                    const sub = state === 'waiting' ? 'Waiting for the Keep'
                      : state === 'refused' ? `The Keep said no: ${refusalText(keep.invites.filter(i => i.gamesFor === p).sort((x, y) => y.createdAt - x.createdAt)[0]?.reason)}`
                      : undefined;
                    return (
                      <div key={p}>
                        <SwitchRow
                          testId="used-by-persona" label={name(p)} sub={sub} checked={on} disabled={busy || !host.canSign(p) && !on}
                          onChange={next => { void change({ kind: 'games', persona: p, on: next }); }}
                        />
                        {state === 'refused' && (
                          <button className="btn btn-ghost" disabled={busy} style={{ ...smallBtn, marginBottom: 6 }}
                            onClick={() => { void run(async () => { setKeeps(await retryGamesInvite(host.deps, keep.keep, actor!.pubkey, p)); }); }}>
                            Try again
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {actor && isLinked(keep, actor.pubkey) && gamesOn(keep, actor.pubkey) && (
                <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)' }} data-testid="play-here">
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>Play here</div>
                  {host.openApp ? (
                    <>
                      <p style={{ ...muted, margin: '0 0 10px' }}>
                        Opens Stampede on this phone. Stampede must be installed and signed in as <strong>{actor.name}</strong>.
                      </p>
                      <button className="btn btn-primary" style={{ width: 'auto' }}
                        disabled={busy || !playInvite(keep, actor.pubkey, now)} onClick={playHere}>
                        Play here
                      </button>
                      {!playInvite(keep, actor.pubkey, now) && <p style={{ ...muted, margin: '8px 0 0' }}>Waiting for the Keep to say {actor.name} can play.</p>}
                    </>
                  ) : (
                    <p style={{ ...muted, margin: 0 }}>Open My Signet on your phone to play from here.</p>
                  )}
                </div>
              )}

              <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>Who can play</div>
                <p style={{ ...muted, margin: '0 0 10px' }}>Only people you invite can play on this Keep.</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" disabled={busy} style={{ width: 'auto' }} onClick={() => setPicking(p => !p)}>
                    Invite a friend
                  </button>
                  <button className="btn btn-secondary" disabled={busy} style={{ width: 'auto' }}
                    onClick={() => { void makeInvite({ kind: 'guest' }); }}>
                    Guest pass
                  </button>
                </div>
                {picking && (
                  <div data-testid="contact-picker" style={{ marginTop: 12 }}>
                    {host.contacts === null ? (
                      <p style={muted}>Open My Signet from your own card to pick a contact.</p>
                    ) : candidates.length === 0 ? (
                      <p style={muted}>No Kin or Kith on {actor ? name(actor.pubkey) : 'this persona'}’s contacts yet. A guest pass works for anyone.</p>
                    ) : (
                      candidates.map(c => (
                        <button
                          key={c.contactId}
                          className="row-button"
                          disabled={busy}
                          data-testid="contact-option"
                          onClick={() => { void makeInvite({ kind: 'personal', persona: c.persona, label: c.name }); }}
                          style={{ width: '100%', textAlign: 'left', padding: '10px 0', borderBottom: '1px solid var(--border)' }}
                        >
                          <span style={{ fontWeight: 600 }}>{c.name}</span>
                          <span style={{ ...muted, marginLeft: 8 }}>{c.tier === 'kin' ? 'Kin' : 'Kith'}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              {invites.length === 0 && <div style={{ ...muted, padding: '0 16px 14px' }}>No invites yet.</div>}
              {invites.map(invite => (
                <InviteRow
                  key={invite.grant} invite={invite} now={now} busy={busy}
                  onShare={i => { void run(async () => { shareOutcome(await shareInviteLink(keepShareLink(keep.keep, i.secret))); }); }}
                  onResend={i => { void run(async () => { setMessage((await resendInvite(host.deps, keep, i, actor?.pubkey)) ? 'Sent again.' : 'Couldn’t reach the Keep.'); }); }}
                  onRevoke={i => { void run(async () => {
                    const sent = await revokeInvite(host.deps, keep.keep, i.grant, actor?.pubkey);
                    await reload();
                    setMessage(sent ? 'Revoke sent. It applies as soon as the Keep is online.' : 'Couldn’t reach the Keep yet. It will apply when you send it again.');
                  }); }}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={onBack}>Back to My Keep</button>
      </div>
    </div>
  );
}
