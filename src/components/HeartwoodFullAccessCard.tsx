import { useState } from 'react';
import { FULL_ACCESS_COPY, type NarrowResult, type OwnerStatus, type StatusStyle } from '../lib/heartwood-one-hold';
import type { TurnOffResult } from '../lib/heartwood-owner-ops';

export type OwnerChoiceKind = 'offer' | 'again' | 'everyday' | 'restyle';

export interface HeartwoodFullAccessCardProps {
  status: OwnerStatus | null;
  checking: boolean;
  everHadFullAccess: boolean;
  /**
   * The mark was seen gone this unlock, though a later read failed (`status` is
   * `null`): the approve-again button stays, beside "couldn't check just now".
   */
  markLost?: boolean;
  label: string | null;
  hasOperatorKey: boolean;
  canNarrow: boolean;
  narrow: () => Promise<NarrowResult>;
  turnOff: () => Promise<TurnOffResult>;
  /** Open A1's choice screen (A10 offer, A8 re-run, or back to Everyday). */
  onOpenChoice: (kind: OwnerChoiceKind) => void;
  /** The hold on offer (when full access is off) would include the real name; the offer's wording follows. */
  offerIncludesRealName?: boolean;
  /** The outcome of the last full-access hold, kept after its screen closes. */
  outcome?: string | null;
  /** The kept outcome is a refusal or a failure, not a success. */
  outcomeIsProblem?: boolean;
  /** Called when the owner starts another action here, so the outcome line goes. */
  onOutcomeClear?: () => void;
}

const STYLE_NAME: Record<StatusStyle, string> = { everyday: 'Everyday', careful: 'Extra careful', custom: FULL_ACCESS_COPY.customStyleName };
const STYLE_BODY: Record<StatusStyle, string> = {
  everyday: FULL_ACCESS_COPY.everyday.body,
  careful: FULL_ACCESS_COPY.careful.body,
  custom: FULL_ACCESS_COPY.customStyleBody,
};

const small = { fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.45 } as const;

/**
 * Settings → Heartwood: the one-hold status line and its actions. Rendered
 * only when the Heartwood lists the bundle method (the caller gates that), so
 * on older firmware nothing here exists.
 */
export function HeartwoodFullAccessCard({
  status, checking, everHadFullAccess, markLost = false, label, hasOperatorKey, canNarrow, narrow, turnOff, onOpenChoice, offerIncludesRealName = false, outcome = null, outcomeIsProblem = false, onOutcomeClear,
}: HeartwoodFullAccessCardProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsProblem, setMessageIsProblem] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  async function doNarrow() {
    if (busy) return;
    setBusy(true); setMessage(''); onOutcomeClear?.();
    try {
      const out = await narrow();
      setMessageIsProblem(!out.ok);
      setMessage(out.ok ? 'This phone now signs in the Extra careful style.' : out.message);
    } finally { setBusy(false); }
  }

  async function doTurnOff() {
    if (busy) return;
    setConfirmOff(false);
    setBusy(true); setMessage(''); onOutcomeClear?.();
    try {
      const out = await turnOff();
      setMessageIsProblem(!out.ok);
      setMessage(out.ok ? 'Full access is off for this phone. Your Heartwood will ask for each thing again.' : out.message);
    } finally { setBusy(false); }
  }

  let line: string;
  if (status === null) line = checking ? 'Full access: checking…' : 'Full access: couldn\'t check just now.';
  else line = status.owner ? 'Full access: on for this phone' : 'Full access: off for this phone';

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{line}</div>

      {status?.owner && (
        <>
          <p style={small}><strong>{STYLE_NAME[status.style]}.</strong> {STYLE_BODY[status.style]}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {status.style === 'everyday' && canNarrow && (
              <button className="btn btn-secondary" disabled={busy} onClick={() => void doNarrow()}>
                {busy ? 'Working…' : 'Switch to Extra careful'}
              </button>
            )}
            {status.style === 'careful' && (
              <button className="btn btn-secondary" disabled={busy} onClick={() => onOpenChoice('everyday')}>
                Switch back to Everyday
              </button>
            )}
            {status.style === 'custom' && (
              // W4: a list an operator changed. A hold on the Heartwood sets it again.
              <button className="btn btn-secondary" disabled={busy} onClick={() => onOpenChoice('restyle')}>
                {FULL_ACCESS_COPY.chooseStyleAgain}
              </button>
            )}
            {!confirmOff && (
              // Without an operator key nothing is withdrawn from here (Sapwood does that), so no confirm is needed.
              <button className="btn btn-secondary" disabled={busy} onClick={() => (hasOperatorKey ? setConfirmOff(true) : void doTurnOff())}>
                Turn off full access
              </button>
            )}
          </div>
          {confirmOff && (
            <div role="alertdialog" aria-label="Turn off full access?" style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              <p style={small}>
                This takes back everything your Heartwood has approved for this phone, not only full access: sign-ins, backups and your children&apos;s keys. Your Heartwood will ask again for each of them, so expect several presses.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-danger" disabled={busy} onClick={() => void doTurnOff()}>Yes, turn it off</button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmOff(false)}>Keep it</button>
              </div>
            </div>
          )}
        </>
      )}

      {((status && !status.owner) || (status === null && markLost && everHadFullAccess)) && (
        everHadFullAccess ? (
          <>
            <p style={small}>
              This phone had full access, but your Heartwood no longer shows it. That happens when the pairing is edited or restored in Sapwood, or its approvals are forgotten.
            </p>
            <button className="btn btn-primary" disabled={busy} onClick={() => onOpenChoice('again')}>
              {FULL_ACCESS_COPY.approveAgain}
            </button>
          </>
        ) : (
          <>
            <p style={small}>{offerIncludesRealName ? FULL_ACCESS_COPY.covers : FULL_ACCESS_COPY.coversPersonaOnly}</p>
            <button className="btn btn-primary" disabled={busy} onClick={() => onOpenChoice('offer')}>
              {FULL_ACCESS_COPY.offerExisting}
            </button>
          </>
        )
      )}

      {(message || outcome) && (
        (message ? messageIsProblem : outcomeIsProblem)
          ? <p role="alert" className="status-problem" style={{ marginTop: 8, marginBottom: 0 }}>{message || outcome}</p>
          : <p role="status" style={{ ...small, color: 'var(--text-primary)', fontWeight: 600, marginTop: 8, marginBottom: 0 }}>{message || outcome}</p>
      )}

      <p style={{ ...small, marginTop: 8, marginBottom: 0 }}>
        {label ? `This phone's pairing: ${label}. ` : ''}{FULL_ACCESS_COPY.lostPhone}
      </p>
    </div>
  );
}
