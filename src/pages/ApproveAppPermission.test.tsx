// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { ApproveAppPermission, formatPermissionDate, shortKey } from './ApproveAppPermission';
import { RelayAuthAck } from './RelayAuthAck';
import { parseAppPermissionRequest, type AppPermissionRequest } from '../lib/app-permission';
import { routeAppPermission, type AppPermissionRoute } from '../lib/app-permission-flow';
import { APP_PERMISSION_COPY as COPY } from '../lib/app-permission-copy';

const NOW = Math.floor(Date.now() / 1000);
const PERSONA = getPublicKey(generateSecretKey());
const INSTALL = getPublicKey(generateSecretKey());
const SESSION = getPublicKey(generateSecretKey());
const UNTIL = NOW + 90 * 86400;
const tags = [['d', 'twang-thang'], ['p', INSTALL], ['valid_from', String(NOW)], ['valid_until', String(UNTIL)], ['v', '1'], ['role', 'player'], ['expiration', String(UNTIL)]];

function request(): AppPermissionRequest {
  const p = new URLSearchParams({
    action: 'app-permission', permission: 'online-play', origin: 'https://twang.example', name: 'Twang Thang',
    reason: 'Twang Thang shows the other players it is really you.',
    template: Buffer.from(JSON.stringify({ kind: 30420, pubkey: PERSONA, content: '', tags }), 'utf8').toString('base64url'),
    relay: 'wss://relay.example', sessionPubkey: SESSION, challenge: 'ab'.repeat(32), t: String(NOW), callback: 'https://twang.example/back',
  });
  const r = parseAppPermissionRequest(`?${p}`, NOW);
  if (!r.ok) throw new Error('fixture: ' + r.reason);
  return r.request;
}

const adult: AppPermissionRoute = { mode: 'adult', persona: PERSONA };
const child: AppPermissionRoute = { mode: 'child-direct', persona: PERSONA };

function show(route: AppPermissionRoute, over: { onApprove?: () => Promise<void>; onCancel?: () => void } = {}) {
  const onApprove = over.onApprove ?? vi.fn(async () => {});
  const onCancel = over.onCancel ?? vi.fn();
  render(<ApproveAppPermission request={request()} route={route} personaName="Sky" onApprove={onApprove} onCancel={onCancel} />);
  return { onApprove, onCancel };
}

describe('ApproveAppPermission — adult', () => {
  it('shows the app, its reason in its own words, My Signet\'s fixed explanation, the origin and the details', () => {
    show(adult);
    expect(screen.getByRole('heading').textContent).toBe(COPY.headingAdult('Twang Thang', 'Sky'));
    expect(screen.getByTestId('app-permission-reason').textContent).toBe(COPY.appSays('Twang Thang shows the other players it is really you.'));
    expect(screen.getByTestId('app-permission-allows').textContent)
      .toBe(COPY.allowsAdult('Twang Thang', 'Sky', formatPermissionDate(UNTIL)));
    expect(screen.getByText(COPY.from('twang.example'))).toBeTruthy();
    expect(screen.getByText(`${COPY.appId}: twang-thang`)).toBeTruthy();
    expect(screen.getByText(`${COPY.installKey}: ${shortKey(INSTALL)}`)).toBeTruthy();
  });

  it('Allow calls onApprove once and shows it working', async () => {
    let finish!: () => void;
    const onApprove = vi.fn(() => new Promise<void>(r => { finish = r; }));
    show(adult, { onApprove });
    const allow = screen.getByRole('button', { name: COPY.allow });
    fireEvent.click(allow);
    fireEvent.click(allow);
    await waitFor(() => expect(screen.getByRole('button', { name: COPY.working })).toBeTruthy());
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: COPY.cancel }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
  });

  it('a failed approval is shown and the page can try again', async () => {
    const onApprove = vi.fn().mockRejectedValueOnce(new Error('Signer is not reachable')).mockResolvedValue(undefined);
    show(adult, { onApprove });
    fireEvent.click(screen.getByRole('button', { name: COPY.allow }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: COPY.allow }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2));
  });

  it('Cancel declines without approving', () => {
    const { onApprove, onCancel } = show(adult);
    fireEvent.click(screen.getByRole('button', { name: COPY.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('ApproveAppPermission — a direct-paired child', () => {
  it('says the guardian decides, and after asking shows the waiting panel with a way out', async () => {
    const onApprove = vi.fn(() => new Promise<void>(() => {}));
    const { onCancel } = show(child, { onApprove });
    expect(screen.getByRole('heading').textContent).toBe(COPY.headingChild('Twang Thang'));
    expect(screen.getByTestId('app-permission-allows').textContent).toContain('Your guardian decides');
    fireEvent.click(screen.getByRole('button', { name: COPY.askGuardian }));
    await waitFor(() => expect(screen.getByText('Asking your guardian…')).toBeTruthy());
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ApproveAppPermission — a child\'s ask that did not get through (I1)', () => {
  it('shows a plain retryable error, sends nothing, and Try again asks afresh', async () => {
    const onApprove = vi.fn().mockRejectedValueOnce(new Error(COPY.guardianUnreachable)).mockImplementation(() => new Promise<void>(() => {}));
    const { onCancel } = show(child, { onApprove });
    fireEvent.click(screen.getByRole('button', { name: COPY.askGuardian }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(COPY.guardianUnreachable));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: COPY.tryAgain }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ApproveAppPermission — refusals', () => {
  const base = { persona: PERSONA, signingMode: 'local', childDirect: false, ownerPersonas: [] as string[], dependantPersonas: [] as string[], childPersonas: [] as string[] };
  const cases: Array<[string, AppPermissionRoute]> = [
    ['persona not on the device', routeAppPermission(base)],
    ['a dependant held on the guardian\'s phone', routeAppPermission({ ...base, dependantPersonas: [PERSONA] })],
    ['a legacy phone-paired child', routeAppPermission({ ...base, signingMode: 'paired-child' })],
    ['a guardian in child mode', routeAppPermission({ ...base, ownerPersonas: [PERSONA], guardianActingAsChild: true })],
  ];
  it.each(cases)('%s: plain copy, no way to allow, Close declines', (_name, route) => {
    expect(route.mode).toBe('refused');
    const { onApprove, onCancel } = show(route);
    if (route.mode !== 'refused') return;
    expect(screen.getByRole('alert').textContent).toBe(COPY.refusals[route.reason]);
    expect(screen.queryByRole('button', { name: COPY.allow })).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.askGuardian })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: COPY.close }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });
  it('each refusal reads differently', () => {
    expect(new Set(Object.values(COPY.refusals)).size).toBe(Object.keys(COPY.refusals).length);
  });
});

describe('RelayAuthAck — app-permission variant', () => {
  it('approved and declined use the permission wording, not "Signed in"', () => {
    const { rerender } = render(<RelayAuthAck state="approved" siteName="Twang Thang" variant="app-permission" onClose={() => {}} />);
    expect(screen.getByRole('heading').textContent).toBe(COPY.ackApprovedTitle);
    expect(screen.queryByText(/Signed in/)).toBeNull();
    rerender(<RelayAuthAck state="denied" siteName="Twang Thang" variant="app-permission" onClose={() => {}} />);
    expect(screen.getByRole('heading').textContent).toBe(COPY.ackDeniedTitle);
  });
  it('a failed delivery says "request", not "sign-in"', () => {
    render(<RelayAuthAck state="failed" variant="app-permission" relayHost="r.example" requestedRelay="r.example" siteName="Twang Thang" onRetry={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(/sign-in/)).toBeNull();
    expect(screen.getByText(/start a new request/)).toBeTruthy();
  });
  it('the default is still the sign-in wording', () => {
    render(<RelayAuthAck state="approved" siteName="Fathom" onClose={() => {}} />);
    expect(screen.getByRole('heading').textContent).toBe('Signed in');
  });
});
