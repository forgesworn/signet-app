/**
 * Inline confirmation shown when the user has selected natural-person
 * and the NP-ceiling guardrail is active. Two-step so a single tap on
 * an NP row doesn't silently send the real-name identity.
 *
 * Moved out of ApproveAuth so other approvals that can use the real-name
 * identity (the app-permission page, M5) apply the same guardrail.
 */
interface NpConfirmProps {
  display: string;
  requireConfirm: boolean;
  confirmed: boolean;
  onConfirm: () => void;
  onUndo: () => void;
  /** The wording for what the identity is about to be used for (default: a sign-in). */
  copy?: Partial<NpConfirmCopy>;
}

export interface NpConfirmCopy {
  confirmed: string;
  title: string;
  usuallyEnough: string;
  confirm: string;
}

/** The sign-in wording (ApproveAuth). Other surfaces pass their own `copy`. */
export const NP_CONFIRM_SIGN_IN_COPY: NpConfirmCopy = {
  confirmed: 'Real-name sign-in confirmed.',
  title: "You're about to sign in with your real-name identity",
  usuallyEnough: "Most sites don't need it — a persona is usually enough.",
  confirm: 'Yes, use my real-name identity',
};

export function NaturalPersonConfirmSection({ display, requireConfirm, confirmed, onConfirm, onUndo, copy }: NpConfirmProps) {
  if (!requireConfirm) return null;
  const c = { ...NP_CONFIRM_SIGN_IN_COPY, ...copy };
  if (confirmed) {
    return (
      <div
        className="card section"
        style={{
          background: 'var(--success-light)',
          borderColor: 'var(--success)',
          fontSize: '0.85rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--success)' }}>
            {c.confirmed}
          </span>
          <button className="btn btn-ghost" onClick={onUndo} style={{ fontSize: '0.8rem', padding: '4px 8px' }}>
            Undo
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="card section"
      style={{
        background: 'var(--warning-light)',
        borderColor: 'var(--warning)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {c.title}
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
        <strong>{display.slice(0, 100)}</strong> is your natural-person keypair. {c.usuallyEnough}
      </p>
      <button className="btn btn-secondary" onClick={onConfirm} style={{ width: '100%' }}>
        {c.confirm}
      </button>
    </div>
  );
}
