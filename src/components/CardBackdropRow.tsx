import { useEffect, useRef, useState } from 'react';
import { useCardBackdrop } from '../hooks/useCardBackdrop';

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
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  return (
    <div className="row">
      <div className="row-main">
        <span className="row-label">Card backdrop</span>
        <span className="row-sub">Only on this device</span>
        {error && <span className="slot-row-error" role="alert">{error}</span>}
      </div>
      <div className="slot-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setError(''); inputRef.current?.click(); }}>
          {busy ? 'Saving…' : backdrop.url ? 'Change' : 'Set'}
        </button>
        {backdrop.url && (
          <button className="btn btn-ghost btn-sm" disabled={busy} style={{ color: 'var(--text-muted)' }}
            onClick={() => { setError(''); void backdrop.clear(); }}>
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
            void backdrop.set(file).then(result => {
              if (!mounted.current) return;
              setBusy(false);
              if (!result.ok) setError(result.reason);
            });
          }}
        />
      </div>
    </div>
  );
}
