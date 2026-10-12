// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DependantIdentity } from '../types';
import type { DeviceStatus } from '../lib/heartwood-mgmt-types';
import type { HeartwoodMgmtClient } from '../lib/heartwood-mgmt';

const listClientsMock = vi.fn();
vi.mock('../lib/heartwood-mgmt', async (orig) => ({
  ...(await orig<typeof import('../lib/heartwood-mgmt')>()),
  listClients: (...a: unknown[]) => listClientsMock(...a),
}));

import { PairReadinessChecklist, type PairReadinessChecklistProps } from './PairReadinessChecklist';

const dep = (over: Partial<DependantIdentity> = {}): DependantIdentity => ({
  id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
  naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
  persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
  derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'request-approve', primaryKeypair: 'persona',
  ...over,
} as DependantIdentity);

const status = (capabilities: string[] | null = ['pairing_identity_v1']): DeviceStatus =>
  ({ capabilities, masterNpubHex: 'a'.repeat(64), truncated: capabilities === null });
const operator = {} as HeartwoodMgmtClient;
const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ slotIndex: i, label: `l${i}` }));

function renderIt(over: Partial<PairReadinessChecklistProps> = {}) {
  const props: PairReadinessChecklistProps = {
    dependant: dep(), signingMode: 'bunker', signerStatus: 'connected', operator, operatorStatus: status(),
    onOpenOperatorImport: vi.fn(), onFixPersona: vi.fn(), ...over,
  };
  render(<PairReadinessChecklist {...props} />);
  return props;
}
const row = (k: string) => document.querySelector(`[data-row="${k}"]`) as HTMLElement;

beforeEach(() => { cleanup(); listClientsMock.mockReset(); });

describe('PairReadinessChecklist', () => {
  it('shows every row ready when all is well, with the slot count', async () => {
    listClientsMock.mockResolvedValue(slots(3));
    renderIt();
    await waitFor(() => expect(row('slots')).toHaveTextContent('3 of 16 in use'));
    for (const k of ['connected', 'operator', 'firmware', 'slots', 'persona']) expect(row(k)).toHaveAttribute('data-state', 'ok');
    expect(screen.getByText('Sam has an active persona')).toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).toBeNull();
    expect(listClientsMock).toHaveBeenCalledTimes(1);
  });

  it('flags a missing operator key and offers the import', () => {
    const p = renderIt({ operator: null, operatorStatus: null });
    expect(row('operator')).toHaveAttribute('data-state', 'fail');
    expect(row('firmware')).toHaveTextContent('Needs the operator key first');
    expect(listClientsMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import operator key' }));
    expect(p.onOpenOperatorImport).toHaveBeenCalledTimes(1);
  });

  it('flags firmware that cannot pair phones', async () => {
    listClientsMock.mockResolvedValue(slots(1));
    renderIt({ operatorStatus: status(['other']) });
    expect(row('firmware')).toHaveAttribute('data-state', 'fail');
    expect(row('firmware')).toHaveTextContent('Update it in Sapwood.');
  });

  it('flags a full Heartwood', async () => {
    listClientsMock.mockResolvedValue(slots(16));
    renderIt();
    await waitFor(() => expect(row('slots')).toHaveAttribute('data-state', 'fail'));
    expect(row('slots')).toHaveTextContent('16 of 16 in use');
    expect(row('slots')).toHaveTextContent('Remove one in Sapwood.');
  });

  it('flags a missing persona and offers the persona screen', () => {
    listClientsMock.mockResolvedValue(slots(1));
    const p = renderIt({ dependant: dep({ persona: { publicKey: '', privateKey: '', displayName: 'Sam' } as DependantIdentity['persona'] }) });
    expect(row('persona')).toHaveAttribute('data-state', 'fail');
    fireEvent.click(screen.getByRole('button', { name: 'Go to personas' }));
    expect(p.onFixPersona).toHaveBeenCalledTimes(1);
  });

  it('flags an unavailable Heartwood and shows checking while connecting', () => {
    listClientsMock.mockResolvedValue(slots(1));
    renderIt({ signerStatus: 'unavailable' });
    expect(row('connected')).toHaveAttribute('data-state', 'fail');
    expect(row('connected')).toHaveTextContent("Check it's switched on and online.");
    cleanup();
    renderIt({ signerStatus: 'connecting' });
    expect(row('connected')).toHaveAttribute('data-state', 'checking');
    expect(row('connected')).toHaveTextContent('checking…');
  });

  it("reads \"Couldn't check\" (not a fault) when list_clients fails", async () => {
    listClientsMock.mockRejectedValue(new Error('timeout'));
    renderIt();
    await waitFor(() => expect(row('slots')).toHaveAttribute('data-state', 'unknown'));
    expect(row('slots')).toHaveTextContent("Couldn't check");
    expect(row('slots')).not.toHaveTextContent('Remove one in Sapwood.');
  });

  it('asks once on mount and never polls', async () => {
    vi.useFakeTimers();
    try {
      listClientsMock.mockResolvedValue(slots(2));
      renderIt();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(listClientsMock).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('renders nothing off the child-direct path', () => {
    renderIt({ signingMode: 'local' });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    cleanup();
    renderIt({ signingMode: 'paired-child' });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    cleanup();
    // imported dependant (no tree path)
    renderIt({ dependant: dep({ derivationPath: undefined }) });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    cleanup();
    // keys still on this phone (not yet migrated)
    renderIt({ dependant: dep({ persona: { publicKey: 'd'.repeat(64), privateKey: 'f'.repeat(64), displayName: 'Sam' } as DependantIdentity['persona'] }) });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    expect(listClientsMock).not.toHaveBeenCalled();
  });
});
