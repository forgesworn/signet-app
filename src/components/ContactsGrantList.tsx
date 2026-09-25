/**
 * The contacts v2 half of the connected-apps page: one row per grant, live or
 * ended.
 *
 * R-5: the last publish state is SHOWN, not inferred — "this app has a
 * deliberately partial copy of your list" is something the owner is told, not
 * something they would have to work out. A revoked grant stays listed as ended
 * (R-13 keeps the row for audit) with Forget as the way to drop it; a live one
 * gets Disconnect behind an inline confirm carrying the honesty line about what
 * revocation cannot undo.
 *
 * Separate from `CompanionApps.tsx`, which is the v1 rail's own surface — keyed
 * by `appPubkey` and gated on a local mnemonic, neither of which applies here.
 *
 * A component rather than JSX inside `App.tsx` so the contacts-v2 vocabulary
 * guard's `src/components/Contact*.tsx` glob binds every string it renders
 * (fix round 1 / I3). Presentational: all state and every action live in
 * `App.tsx`; this file decides only what is shown.
 *
 * Every action button carries `width: 'auto'`. The global `.btn` rule is
 * `width: 100%` (it is designed for full-width primary actions), so inside
 * this row's flex it swallowed all 324 px and collapsed the `flex: 1` text
 * column to ZERO width — the app name, the directory line and every
 * capability were rendered, present in the accessibility tree, and invisible.
 * The e2e for this list is what caught it; `flexShrink: 0` alone does not
 * help, because the problem is the button's declared width, not its shrink
 * behaviour.
 */
import type { AppGrantV2 } from '../types';
import type { GrantDirectoryOption } from '../lib/contacts-grant-directories';
import {
  CANCEL_LABEL, CONFIRM_LABEL, CONTACTS_GRANTS_LIST_TITLE, CONTACTS_GRANTS_LIST_EMPTY,
  CONTACTS_GRANT_CAPABILITY_COPY, CONTACTS_GRANT_DISCONNECT_LABEL, CONTACTS_GRANT_FORGET_LABEL,
  CONTACTS_GRANT_PUBLISH_STATE, CONTACTS_GRANT_RECONNECT_COPY, contactsGrantDirectoryLine, contactsGrantDisconnectConfirm,
  contactsGrantEndedLine,
} from '../lib/contacts-v2-copy';

interface Props {
  grants: AppGrantV2[];
  /** Resolved directories, for the "which contact list" line. */
  directories: GrantDirectoryOption[];
  /** A failed disconnect or forget, already copy-module text. */
  error?: string | null;
  confirmingGrantId: string | null;
  busyGrantId: string | null;
  /** Open the inline confirm for a live grant. */
  onConfirmDisconnect: (grantId: string) => void;
  onCancelDisconnect: () => void;
  onDisconnect: (grantId: string) => void;
  onAutoAcceptChange?: (grantId: string, enabled: boolean) => void;
  onForget: (grantId: string) => void;
}

export function ContactsGrantList({
  grants, directories, error, confirmingGrantId, busyGrantId,
  onConfirmDisconnect, onCancelDisconnect, onDisconnect, onForget, onAutoAcceptChange,
}: Props) {
  return (
    <div className="section">
      <h3 style={{ fontSize: '0.95rem', marginBottom: 8 }}>{CONTACTS_GRANTS_LIST_TITLE}</h3>
      {error && (
        <div
          className="card"
          style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 12 }}
        >
          <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>{error}</p>
        </div>
      )}
      {grants.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
          {CONTACTS_GRANTS_LIST_EMPTY}
        </p>
      ) : (
        <div className="card card-flush">
          {grants.map((g, i) => {
            const directoryLabel = directories.find(d => d.directoryId === g.directoryId && d.ownerIdentityPubkey === g.ownerIdentityPubkey)?.label ?? null;
            const isConfirming = confirmingGrantId === g.grantId;
            const isBusy = busyGrantId === g.grantId;
            return (
              <div
                key={g.grantId}
                style={{
                  padding: '14px 16px',
                  borderBottom: i < grants.length - 1 ? '1px solid var(--border)' : 'none',
                  opacity: g.revokedAt ? 0.7 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>{g.appName}</div>
                    {directoryLabel && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {contactsGrantDirectoryLine(directoryLabel)}
                      </div>
                    )}
                    {!g.ownerIdentityPubkey && !g.revokedAt && <p>Reconnect this app to choose one identity’s contact list.</p>}
                    {g.capabilities.map(cap => (
                      <div key={cap} style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {CONTACTS_GRANT_CAPABILITY_COPY[cap] ?? CONTACTS_GRANT_RECONNECT_COPY}
                      </div>
                    ))}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      {g.revokedAt
                        ? contactsGrantEndedLine(new Date(g.revokedAt * 1000).toLocaleDateString())
                        : CONTACTS_GRANT_PUBLISH_STATE[g.lastPublishState ?? 'ok']}
                    </div>
                  </div>
                  {g.revokedAt ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => onForget(g.grantId)}
                      disabled={isBusy}
                      style={{ fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0, width: 'auto' }}
                    >
                      {CONTACTS_GRANT_FORGET_LABEL}
                    </button>
                  ) : !isConfirming ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => onConfirmDisconnect(g.grantId)}
                      disabled={isBusy}
                      style={{ color: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0, width: 'auto' }}
                    >
                      {CONTACTS_GRANT_DISCONNECT_LABEL}
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button
                        className="btn btn-ghost"
                        onClick={() => onDisconnect(g.grantId)}
                        disabled={isBusy}
                        style={{ color: '#fff', background: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px', width: 'auto' }}
                      >
                        {CONFIRM_LABEL}
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={onCancelDisconnect}
                        disabled={isBusy}
                        style={{ fontSize: '0.8rem', padding: '6px 12px', width: 'auto' }}
                      >
                        {CANCEL_LABEL}
                      </button>
                    </div>
                  )}
                </div>
                {!g.revokedAt && onAutoAcceptChange && g.capabilities.some(cap => (cap as string) === 'signet.contacts.invites:create') && <label>
                  <input type="checkbox" checked={g.autoAcceptInvites !== false} disabled={isBusy}
                    onChange={event => onAutoAcceptChange(g.grantId, event.target.checked)} />
                  Automatically accept the first request to this app’s single-use invite within five minutes
                </label>}
                {isConfirming && !g.revokedAt && (
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '8px 0 0' }}>
                    {contactsGrantDisconnectConfirm(g.appName)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
