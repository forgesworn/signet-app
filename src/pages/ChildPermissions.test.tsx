// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChildRule } from '../types/child-rules';
import type { ConnectedChildApp } from '../lib/child-activity';
import type { ChildAskHistoryEntry } from '../hooks/useChildAsks';
import { childRuleId } from '../lib/child-rules';
import { ChildPermissions, type ChildPermissionsProps } from './ChildPermissions';

const DEP = 'ef'.repeat(32);
const SKY = 'ab'.repeat(32), GAMER = 'cd'.repeat(32);
const APP = '12'.repeat(32);
const NOW = 1_700_000_000_000;

const rule = (over: Partial<ChildRule>): ChildRule => {
  const base = { dependantId: DEP, persona: SKY, scope: 'sign-in', target: 'site:https://school.org', decision: 'allow', createdAt: 1, updatedAt: 1, ...over } as ChildRule;
  return { ...base, id: childRuleId(base.dependantId, base.persona, base.scope, base.target) };
};
const apps: ConnectedChildApp[] = [
  { appId: APP, kind: 'nip46', label: 'Block Game', persona: GAMER, firstSeen: 1, lastUsed: NOW / 1000 },
  { appId: 'nip55:com.chat', kind: 'nip55', label: 'Chatty', persona: SKY, firstSeen: 1, lastUsed: NOW / 1000 },
];
const history: ChildAskHistoryEntry[] = [{
  ask: { v: 1, id: 'a'.repeat(32), dependantId: DEP, persona: SKY, scope: 'sign-in', kind: 21236, method: 'sign_event',
    target: 'site:https://school.org', targetLabel: 'School', createdAt: NOW / 1000 - 60, expiresAt: NOW / 1000 + 540 },
  verdict: { v: 1, id: 'a'.repeat(32), verdict: 'always', decidedAt: NOW / 1000 - 30 },
  sent: true,
}];

function setup(over: Partial<ChildPermissionsProps> = {}) {
  const props: ChildPermissionsProps = {
    viewer: 'guardian', childName: 'Sky',
    personas: [{ pubkey: SKY, name: 'Skylark' }, { pubkey: GAMER, name: 'Gamer' }],
    stage: 'request-approve',
    rules: [
      rule({}),
      rule({ persona: GAMER, scope: 'kind:30023', target: `app:${APP}`, decision: 'deny', label: 'Block Game', lastUsedAt: NOW - 3_600_000 }),
      rule({ persona: '*', scope: 'post-public', target: '*' }),
    ],
    ceilingKinds: [22242, 21236, 1],
    apps, disconnectedApps: ['nip55:com.chat'], history, paired: true, nowMs: NOW,
    onRevokeRule: vi.fn(async () => {}), onBlockApp: vi.fn(async () => {}),
    onRemovePersona: vi.fn(async () => {}), onUnpair: vi.fn(async () => {}), onOpenStage: vi.fn(),
    ...over,
  };
  render(<ChildPermissions {...props} />);
  return props;
}

describe('ChildPermissions — guardian', () => {
  it('groups the rules by persona, with type, target, decision and last use', () => {
    setup();
    const sky = screen.getByTestId(`persona-${SKY}`);
    expect(within(sky).getByText('Skylark')).toBeInTheDocument();
    expect(within(sky).getByTestId('child-rule')).toHaveTextContent('Sign-in · school.org');
    expect(within(sky).getByTestId('child-rule')).toHaveTextContent('Always allow');
    const gamer = screen.getByTestId(`persona-${GAMER}`);
    expect(within(gamer).getByTestId('child-rule')).toHaveTextContent('Other type (30023)');
    expect(within(gamer).getByTestId('child-rule')).toHaveTextContent('Always deny');
    expect(within(gamer).getByTestId('child-rule')).toHaveTextContent('Last used');
    const all = screen.getByTestId('persona-*');
    expect(within(all).getByText("All of Sky's identities")).toBeInTheDocument();
    expect(within(all).getByTestId('child-rule')).toHaveTextContent('Public posts · anywhere');
  });

  it('shows the Heartwood ceiling in human names, the stage and a link to change it', () => {
    const p = setup();
    expect(screen.getByText('Allowed types on the Heartwood')).toBeInTheDocument();
    expect(screen.getByTestId('ceiling-types')).toHaveTextContent('Public posts');
    expect(screen.getByTestId('ceiling-types')).toHaveTextContent('Sign-in');
    expect(screen.getByTestId('ceiling-types')).toHaveTextContent('Relay sign-in');
    fireEvent.click(screen.getByRole('button', { name: 'Change stage' }));
    expect(p.onOpenStage).toHaveBeenCalled();
  });

  it('Revoke hands the rule to the caller (tombstone + republish)', async () => {
    const p = setup();
    const sky = screen.getByTestId(`persona-${SKY}`);
    fireEvent.click(within(sky).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(p.onRevokeRule).toHaveBeenCalledWith(expect.objectContaining({ persona: SKY, scope: 'sign-in' })));
  });

  it('lists the apps on the phone; Block is offered only for an unblocked app', async () => {
    const p = setup();
    expect(screen.getByText("Apps on Sky's phone")).toBeInTheDocument();
    const rows = screen.getAllByTestId('child-app');
    expect(rows[0]).toHaveTextContent('Block Game');
    expect(rows[0]).toHaveTextContent('As Gamer');
    expect(within(rows[1]).getByText('Blocked')).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: 'Block' })).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(p.onBlockApp).toHaveBeenCalledWith(apps[0]));
  });

  it('removes a persona from the phone only after the confirm', async () => {
    const p = setup();
    const gamer = screen.getByTestId(`persona-${GAMER}`);
    fireEvent.click(within(gamer).getByRole('button', { name: "Remove from Sky's phone" }));
    expect(p.onRemovePersona).not.toHaveBeenCalled();
    expect(screen.getByText(/Gamer will stop signing on Sky's phone at once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove now' }));
    await waitFor(() => expect(p.onRemovePersona).toHaveBeenCalledWith(GAMER));
    expect(await screen.findByText("Removed from Sky's phone")).toBeInTheDocument();
  });

  it('A51: the bound persona has no "Remove from phone" (unpair is the way)', () => {
    setup({ boundPersona: SKY });
    expect(within(screen.getByTestId(`persona-${SKY}`)).queryByRole('button', { name: "Remove from Sky's phone" })).toBeNull();
    expect(within(screen.getByTestId(`persona-${GAMER}`)).getByRole('button', { name: "Remove from Sky's phone" })).toBeInTheDocument();
  });

  it('unpairs only after the confirm', async () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Unpair this phone' }));
    expect(p.onUnpair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unpair now' }));
    await waitFor(() => expect(p.onUnpair).toHaveBeenCalled());
  });

  it('shows the asks history', () => {
    setup();
    const past = screen.getByTestId('child-ask-history');
    expect(past).toHaveTextContent('Sign-in · school.org');
    expect(past).toHaveTextContent('Always allowed');
  });

  it('a failed Block says so', async () => {
    setup({ onBlockApp: vi.fn(async () => { throw new Error('x'); }) });
    fireEvent.click(within(screen.getAllByTestId('child-app')[0]).getByRole('button', { name: 'Block' }));
    expect(await screen.findByText('Could not block this app. Try again.')).toBeInTheDocument();
  });
});

describe('ChildPermissions — child viewer', () => {
  it('renders the same layout read-only: no action buttons at all', () => {
    setup({ viewer: 'child', history: undefined });
    expect(screen.getByText('Allowed types on the Heartwood')).toBeInTheDocument();
    expect(screen.getAllByTestId('child-rule').length).toBe(3);
    expect(screen.getByText('Apps on this phone')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says when the rules have not arrived yet, and when the phone is unpaired', () => {
    setup({ viewer: 'child', rules: [], ceilingKinds: null, stage: null, paired: false });
    expect(screen.getByText('Your guardian has unpaired this phone.')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for your guardian’s rules/)).toBeInTheDocument();
  });
});

describe('A60: the child sees its own asks', () => {
  it('lists waiting and answered asks, read-only', () => {
    setup({ viewer: 'child', history: undefined, childAsks: [
      { id: '1', targetLabel: 'Block Game', persona: GAMER, kind: 1, scope: 'post-public', since: NOW / 1000 - 60, state: 'waiting' },
      { id: '2', targetLabel: 'School', persona: SKY, kind: 21236, scope: 'sign-in', since: NOW / 1000 - 120, state: 'approved' },
    ] });
    const list = screen.getByTestId('child-own-asks');
    expect(within(list).getByText(/Block Game/)).toBeInTheDocument();
    expect(within(list).getByText(/Waiting for your guardian/)).toBeInTheDocument();
    expect(within(list).getByText(/Allowed/)).toBeInTheDocument();
    expect(within(list).queryByRole('button')).toBeNull();
  });
});
