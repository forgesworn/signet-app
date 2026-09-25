import { useMemo, useState } from 'react';
import type { SignetIdentity, DependantIdentity, ExtraPersona } from '../types';
import { Icon } from '../components/Icon';

interface Props {
  identity: SignetIdentity;
  dependants: DependantIdentity[];
  /** Soft-delete (or restore) an extra persona by pubkey. After Phase 2 T27
   *  this is the **restore** path only — hide moves to PersonaAdvanced's
   *  HideBlock (reached via the persona card's gear-fab). The signature still
   *  takes a `hidden` flag because the hook contract is the same; callers
   *  here always pass `false` (un-hide). */
  onSetExtraPersonaHidden: (publicKey: string, hidden: boolean) => Promise<void>;
  /** Persist a new order for the user's extra personas. Pubkeys not in the
   *  list are appended at the tail to protect against stale callers. */
  onReorderExtras: (orderedPubkeys: string[]) => Promise<void>;
  /** Persist a new order for dependants. Sets sortIndex on each in turn. */
  onReorderDependants: (orderedIds: string[]) => Promise<void>;
}

/**
 * Single page that lets the user manage the visible-and-ordered shape of
 * the carousel parent ring. Two sections:
 *   - Personas (extras): up/down to reorder visible extras, restore for
 *     hidden extras. The hide action lives on the persona card's ⚙ gear-fab
 *     (Phase 2 T27) — this page is un-hide-only.
 *   - Dependants: up/down to reorder.
 * Built-in NP and Persona aren't reorderable here — they're fixed slots
 * at the top of the ring (rows 0 and 1). Dep extras live inside
 * each dep's child-mode ring; they're not surfaced in this page.
 */
export function ManageCarousel({
  identity,
  dependants,
  onSetExtraPersonaHidden,
  onReorderExtras,
  onReorderDependants,
}: Props) {
  const allExtras = useMemo(() => identity.extraPersonas ?? [], [identity.extraPersonas]);
  const visible = useMemo(() => allExtras.filter(e => !e.hidden), [allExtras]);
  const hidden = useMemo(() => allExtras.filter(e => e.hidden), [allExtras]);

  // Local optimistic copies so up/down reorder feels responsive — the
  // hook persistence runs in the background and a final reload reflects
  // the same order back. We re-sync from props if they change underneath.
  const [busy, setBusy] = useState(false);

  const moveExtra = async (pubkey: string, delta: -1 | 1) => {
    if (busy) return;
    const order = visible.map(e => e.publicKey);
    const idx = order.indexOf(pubkey);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    // Append hidden ones at the tail to preserve their positions in the
    // canonical array — the hook's reorder ignores extras not mentioned
    // in the order list and tail-appends them, so we mention everyone
    // explicitly to keep things deterministic.
    const fullOrder = [...order, ...hidden.map(e => e.publicKey)];
    setBusy(true);
    try { await onReorderExtras(fullOrder); }
    finally { setBusy(false); }
  };

  const moveDependant = async (id: string, delta: -1 | 1) => {
    if (busy) return;
    const order = dependants.map(d => d.id);
    const idx = order.indexOf(id);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    setBusy(true);
    try { await onReorderDependants(order); }
    finally { setBusy(false); }
  };

  const restoreHidden = async (pubkey: string) => {
    if (busy) return;
    setBusy(true);
    try { await onSetExtraPersonaHidden(pubkey, false); }
    finally { setBusy(false); }
  };

  return (
    <div className="fade-in">
      {/* No in-page <h2> — the Layout header already reads "Manage Carousel". */}
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        Reorder personas and dependants in your carousel, or restore a persona you previously hid. To hide a persona, open it on the carousel and use the <Icon name="settings" size={13} className="icon-inline" />Advanced page.
      </p>

      {/* Personas */}
      <div className="card section">
        <div className="section-title">Personas</div>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.4 }}>
          Your persona stays at the top; your real identity sits after your personas. Only added personas can be reordered here.
        </p>
        {visible.length === 0 && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', padding: '8px 4px' }}>
            No extra personas yet. Add one from the carousel's Add card.
          </div>
        )}
        {visible.map((extra, i) => (
          <ExtraRow
            key={extra.publicKey}
            extra={extra}
            isFirst={i === 0}
            isLast={i === visible.length - 1}
            onUp={() => moveExtra(extra.publicKey, -1)}
            onDown={() => moveExtra(extra.publicKey, 1)}
            disabled={busy}
          />
        ))}

        {hidden.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="section-title" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Hidden personas ({hidden.length})
            </div>
            {hidden.map(extra => (
              <div key={extra.publicKey} className="row" style={{ alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                    {extra.displayName || 'Unnamed Persona'}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{extra.derivationName}</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => restoreHidden(extra.publicKey)}
                  disabled={busy}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dependants */}
      {dependants.length > 0 && (
        <div className="card section">
          <div className="section-title">Dependants</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.4 }}>
            Reorder how dependants appear when you swipe through your ring.
          </p>
          {dependants.map((dep, i) => (
            <DependantRow
              key={dep.id}
              dep={dep}
              isFirst={i === 0}
              isLast={i === dependants.length - 1}
              onUp={() => moveDependant(dep.id, -1)}
              onDown={() => moveDependant(dep.id, 1)}
              disabled={busy}
            />
          ))}
        </div>
      )}

      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
        Hidden personas keep their keypair in your seed — anything signed with them in the past stays valid, and restoring brings them back to the carousel and sign-in pickers exactly as they were.
      </p>
    </div>
  );
}

function ExtraRow({ extra, isFirst, isLast, onUp, onDown, disabled }: {
  extra: ExtraPersona;
  isFirst: boolean;
  isLast: boolean;
  onUp: () => void;
  onDown: () => void;
  disabled: boolean;
}) {
  return (
    <div className="row" style={{ alignItems: 'center', gap: 6 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onUp}
          disabled={disabled || isFirst}
          aria-label="Move up"
          style={{ padding: '2px 8px', minHeight: 'unset', lineHeight: 1 }}
        >
          &uarr;
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onDown}
          disabled={disabled || isLast}
          aria-label="Move down"
          style={{ padding: '2px 8px', minHeight: 'unset', lineHeight: 1 }}
        >
          &darr;
        </button>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {extra.displayName || 'Unnamed Persona'}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{extra.derivationName}</div>
      </div>
    </div>
  );
}

function DependantRow({ dep, isFirst, isLast, onUp, onDown, disabled }: {
  dep: DependantIdentity;
  isFirst: boolean;
  isLast: boolean;
  onUp: () => void;
  onDown: () => void;
  disabled: boolean;
}) {
  return (
    <div className="row" style={{ alignItems: 'center', gap: 6 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onUp}
          disabled={disabled || isFirst}
          aria-label="Move up"
          style={{ padding: '2px 8px', minHeight: 'unset', lineHeight: 1 }}
        >
          &uarr;
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onDown}
          disabled={disabled || isLast}
          aria-label="Move down"
          style={{ padding: '2px 8px', minHeight: 'unset', lineHeight: 1 }}
        >
          &darr;
        </button>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{dep.displayName}</div>
        {dep.dateOfBirth && (
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>DOB {dep.dateOfBirth}</div>
        )}
      </div>
    </div>
  );
}
