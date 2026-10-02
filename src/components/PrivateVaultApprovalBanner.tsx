import { PRIVATE_VAULT_NEEDS_APPROVAL_COPY, PRIVATE_VAULT_APPROVE_LABEL, PRIVATE_VAULT_APPROVAL_DISMISS_LABEL } from '../lib/vault-approval';

/**
 * The one quiet line shown when the Heartwood refused a private-backup
 * request. Wraps: the copy keeps the full row width and the buttons drop to
 * their own line on a narrow phone, rather than squeezing the sentence into a
 * column beside them.
 */
export function PrivateVaultApprovalBanner({ onApprove, onDismiss }: { onApprove: () => void; onDismiss: () => void }) {
  return (
    <div className="vault-approval-banner">
      <span className="vault-approval-banner-text">{PRIVATE_VAULT_NEEDS_APPROVAL_COPY}</span>
      <span className="vault-approval-banner-actions">
        <button type="button" onClick={onApprove} className="btn btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }}>
          {PRIVATE_VAULT_APPROVE_LABEL}
        </button>
        <button type="button" onClick={onDismiss} className="btn btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }}>
          {PRIVATE_VAULT_APPROVAL_DISMISS_LABEL}
        </button>
      </span>
    </div>
  );
}
