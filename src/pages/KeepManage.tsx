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
  PersonaNotAvailableError, catchUp, claimKeep, createInvite, forgetKeep, keepShareLink, loadStoredKeeps, resendClaim,
  resendInvite, revokeInvite, watchAcks, type KeepDeps,
} from '../lib/keep-service';
import { KEEPS_UNREADABLE_TEXT, KeepsUnreadableError, inviteStatusLabel, isExpired, type StoredInvite, type StoredKeep } from '../lib/keep-store';
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
  /** The owner directory's contacts; null when this view cannot offer them. */
  contacts: EffectiveContact[] | null;
  /** The PIN / biometric check before a Keep is claimed. True when confirmed. */
  confirmClaim: (keepName: string, personaName: string) => Promise<boolean>;
}

export const NOT_AVAILABLE = 'Not available for this persona yet.';

const muted = { fontSize: '0.8rem', color: 'var(--text-muted)' } as const;
const smallBtn = { fontSize: '0.8rem', padding: '6px 12px', width: 'auto', flexShrink: 0 } as const;

export function ownerLabel(host: KeepHost, keep: StoredKeep): string {
  const name = (p: string) => host.personaNames[p] || `Persona ${p.slice(0, 8)}`;
  return `Owned by ${keep.personas.map(name).join(', ')}`;
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
  const watchKey = keeps.map(k => `${k.claimedBy}@${k.relays.join(',')}`).sort().join('|');

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
          <div style={muted}>{ownerLabel(host, keep)}</div>
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
      const result = await claimKeep(host.deps, link, persona.pubkey);
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
              It will belong to <strong>{persona.name}</strong>. Only this persona will be able to say who plays on it.
            </p>
          )}
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

export function KeepDetail({ host, keep, note, setKeeps, onBack, onGone }: {
  host: KeepHost; keep: StoredKeep; note?: string; setKeeps: (list: StoredKeep[]) => void;
  onBack: () => void; onGone: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(note ?? '');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
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
    try { await work(); } catch (e) {
      setMessage(e instanceof PersonaNotAvailableError ? NOT_AVAILABLE
        : e instanceof KeepsUnreadableError ? KEEPS_UNREADABLE_TEXT : 'Something went wrong. Try again.');
    } finally { setBusy(false); }
  };

  const shareOutcome = (outcome: string) => {
    if (outcome === 'copied') setMessage('Link copied.');
    else if (outcome === 'failed') setMessage('Couldn’t open the share sheet or copy the link. Use Share link on the invite.');
  };

  const makeInvite = (req: Parameters<typeof createInvite>[2]) => run(async () => {
    // The share sheet needs the tap that started this, so it opens as soon as the invite is
    // saved, while the wrap for the Keep is still being sent.
    let sharing: Promise<string> = Promise.resolve('');
    const made = await createInvite(host.deps, keep.keep, req, saved => {
      sharing = shareInviteLink(keepShareLink(keep.keep, saved.secret));
    });
    await reload();
    setPicking(false);
    if (!made.sent) setMessage('Couldn\u2019t reach the Keep yet. Use Send again on the invite.');
    shareOutcome(await sharing);
  });

  const candidates = picking && host.contacts ? inviteCandidates(host.contacts, keep.claimedBy) : [];
  const invites = [...keep.invites].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="fade-in" role="main">
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: '1.05rem', overflowWrap: 'anywhere' }}>{keep.name}</div>
        <div style={{ fontSize: '0.85rem', color: keep.status === 'paired' ? 'var(--success)' : 'var(--text-secondary)', fontWeight: 500 }}>
          {statusLine(keep)}
        </div>
        <div style={muted}>{ownerLabel(host, keep)}</div>
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
      ) : (
        <section aria-labelledby="keep-games">
          <h3 id="keep-games" className="section-title" style={{ margin: '0 0 8px' }}>Games</h3>
          <div className="card card-flush">
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>Who can play</div>
              {!canSign ? (
                <p role="alert" style={{ fontSize: '0.9rem', margin: '4px 0 0' }}>{NOT_AVAILABLE}</p>
              ) : (
                <>
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
                </>
              )}
              {picking && (
                <div data-testid="contact-picker" style={{ marginTop: 12 }}>
                  {host.contacts === null ? (
                    <p style={muted}>Open My Signet from your own card to pick a contact.</p>
                  ) : candidates.length === 0 ? (
                    <p style={muted}>No Kin or Kith on {host.personaNames[keep.claimedBy] || 'this persona'}’s contacts yet. A guest pass works for anyone.</p>
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
                onResend={i => { void run(async () => { setMessage((await resendInvite(host.deps, keep, i)) ? 'Sent again.' : 'Couldn’t reach the Keep.'); }); }}
                onRevoke={i => { void run(async () => {
                  const sent = await revokeInvite(host.deps, keep.keep, i.grant);
                  await reload();
                  setMessage(sent ? 'Revoke sent. It applies as soon as the Keep is online.' : 'Couldn’t reach the Keep yet. It will apply when you send it again.');
                }); }}
              />
            ))}
          </div>
        </section>
      )}

      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={onBack}>Back to My Keep</button>
      </div>
    </div>
  );
}
