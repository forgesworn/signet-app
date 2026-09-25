import { shortNpub } from '../lib/signet';
import { useState } from 'react';
import {
  buildKeyControlChallenge,
  verifyKeyControl,
  resolveKen,
  acceptKenRotation,
  revokeKen,
} from '@forgesworn/kenspeckle/ken';
import type { KenEntry } from '@forgesworn/kenspeckle';
import { ContactShareQR } from '../components/ContactShareQR';
import { ContactAvatar } from '../components/ContactAvatar';
import { useContactAvatar } from '../hooks/useContactAvatar';
import { fetchPublicProfile, safeImageOrLinkUrl } from '../lib/public-profile-publish';

interface Props {
  entry: KenEntry;
  onAddKen: (entry: KenEntry) => Promise<void>;
  onRemoveKen: (pubkey: string) => Promise<void>;
  onBack: () => void;
  relayUrl: string;
  encryptionKey: string | null;
}

type Section = 'overview' | 'key-control' | 'rotation' | 'revoke-confirm';

function truncPubkey(pk: string): string {
  return shortNpub(pk);
}

function truncStr(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function provenanceLabel(source: KenEntry['provenance']['source']): string {
  const labels: Record<KenEntry['provenance']['source'], string> = {
    nip05: 'NIP-05',
    dns: 'DNS',
    web: 'Web',
    'social-channel': 'Social channel',
    'in-person': 'In person',
    manual: 'Manual',
  };
  return labels[source] ?? source;
}

/** Map a kenspeckle throw to calm, human copy — never the library's own
 *  message text. `acceptKenRotation` (0.2.0) also throws on a revoked
 *  entry, an already-accepted rotation, and `newPubkey === pubkey`; the UI
 *  gates all three away (rotation actions are hidden on a revoked entry,
 *  `pendingRotation` excludes an accepted rotation, and a same-key rotation
 *  never gets proposed), so any throw reaching here is unexpected. */
function humaniseKenDetailError(_e: unknown, fallback: string): string {
  return fallback;
}

export function KenDetail({ entry, onAddKen, onRemoveKen, onBack, relayUrl, encryptionKey }: Props) {

  const avatarUrl = useContactAvatar(entry.pubkey, relayUrl, encryptionKey);
  const [section, setSection] = useState<Section>('overview');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Key-control state
  const [challenge, setChallenge] = useState<{ nonce: string; createdAt: number } | null>(null);
  const [signedEventJson, setSignedEventJson] = useState('');
  const [keyControlResult, setKeyControlResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  // Rotation state
  const [resolved, setResolved] = useState<KenEntry | null>(null);
  const [resolving, setResolving] = useState(false);
  // A rollback proposal (resolved.rotation.rollback) needs an explicit
  // second confirm before acceptKenRotation is called with allowRevert.
  const [revertConfirming, setRevertConfirming] = useState(false);
  // Set at resolve time from `resolveKen`'s return-value identity against
  // the SAME entry reference that was passed in — never recomputed later by
  // comparing `resolved` against the render-time `entry` prop, which can be
  // a freshly-constructed object for the same logical record (App.tsx's
  // `kens.find(...)`) and would make an `===` check at render time false
  // even though no re-check actually ran.
  const [cantRecheck, setCantRecheck] = useState(false);

  // Gated public-picture (H1) — fetched only on an explicit tap, never on mount.
  // `null` = not requested; '' = requested-but-none; otherwise a vetted https URL.
  const [publicPic, setPublicPic] = useState<string | null>(null);
  const [publicPicState, setPublicPicState] = useState<'idle' | 'loading' | 'none' | 'error'>('idle');

  async function handleShowPublicPicture() {
    if (publicPicState === 'loading') return;
    setPublicPicState('loading');
    try {
      const result = await fetchPublicProfile(entry.pubkey, relayUrl);
      const raw = result?.profile.pictureUrl;
      const safe = raw ? safeImageOrLinkUrl(raw) : null;
      if (safe) {
        setPublicPic(safe.toString());
        setPublicPicState('idle');
      } else {
        setPublicPicState('none');
      }
    } catch {
      setPublicPicState('error');
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  function stampResolved(updated: KenEntry): KenEntry {
    return { ...updated, lastResolvedAt: Math.floor(Date.now() / 1000) };
  }

  // ── key-control ──────────────────────────────────────────────────────────────

  function handleOpenKeyControl() {
    setError('');
    setKeyControlResult(null);
    setSignedEventJson('');
    const c = buildKeyControlChallenge();
    setChallenge(c);
    setSection('key-control');
  }

  function handleVerifyKeyControl() {
    if (busy || !challenge) return;
    setError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(signedEventJson.trim());
    } catch {
      setError('Could not parse that as JSON. Paste the full signed Nostr event object.');
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('id' in parsed) ||
      !('sig' in parsed) ||
      !('pubkey' in parsed)
    ) {
      setError('The pasted value does not look like a Nostr event (needs id, sig, pubkey fields).');
      return;
    }
    const result = verifyKeyControl(
      entry,
      challenge.nonce,
      parsed as Parameters<typeof verifyKeyControl>[2],
    );
    setKeyControlResult(result);
    if (!result.ok) {
      setError(`Key-control check failed: ${result.reason ?? 'unknown reason'}.`);
    }
    // Read-only check — does NOT mutate or persist. The challenge tells us whether
    // the person controls the key at the moment of verification; it does not change
    // the pinned record's trust level or timestamp. Treat it as a live probe only.
  }

  // ── rotation ─────────────────────────────────────────────────────────────────

  async function handleOpenRotation() {
    setError('');
    setResolved(null);
    setCantRecheck(false);
    setRevertConfirming(false);
    setResolving(true);
    setSection('rotation');
    // Capture the entry reference AT THE MOMENT of the resolve call — the
    // `entry` prop can be replaced by a fresh object for the same logical
    // record between now and when the result comes back (or between now
    // and render), so "no fetch happened" must be judged against THIS
    // reference, not whatever `entry` happens to be later.
    const requestedEntry = entry;
    try {
      const r = await resolveKen(requestedEntry, globalThis.fetch);
      setResolved(r);
      setCantRecheck(r === requestedEntry);
    } catch (e) {
      setError(humaniseKenDetailError(e, 'Could not check this address right now. Try again later.'));
    } finally {
      setResolving(false);
    }
  }

  async function handleAcceptRotation() {
    if (busy || !resolved || !resolved.rotation || resolved.rotation.accepted) return;
    // Guard against a stale `resolved` copy: the panel may have been open
    // for a while, and `entry` (the CURRENT record — reloaded by ken-sync,
    // or revoked from another device) can have moved on since. Accepting
    // against the stale copy would silently overwrite a newer revoke, or
    // graft the rotation onto the wrong record entirely.
    if (entry.revoked || entry.pubkey !== resolved.pubkey) {
      setError('This entry has changed since you opened this screen. Go back and try again.');
      return;
    }
    const rollback = !!resolved.rotation.rollback;
    setBusy(true);
    setError('');
    try {
      const rotated = acceptKenRotation(resolved, rollback ? { allowRevert: true } : undefined);
      const stamped = stampResolved(rotated);
      await onAddKen(stamped);
      setResolved(null);
      setRevertConfirming(false);
      setCantRecheck(false);
      setSection('overview');
    } catch (e) {
      setError(humaniseKenDetailError(e, 'Could not accept that rotation. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  // ── revoke ───────────────────────────────────────────────────────────────────

  async function handleRevoke() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const revoked = revokeKen(entry);
      const stamped = stampResolved(revoked);
      await onAddKen(stamped);
      setSection('overview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke ken entry.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onRemoveKen(entry.pubkey);
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove ken entry.');
      setBusy(false);
    }
  }

  // ── render: key-control section ──────────────────────────────────────────────

  if (section === 'key-control') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Prove it's live</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Ask them to sign a Nostr event whose <strong>content</strong> is exactly the nonce below,
          then paste the full signed event JSON here.
        </p>
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
            }}
          >
            Nonce (event content must be exactly this)
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
              wordBreak: 'break-all',
              padding: '8px 10px',
              background: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              userSelect: 'all',
            }}
          >
            {challenge?.nonce}
          </div>
        </div>
        {keyControlResult?.ok && (
          <div
            style={{
              padding: 8,
              background: 'var(--success-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 12,
              color: 'var(--success)',
              fontSize: '0.9rem',
            }}
          >
            Key control verified — this key is live.
          </div>
        )}
        {error && (
          <div
            style={{
              padding: 8,
              background: 'var(--danger-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 12,
              color: 'var(--danger)',
              fontSize: '0.9rem',
            }}
          >
            {error}
          </div>
        )}
        <textarea
          className="input"
          rows={6}
          placeholder='{"id":"...","pubkey":"...","sig":"...","content":"<nonce>","kind":1,...}'
          value={signedEventJson}
          onChange={e => setSignedEventJson(e.target.value)}
          style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
          autoFocus
        />
        <button
          className="btn btn-primary"
          onClick={handleVerifyKeyControl}
          disabled={!signedEventJson.trim()}
          style={{ marginTop: 12 }}
        >
          Verify
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setSection('overview'); setError(''); setKeyControlResult(null); setSignedEventJson(''); setChallenge(null); }}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── render: rotation section ─────────────────────────────────────────────────

  if (section === 'rotation') {
    const pendingRotation = resolved?.rotation && !resolved.rotation.accepted ? resolved.rotation : null;
    // `cantRecheck` is set in `handleOpenRotation` from the resolve-time
    // reference comparison, not recomputed here — `resolved === entry` at
    // RENDER time would break the moment `entry` is replaced by a fresh
    // object for the same logical record (see the state's doc comment).
    const showCantRecheck = !resolving && cantRecheck;
    const rollback = !!pendingRotation?.rollback;
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Review rotation</h2>
        {resolving && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Checking NIP-05 record…</p>
        )}
        {error && (
          <div
            style={{
              padding: 8,
              background: 'var(--danger-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 12,
              color: 'var(--danger)',
              fontSize: '0.9rem',
            }}
          >
            {error}
          </div>
        )}
        {!resolving && !error && showCantRecheck && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            This address can't be re-checked.
          </p>
        )}
        {!resolving && !error && !showCantRecheck && !pendingRotation && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No key rotation detected — the pinned key matches the current NIP-05 record.
          </p>
        )}
        {pendingRotation && !rollback && (
          <div
            style={{
              padding: 12,
              background: 'var(--warning-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 4,
              }}
            >
              Proposed new key
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                wordBreak: 'break-all',
                color: 'var(--text-primary)',
                marginBottom: 8,
              }}
            >
              {shortNpub(pendingRotation.newPubkey)}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Via: {pendingRotation.via} &middot; Observed:{' '}
              {new Date(pendingRotation.observedAt * 1000).toLocaleDateString()}
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              The pinned key is <strong>not</strong> changed until you explicitly accept.
            </p>
            <button
              className="btn btn-primary"
              onClick={handleAcceptRotation}
              disabled={busy}
              style={{ marginTop: 12 }}
            >
              {busy ? 'Accepting…' : 'Accept rotation'}
            </button>
          </div>
        )}
        {pendingRotation && rollback && (
          <div
            role="alert"
            style={{
              padding: 12,
              background: 'var(--danger-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 4,
              }}
            >
              Old key re-served
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                wordBreak: 'break-all',
                color: 'var(--text-primary)',
                marginBottom: 8,
              }}
            >
              {shortNpub(pendingRotation.newPubkey)}
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', fontWeight: 600, margin: 0, marginBottom: 8 }}>
              This address is serving an OLD key again — it may have been compromised or restored
              from backup.
            </p>
            {!revertConfirming ? (
              <button
                className="btn btn-ghost"
                onClick={() => setRevertConfirming(true)}
                style={{ color: 'var(--danger)', marginTop: 4 }}
              >
                Revert anyway
              </button>
            ) : (
              <>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '8px 0' }}>
                  Are you sure? This moves your pinned key back to one that was already replaced.
                </p>
                <button
                  className="btn btn-danger"
                  onClick={handleAcceptRotation}
                  disabled={busy}
                  style={{ marginBottom: 8 }}
                >
                  {busy ? 'Reverting…' : 'Confirm revert'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setRevertConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
        <button
          className="btn btn-ghost"
          onClick={() => { setSection('overview'); setError(''); setResolved(null); setRevertConfirming(false); setCantRecheck(false); }}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── render: revoke confirm ────────────────────────────────────────────────────

  if (section === 'revoke-confirm') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Revoke this entry?</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          This marks the pinned key as compromised. The entry is preserved for audit but all
          future attribution checks will fail. This cannot be undone from this screen.
        </p>
        {error && (
          <div
            style={{
              padding: 8,
              background: 'var(--danger-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 12,
              color: 'var(--danger)',
              fontSize: '0.9rem',
            }}
          >
            {error}
          </div>
        )}
        <button
          className="btn btn-danger"
          onClick={handleRevoke}
          disabled={busy}
          style={{ marginBottom: 8 }}
        >
          {busy ? 'Revoking…' : 'Confirm revoke'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setSection('overview'); setError(''); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ── render: overview ─────────────────────────────────────────────────────────

  const displayName = entry.displayName
    ? truncStr(entry.displayName, 60)
    : truncPubkey(entry.pubkey);

  return (
    <div className="fade-in" role="main">
      {/* Revoked banner */}
      {entry.revoked && (
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--danger-light)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--danger)',
            fontSize: '0.9rem',
            marginBottom: 16,
            fontWeight: 600,
          }}
          role="alert"
        >
          This entry is revoked — the pinned key is marked as compromised.
        </div>
      )}

      {/* Identity block */}
      <div className="section" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8 }}>
          <ContactAvatar
            url={publicPic ?? avatarUrl}
            name={entry.displayName ?? ''}
            pubkey={shortNpub(entry.pubkey)}
            size={64}
          />
        </div>
        {/* H1: the contact's PUBLIC kind-0 picture is never auto-fetched and
            never shown in the list — only behind this explicit tap, and only
            when they haven't shared a private avatar. */}
        {!avatarUrl && !publicPic && (
          <div style={{ marginBottom: 8 }}>
            {publicPicState === 'loading' ? (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</span>
            ) : (
              <button
                className="btn btn-ghost"
                onClick={handleShowPublicPicture}
                style={{ fontSize: '0.8rem', padding: '4px 10px' }}
              >
                Show their public picture
              </button>
            )}
            {publicPicState === 'none' && (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 8 }}>
                No public picture found.
              </span>
            )}
            {publicPicState === 'error' && (
              <span style={{ fontSize: '0.8rem', color: 'var(--danger)', marginLeft: 8 }}>
                Couldn’t load their public picture.
              </span>
            )}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>{displayName}</span>
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            ken
          </span>
        </div>

        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            wordBreak: 'break-all',
            marginBottom: 8,
          }}
        >
          {shortNpub(entry.pubkey)}
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
          <strong>Source:</strong> {provenanceLabel(entry.provenance.source)}{' '}
          &middot; <strong>Locator:</strong> {truncStr(entry.provenance.locator, 80)}
        </div>

        {entry.nip05 && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
            <strong>NIP-05:</strong> {truncStr(entry.nip05, 100)}
          </div>
        )}

        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Added: {new Date(entry.addedAt * 1000).toLocaleDateString()}
          {entry.lastResolvedAt && (
            <> &middot; Last resolved: {new Date(entry.lastResolvedAt * 1000).toLocaleDateString()}</>
          )}
        </div>

        {entry.previousPubkeys && entry.previousPubkeys.length > 0 && (
          <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            <strong>Previous keys ({entry.previousPubkeys.length}):</strong>{' '}
            {entry.previousPubkeys.map(pk => truncPubkey(pk)).join(', ')}
          </div>
        )}
      </div>

      {/* Share QR — ken tier: one-tap, no confirm */}
      <ContactShareQR
        pubkey={shortNpub(entry.pubkey)}
        tier="ken"
        displayName={displayName}
      />

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          className="btn btn-secondary"
          onClick={handleOpenKeyControl}
          disabled={!!entry.revoked}
        >
          Prove it's live
        </button>

        {/* Rotation/re-check is hidden — not just disabled — once revoked:
            a revoked pin is dead (acceptKenRotation refuses it too), so
            there is nothing left to review. */}
        {!entry.revoked && (
          <button
            className="btn btn-secondary"
            onClick={handleOpenRotation}
            disabled={!entry.nip05}
            title={!entry.nip05 ? 'Rotation review requires a NIP-05 address' : undefined}
          >
            Review rotation
          </button>
        )}

        {!entry.revoked && (
          <button
            className="btn btn-ghost"
            onClick={() => { setError(''); setSection('revoke-confirm'); }}
            style={{ color: 'var(--danger)' }}
          >
            Revoke
          </button>
        )}

        <button
          className="btn btn-ghost"
          onClick={handleDelete}
          disabled={busy}
          style={{ color: 'var(--danger)' }}
        >
          {busy ? 'Removing…' : 'Remove from kens'}
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: 8,
            background: 'var(--danger-light)',
            borderRadius: 'var(--radius-sm)',
            marginTop: 12,
            color: 'var(--danger)',
            fontSize: '0.9rem',
          }}
        >
          {error}
        </div>
      )}

      <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: 16 }}>
        Back
      </button>
    </div>
  );
}
