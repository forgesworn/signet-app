/**
 * Advisory "is everything pairing needs ready?" list for the Phone & Pairing
 * card (child-pair tap/Bluetooth design D5). It tells the guardian up front
 * what the pairing page would otherwise stop on. It never blocks anything: the
 * pairing page still runs its own preconditions (`staticPairBlock`, the slot
 * count) and shows its own blocked screen.
 *
 * Rules are reused, not copied: the operator-key, firmware and persona rows
 * come from `staticPairBlock` / `childDirectPersona`, the slot cap from
 * `MAX_CONNECT_SLOTS`. The one device round trip is a single `list_clients`
 * when the card mounts (only if the operator client is up) — no polling, and a
 * failure reads "Couldn't check", never as a fault.
 */
import { useEffect, useState } from 'react';
import type { DependantIdentity } from '../types';
import type { DeviceStatus } from '../lib/heartwood-mgmt-types';
import { listClients, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { childDirectPersona, MAX_CONNECT_SLOTS, staticPairBlock, usesChildDirectPairing } from '../lib/child-device-pairing';
import { PAIR_READINESS_COPY as COPY } from '../lib/child-device-copy';

export type ReadinessState = 'ok' | 'fail' | 'checking' | 'unknown';

export interface PairReadinessChecklistProps {
  dependant: DependantIdentity;
  signingMode: string | undefined;
  /** App-level signer connection state (`signerStatus` in App.tsx). */
  signerStatus: 'connected' | 'connecting' | 'unavailable' | null;
  operator: HeartwoodMgmtClient | null;
  /** True while the stored operator key is still loading. */
  operatorLoading?: boolean;
  operatorStatus: DeviceStatus | null;
  operatorStatusError?: string | null;
  /** Takes the guardian to the operator-key import (same target as the pairing page). */
  onOpenOperatorImport?: () => void;
  /** Takes the guardian to the personas section. */
  onFixPersona?: () => void;
}

type SlotCount = { phase: 'idle' } | { phase: 'ready'; used: number } | { phase: 'failed' };

const mark = (s: ReadinessState) => (s === 'ok' ? '✓' : s === 'fail' ? '✗' : '…');

export function PairReadinessChecklist(props: PairReadinessChecklistProps) {
  const { dependant, signingMode, signerStatus, operator, operatorLoading, operatorStatus, operatorStatusError } = props;
  const applies = usesChildDirectPairing(dependant, signingMode);
  const [slots, setSlots] = useState<SlotCount>({ phase: 'idle' });

  // One list_clients when the card mounts (or the operator client changes). No polling.
  useEffect(() => {
    if (!applies || !operator) { setSlots({ phase: 'idle' }); return; }
    let live = true;
    setSlots({ phase: 'idle' });
    listClients(operator)
      .then(list => { if (live) setSlots({ phase: 'ready', used: list.length }); })
      .catch(() => { if (live) setSlots({ phase: 'failed' }); });
    return () => { live = false; };
  }, [applies, operator]);

  if (!applies) return null;
  const name = dependant.displayName;

  const connected: ReadinessState = signerStatus === 'connected' ? 'ok' : signerStatus === 'unavailable' ? 'fail' : 'checking';

  const block = staticPairBlock({ dependant, hasOperator: !!operator, status: operatorStatus });
  const operatorState: ReadinessState = operator ? 'ok' : operatorLoading ? 'checking' : 'fail';

  let firmware: ReadinessState;
  if (!operator) firmware = 'unknown';
  else if (block === 'device-unsupported') firmware = 'fail';
  else if (operatorStatus) firmware = 'ok';
  else if (operatorStatusError) firmware = 'unknown';
  else firmware = 'checking';

  let slotState: ReadinessState;
  let slotDetail: string | null = null;
  if (!operator) slotState = 'unknown';
  else if (slots.phase === 'failed') slotState = 'unknown';
  else if (slots.phase === 'ready') {
    slotState = slots.used >= MAX_CONNECT_SLOTS ? 'fail' : 'ok';
    slotDetail = COPY.slotsInUse(slots.used, MAX_CONNECT_SLOTS);
  } else slotState = 'checking';

  const personaState: ReadinessState = childDirectPersona(dependant) ? 'ok' : 'fail';

  const statusText = (s: ReadinessState, notYet?: string) =>
    s === 'ok' ? COPY.ok : s === 'fail' ? COPY.fail : s === 'checking' ? COPY.checking : (notYet ?? COPY.couldntCheck);

  interface Row { key: string; label: string; state: ReadinessState; detail?: string | null; unknownText?: string; fix?: string; action?: { label: string; run: () => void } }
  const rows: Row[] = [
    { key: 'connected', label: COPY.connected.label, state: connected, fix: COPY.connected.fix },
    {
      key: 'operator', label: COPY.operator.label, state: operatorState, fix: COPY.operator.fix,
      action: props.onOpenOperatorImport ? { label: COPY.operator.action, run: props.onOpenOperatorImport } : undefined,
    },
    { key: 'firmware', label: COPY.firmware.label, state: firmware, unknownText: operator ? undefined : COPY.needsOperator, fix: COPY.firmware.fix },
    { key: 'slots', label: COPY.slots.label, state: slotState, detail: slotDetail, unknownText: operator ? undefined : COPY.needsOperator, fix: COPY.slots.fix },
    {
      key: 'persona', label: COPY.persona.label(name), state: personaState, fix: COPY.persona.fix,
      action: props.onFixPersona ? { label: COPY.persona.action, run: props.onFixPersona } : undefined,
    },
  ];

  return (
    <div data-testid="pair-readiness" style={{ marginBottom: 12 }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>{COPY.heading}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(r => (
          <li key={r.key} data-row={r.key} data-state={r.state} style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span aria-hidden="true" style={{ width: 16, textAlign: 'center', fontWeight: 700, color: r.state === 'ok' ? 'var(--success, #2e7d32)' : r.state === 'fail' ? 'var(--danger, #c62828)' : 'var(--text-muted)' }}>{mark(r.state)}</span>
              <span style={{ flex: 1 }}>{r.label}{r.detail ? ` — ${r.detail}` : ''}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{statusText(r.state, r.unknownText)}</span>
            </div>
            {r.state === 'fail' && (
              <div style={{ marginLeft: 24, marginTop: 4, color: 'var(--text-secondary)' }}>
                <span>{r.fix}</span>
                {r.action && (
                  <button className="btn btn-ghost btn-sm" onClick={r.action.run} style={{ marginLeft: 8 }}>{r.action.label}</button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
