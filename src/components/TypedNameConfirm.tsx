import { useState } from 'react';

/**
 * Reusable double-confirm pattern for destructive or irreversible actions.
 *
 * Renders a confirmation card with a text input that the user must fill with
 * an exact case-sensitive match for `expectedString` before the primary
 * action button enables. Trims both leading and trailing whitespace from
 * the typed input before comparing.
 *
 * Used for:
 *   - Enabling a public Nostr profile on the Natural Person keypair (per
 *     the per-persona-public-profile design §6.5 — "really sure?" step)
 *
 * Future destructive actions (identity delete with a strong gate, persona
 * hard-delete if added) can use the same component without reinventing.
 */
interface Props {
  /** The exact string the user must type to enable confirmation. Trimmed. */
  expectedString: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
  helperText: string;
  /** Optional heading rendered above the input. */
  heading?: string;
  /** Optional explanatory paragraph rendered above the input. */
  body?: string;
}

export function TypedNameConfirm({
  expectedString,
  onConfirm,
  onCancel,
  confirmLabel,
  helperText,
  heading,
  body,
}: Props) {
  const [typed, setTyped] = useState('');
  const expected = expectedString.trim();
  const match = typed.trim() === expected;

  return (
    <div className="card section" style={{ borderColor: 'var(--danger)' }}>
      {heading && (
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 8 }}>{heading}</div>
      )}
      {body && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
          {body}
        </p>
      )}
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
        {helperText}
      </p>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>
        Type <code style={{ background: 'var(--bg-card-alt)', padding: '2px 6px', borderRadius: 3 }}>{expected}</code> to confirm:
      </p>
      <input
        className="input"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={expected}
        autoFocus
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        style={{ marginBottom: 12 }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={onCancel} style={{ flex: 1 }}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          onClick={onConfirm}
          disabled={!match}
          style={{ flex: 1 }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
