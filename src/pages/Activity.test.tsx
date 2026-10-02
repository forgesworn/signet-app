// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DependantIdentity } from '../types';
import type { MergedActivityRow } from '../lib/child-activity';
import { Activity } from './Activity';

const PERSONA = 'ab'.repeat(32), EXTRA = 'cd'.repeat(32);
const dep = {
  id: 'ef'.repeat(32), displayName: 'Sky',
  naturalPerson: { publicKey: 'ef'.repeat(32), displayName: '' },
  persona: { publicKey: PERSONA, displayName: 'Skylark' },
  extraPersonas: [{ publicKey: EXTRA, displayName: 'Gamer' }],
} as unknown as DependantIdentity;

const now = Math.floor(Date.now() / 1000);

describe('Activity — merged child-direct timeline', () => {
  it('shows persona, app, outcome and the mismatch copy', () => {
    const rows: MergedActivityRow[] = [
      {
        entry: { persona: PERSONA, kind: 22242, method: 'sign_event', outcome: 'signed', appId: 'https://school.org', appLabel: 'School', target: 'site:https://school.org', requestCreatedAt: now - 60, at: now - 60 },
        device: { id: 'd1', dependantPubkey: PERSONA, createdAt: now - 60, outcome: 'auto-approved', eventKind: 22242 },
        mismatch: false,
      },
      {
        entry: { persona: EXTRA, kind: 1, method: 'sign_event', outcome: 'denied', appId: 'nip55:com.chat', appLabel: 'Chatty', at: now - 120 },
        device: null, mismatch: false,
      },
      { entry: null, device: { id: 'd2', dependantPubkey: EXTRA, createdAt: now - 1200, outcome: 'auto-approved', eventKind: 1 }, mismatch: true },
    ];
    render(<Activity dependant={dep} entries={[]} loading={false} error={null} onRefresh={() => {}} merged={rows} />);
    const items = screen.getAllByTestId('merged-activity-row');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Signed in to school.org');
    expect(items[0]).toHaveTextContent('As Skylark · School · Signed');
    expect(items[1]).toHaveTextContent('As Gamer · Chatty · Denied');
    expect(items[2]).toHaveTextContent('On the Heartwood');
    expect(items[2]).toHaveTextContent("Signed on the Heartwood but not reported by Sky's phone");
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('A48: a record the guardian made as the child reads "Signed by you", with no mismatch', () => {
    const rows: MergedActivityRow[] = [
      { entry: null, device: { id: 'g', dependantPubkey: PERSONA, createdAt: now - 1200, outcome: 'auto-approved', eventKind: 1 }, mismatch: false, byGuardian: true },
    ];
    render(<Activity dependant={dep} entries={[]} loading={false} error={null} onRefresh={() => {}} merged={rows} />);
    const [item] = screen.getAllByTestId('merged-activity-row');
    expect(item).toHaveTextContent('As Skylark · Signed by you · Signed');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('A48: a guardian signing with no Heartwood record still reads "Signed by you"', () => {
    const rows: MergedActivityRow[] = [
      { entry: null, device: null, mismatch: false, byGuardian: true,
        guardian: { source: 'guardian', persona: PERSONA, kind: 0, method: 'sign_event', requestCreatedAt: now - 30, at: now - 29 } },
    ];
    render(<Activity dependant={dep} entries={[]} loading={false} error={null} onRefresh={() => {}} merged={rows} />);
    const [item] = screen.getAllByTestId('merged-activity-row');
    expect(item).toHaveTextContent('As Skylark · Signed by you · Signed');
  });

  it('a request the Heartwood never answered is not shown as denied', () => {
    const rows: MergedActivityRow[] = [
      { entry: { persona: PERSONA, kind: 22242, method: 'sign_event', outcome: 'unanswered', appId: 'site:https://x.org', appLabel: 'Harness', requestCreatedAt: now - 60, at: now - 29 }, device: null, mismatch: false },
    ];
    render(<Activity dependant={dep} entries={[]} loading={false} error={null} onRefresh={() => {}} merged={rows} />);
    const [item] = screen.getAllByTestId('merged-activity-row');
    expect(item).toHaveTextContent("Didn't complete (Heartwood didn't answer in time)");
    expect(item).not.toHaveTextContent('Denied');
  });

  it('empty merged timeline has its own copy', () => {
    render(<Activity dependant={dep} entries={[]} loading={false} error={null} onRefresh={() => {}} merged={[]} />);
    expect(screen.getByText("What Sky's phone signs, and what it asks you, will appear here.")).toBeInTheDocument();
  });
});
