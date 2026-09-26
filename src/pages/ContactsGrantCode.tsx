/**
 * The pairing verification-code check (SDK B1/F1, docs/WIRE.md §3 "Pairing
 * verification code").
 *
 * My Signet is the PRODUCER of this code and must NEVER display it —
 * `pairingCode(input)` is computed only to compare against what the person
 * TYPES, never rendered. Showing it here would hand an attacker who won the
 * ack race (kind 21237 is ephemeral; a backgrounded app or a dropped socket
 * loses it) exactly what they need to forge a second, matching ack.
 *
 * Reached from `handleApproveContactsGrantV2` on every path where the ack
 * landed — the pairing is real by then, so a mismatch disconnects the grant
 * rather than leaving it half-trusted. One mistyped attempt is recoverable;
 * a second is treated as the attacker case, since there is no way to tell
 * the two apart from here.
 */
import { useState } from 'react';
import { matchesPairingCode } from '@forgesworn/signet-contacts/wire';
import type { PairingCodeInput } from '@forgesworn/signet-contacts/wire';
import {
  CONTACTS_GRANT_CODE_TITLE, CONTACTS_GRANT_CODE_PROMPT_BEFORE_NAME, CONTACTS_GRANT_CODE_PROMPT_AFTER_NAME,
  CONTACTS_GRANT_CODE_INPUT_LABEL, CONTACTS_GRANT_CODE_CHECK_LABEL, CONTACTS_GRANT_CODE_DONE_LABEL,
  CONTACTS_GRANT_CODE_KEEP_LABEL, CONTACTS_GRANT_CODE_DISCONNECT_LABEL, CONTACTS_GRANT_CODE_TRY_AGAIN_LABEL,
  CONTACTS_GRANT_CODE_MISMATCH_COPY, CONTACTS_GRANT_CODE_NOT_SHOWING_COPY,
  contactsGrantCodeMatchCopy, contactsGrantCodeDisconnectedCopy, contactsGrantCodeNotShowingLink,
  CONTACTS_GRANT_DISCONNECT_FAILED_COPY,
} from '../lib/contacts-v2-copy';

export interface ContactsGrantCodeCheck {
  grantId: string;
  appName: string;
  input: PairingCodeInput;
  /** The teardown-path copy from `handleApproveContactsGrantV2` (the ack
   *  landed but the first projection publish failed). Applied once THIS page
   *  finishes — by whichever exit — not on arrival; see App.tsx. */
  followUpError?: string;
}

interface Props {
  check: ContactsGrantCodeCheck;
  /** MUST throw on failure — this page has no other way to learn the revoke
   *  did not take. (`handleRevokeContactsGrantV2` itself never throws; its
   *  own failure signal is app-level state a caller here cannot read
   *  synchronously, so App.tsx wraps it into a throwing call for this page.) */
  onRevoke: (grantId: string) => Promise<void>;
  /** Every way off this page: match+Done, second-mismatch-disconnected+Done,
   *  Keep it, and a successful not-showing Disconnect. Back/leave is wired
   *  the same as Keep it by the caller — nothing here revokes silently. */
  onDone: () => void;
}

type Phase =
  | { kind: 'entry'; mismatched: boolean }
  | { kind: 'match' }
  | { kind: 'disconnected' }
  | { kind: 'not-showing' }
  | { kind: 'revoke-error'; error: string; retry: () => void };

export function ContactsGrantCode({ check, onRevoke, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'entry', mismatched: false });
  const [typed, setTyped] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);

  async function runRevoke(onSuccess: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await onRevoke(check.grantId);
      onSuccess();
    } catch (e) {
      setPhase({
        kind: 'revoke-error',
        error: e instanceof Error ? e.message : CONTACTS_GRANT_DISCONNECT_FAILED_COPY,
        retry: () => { void runRevoke(onSuccess); },
      });
    } finally {
      setBusy(false);
    }
  }

  function handleCheck() {
    if (busy) return;
    if (matchesPairingCode(check.input, typed)) {
      setPhase({ kind: 'match' });
      return;
    }
    setTyped('');
    const nextAttempts = attempts + 1;
    setAttempts(nextAttempts);
    if (nextAttempts >= 2) {
      void runRevoke(() => setPhase({ kind: 'disconnected' }));
      return;
    }
    setPhase({ kind: 'entry', mismatched: true });
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        {phase.kind === 'entry' && (
          <>
            <h2 style={{ marginBottom: 8 }}>{CONTACTS_GRANT_CODE_TITLE}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
              {CONTACTS_GRANT_CODE_PROMPT_BEFORE_NAME}<strong>{check.appName}</strong>{CONTACTS_GRANT_CODE_PROMPT_AFTER_NAME}
            </p>

            {phase.mismatched && (
              <div className="card" style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 16 }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>
                  {CONTACTS_GRANT_CODE_MISMATCH_COPY}
                </p>
              </div>
            )}

            <input
              className="input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              aria-label={CONTACTS_GRANT_CODE_INPUT_LABEL}
              style={{ marginBottom: 16 }}
            />

            <button className="btn btn-primary" onClick={handleCheck} disabled={busy || typed.trim().length === 0}>
              {CONTACTS_GRANT_CODE_CHECK_LABEL}
            </button>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPhase({ kind: 'not-showing' })}
              disabled={busy}
              style={{ marginTop: 8, fontSize: '0.8rem' }}
            >
              {contactsGrantCodeNotShowingLink(check.appName)}
            </button>
          </>
        )}

        {phase.kind === 'match' && (
          <>
            <p style={{ fontSize: '0.9rem', marginBottom: 20 }}>{contactsGrantCodeMatchCopy(check.appName)}</p>
            <button className="btn btn-primary" onClick={onDone}>{CONTACTS_GRANT_CODE_DONE_LABEL}</button>
          </>
        )}

        {phase.kind === 'disconnected' && (
          <>
            <p style={{ fontSize: '0.9rem', marginBottom: 20 }}>{contactsGrantCodeDisconnectedCopy(check.appName)}</p>
            <button className="btn btn-primary" onClick={onDone}>{CONTACTS_GRANT_CODE_DONE_LABEL}</button>
          </>
        )}

        {phase.kind === 'not-showing' && (
          <>
            <p style={{ fontSize: '0.9rem', marginBottom: 20 }}>{CONTACTS_GRANT_CODE_NOT_SHOWING_COPY}</p>
            <button
              className="btn btn-primary"
              onClick={onDone}
              disabled={busy}
              style={{ marginBottom: 8 }}
            >
              {CONTACTS_GRANT_CODE_KEEP_LABEL}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => { void runRevoke(onDone); }}
              disabled={busy}
            >
              {CONTACTS_GRANT_CODE_DISCONNECT_LABEL}
            </button>
          </>
        )}

        {phase.kind === 'revoke-error' && (
          <>
            <div className="card" style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 16 }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>{phase.error}</p>
            </div>
            <button className="btn btn-primary" onClick={phase.retry} disabled={busy}>
              {CONTACTS_GRANT_CODE_TRY_AGAIN_LABEL}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
