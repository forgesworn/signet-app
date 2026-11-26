import { useEffect, useRef, useState } from 'react';
import { armPickerGrace } from '../lib/picker-grace';
import { BACKDROP_PRIVACY_COPY, useCardBackdrop } from '../hooks/useCardBackdrop';
import { BACKDROP_COPY } from '../lib/child-device-copy';

/**
 * What the row says under its label: the dependant variant on a guardian's
 * dependant card, "Set by your guardian" while a child's phone shows the
 * guardian's picture, the device-local line otherwise.
 */
export function backdropRowSub(
  link: { name: string } | null,
  source: 'own' | 'guardian' | null,
): string {
  if (link) return BACKDROP_COPY.dependantPrivacy(link.name);
  if (source === 'guardian') return BACKDROP_COPY.fromGuardian;
  return BACKDROP_PRIVACY_COPY;
}

/**
 * Settings-column row for an identity's card backdrop: the same device-local
 * wallpaper the image button on the identity card sets, reachable from the
 * place people look for "how do I change how this looks".
 */
export function CardBackdropRow({ pubkey }: { pubkey: string }) {
  const backdrop = useCardBackdrop(pubkey);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Why the last send to the child's phone did not go (guardian's dependant card
  // only). Detail only: whether the picture counts as unsent comes from the
  // stored digest (`backdrop.unsent`), so it survives a remount.
  const [sendNote, setSendNote] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const link = backdrop.link;
  // Said whenever the picture on this phone is not the one last sent to theirs.
  const notSent = link && backdrop.url && backdrop.unsent
    ? (sendNote || BACKDROP_COPY.notSentYet(link.name))
    : '';

  return (
    <div className="row">
      <div className="row-main">
        <span className="row-label">Card backdrop</span>
        <span className="row-sub">{backdropRowSub(backdrop.link, backdrop.source)}</span>
        {error && <span className="slot-row-error" role="alert">{error}</span>}
        {!error && notSent && <span className="slot-row-error" role="status">{notSent}</span>}
      </div>
      <div className="slot-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setError(''); armPickerGrace(); inputRef.current?.click(); }}>
          {busy ? 'Saving…' : backdrop.url ? 'Change' : 'Set'}
        </button>
        {link && backdrop.url && backdrop.unsent && (
          <button className="btn btn-ghost btn-sm" disabled={busy}
            onClick={() => {
              setBusy(true);
              setSendNote('');
              void backdrop.retrySend().then(result => {
                if (!mounted.current) return;
                setBusy(false);
                if (!result.ok) setSendNote(BACKDROP_COPY.notSent(link.name, result.reason, link.sent));
              });
            }}>
            {`Send to ${link.name}'s phone`}
          </button>
        )}
        {backdrop.url && backdrop.source !== 'guardian' && !backdrop.removeBlocked && (
          <button className="btn btn-ghost btn-sm" disabled={busy} style={{ color: 'var(--text-muted)' }}
            onClick={() => { setError(''); setSendNote(''); void backdrop.clear(); }}>
            Remove
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            setSendNote('');
            void backdrop.set(file).then(result => {
              if (!mounted.current) return;
              setBusy(false);
              if (!result.ok) { setError(result.reason); return; }
              if (result.send && !result.send.ok && link) setSendNote(BACKDROP_COPY.notSent(link.name, result.send.reason, link.sent));
            });
          }}
        />
      </div>
    </div>
  );
}
