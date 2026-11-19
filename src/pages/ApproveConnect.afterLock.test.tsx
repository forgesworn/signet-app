// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { ApproveConnect, type ConnectSignMode } from './ApproveConnect';
import type { SignetIdentity } from '../types';
import type { NostrConnectRequest } from '../lib/nip46';
import { AuthRequestSettlement, requestObjectKey } from '../lib/auth-request-settlement';
import { trackApproval, type ConnectOutcome } from '../lib/connect-outcome';
import { deliverConnectApproval } from '../lib/connect-delivery';
import { ConnectRouteTracker } from '../lib/connect-route-cancel';
import {
  HANDOFF_LINK_DROPPED_KEPT_COPY,
  HANDOFF_UNCERTAIN_KEPT_COPY,
  HandoffKeptError,
  HandoffNotSavedError,
  runHandoffApproval,
  settleHandoff,
  type HandoffPlan,
  type HandoffResult,
} from '../lib/heartwood-handoff';

afterEach(cleanup);

const PERSONA = 'b'.repeat(64);
const request: NostrConnectRequest = {
  clientPubkey: '1'.repeat(64),
  relayUrl: 'wss://relay.example.com',
  relayUrls: ['wss://relay.example.com'],
  secret: 's3cret',
  appName: 'Test App',
  permissions: ['sign_event:1', 'nip44_encrypt'],
};
const otherRequest: NostrConnectRequest = { ...request, clientPubkey: '2'.repeat(64), appName: 'Other App' };
const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: PERSONA, privateKey: '', displayName: 'C1 Burner' },
  primaryKeypair: 'persona',
  isChild: false,
  createdAt: 0,
  naturalPersonActive: false,
} as unknown as SignetIdentity;

const KEPT_SLOT = { deviceHex: 'd'.repeat(64), targetHex: PERSONA, relay: 'wss://relay.example.com', secretFingerprint: '' };
const PLAN = {} as HandoffPlan;
const MINTED = { deviceHex: 'd'.repeat(64), targetHex: PERSONA, relay: 'wss://relay.example.com', slotIndex: 1, secretFingerprint: 'f' } as unknown as HandoffResult;

interface Env {
  settlement: AuthRequestSettlement;
  routes: ConnectRouteTracker;
  /** Route tokens App would have cleared. */
  clearedRoutes: number[];
}
type Run = (env: Env, key: string, options: { askToSign: boolean; viaHeartwood?: boolean }) => Promise<void>;

/** A gate the test opens by hand, so an approval can be locked mid-flight. */
function gate() {
  let open!: () => void;
  let fail!: (e: unknown) => void;
  const wait = new Promise<void>((res, rej) => { open = res; fail = rej; });
  return { wait, open, fail };
}

/**
 * The phone branch's own path: the real `deliverConnectApproval` with the
 * claim, unclaim and finish wired to the settlement the way App wires them.
 * `send` is the one fake (the relay publish).
 */
function phoneRun(send: () => Promise<boolean>): Run {
  return async ({ settlement, routes }, key) => {
    let token = 0;
    const delivery = await deliverConnectApproval({
      relayCandidates: ['wss://relay.example.com'],
      stillOpen: () => settlement.isInFlight(key),
      claim: () => settlement.claimDelivery(key),
      unclaim: () => settlement.unclaimDelivery(key),
      finishDelivery: () => settlement.finishDelivery(key),
      installRoute: () => { token = 7; routes.record(key, token); },
      clearRoute: () => {},
      arm: async () => {},
      loadExisting: async () => undefined,
      saveClient: async () => {},
      restoreClient: async () => {},
      deleteClient: async () => {},
      stillOurs: async () => true,
      send: async (_relay, beforePublish) => { beforePublish(); return send(); },
    });
    if (delivery.status === 'withdrawn' || delivery.status === 'cancelled') return;
    if (delivery.status === 'failed') throw new Error(`Could not complete NostrConnect pairing. Tried 1 relay: ${delivery.failures.join(' | ')}`);
    routes.forget(key);
  };
}

/**
 * The Heartwood branch's own path: the real `runHandoffApproval` and
 * `settleHandoff`, wired to the settlement as in App. `mint` and `persist` are
 * the fakes (the device and the encrypted store).
 */
function heartwoodRun(mint: () => Promise<HandoffResult>, persist: () => Promise<void> = async () => {}): Run {
  return async ({ settlement }, key) => {
    const approval = await runHandoffApproval({
      priors: [],
      prepare: async () => PLAN,
      claim: () => settlement.claimDelivery(key),
      unclaim: () => settlement.unclaimDelivery(key),
      cancelRequested: () => settlement.isCancelRequested(key),
      endCancelled: () => { settlement.finishDelivery(key); },
      revokePrior: async () => {},
      mint,
    }).catch((e: unknown) => {
      if (e instanceof HandoffKeptError) settlement.finishDelivery(key);
      throw e;
    });
    if (approval.status === 'withdrawn') return;
    const cancelled = settlement.finishDelivery(key);
    const settled = await settleHandoff({ cancelled, track: () => {}, untrack: () => {}, persist, undo: async () => {} });
    if (settled === 'undone' || settled === 'cancelled-kept') return;
  };
}

interface Probe {
  lock: () => void;
  unlock: () => void;
  /** Back / Close / Deny: App's handleConnectDone. */
  done: () => void;
  replaceRequest: () => void;
  denials: string[];
  routesCleared: number[];
  pendingName: () => string | null;
  settlement: AuthRequestSettlement;
  approvedWith: Array<{ askToSign: boolean; viaHeartwood?: boolean }>;
}

/**
 * Stands in for App: it owns the request, the settlement, the route tracker,
 * the outcome and the sign mode, and mounts the page only while unlocked.
 * `lock()` drops the page (a new mount on `unlock()`) while an approval that
 * already started keeps running, as in App.
 */
function Harness({ runs, probe }: { runs: Run[]; probe: Probe }) {
  const settlementRef = useRef(new AuthRequestSettlement());
  const routesRef = useRef(new ConnectRouteTracker());
  const [pending, setPendingState] = useState<NostrConnectRequest | null>(request);
  const pendingRef = useRef<NostrConnectRequest | null>(request);
  const attempt = useRef(0);
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  const [signChoice, setSignChoice] = useState<{ key: string; mode: ConnectSignMode } | null>(null);
  const [locked, setLocked] = useState(false);
  const setPending = (r: NostrConnectRequest | null) => {
    pendingRef.current = r;
    setPendingState(r);
    if (!r) { setOutcome(null); setSignChoice(null); }
  };
  probe.lock = () => setLocked(true);
  probe.unlock = () => setLocked(false);
  probe.settlement = settlementRef.current;
  probe.pendingName = () => pending?.appName ?? null;
  probe.replaceRequest = () => setPending(otherRequest);

  async function approve(_sel: unknown, options: { askToSign: boolean; viaHeartwood?: boolean }) {
    probe.approvedWith.push(options);
    const req = pendingRef.current!;
    const key = requestObjectKey(req);
    const began = settlementRef.current.beginApproval(key);
    if (began === 'in-flight') throw new Error('Already connecting this request.');
    if (began === 'settled') { setPending(null); return; }
    const run = runs[Math.min(attempt.current++, runs.length - 1)];
    try {
      await trackApproval({
        key,
        settlement: settlementRef.current,
        isCurrent: () => pendingRef.current === req,
        record: setOutcome,
        run: () => run({ settlement: settlementRef.current, routes: routesRef.current, clearedRoutes: probe.routesCleared }, key, options),
      });
    } finally {
      settlementRef.current.endApproval(key);
    }
  }

  // App's handleConnectDone: no callback and no route teardown for an answered request.
  function done() {
    const req = pendingRef.current;
    if (!req) return;
    const key = requestObjectKey(req);
    const result = settlementRef.current.deny(key);
    const cancelRecorded = result === 'already-answered' && settlementRef.current.requestCancelDuringDelivery(key);
    const token = routesRef.current.takeOnCancel(key, result, cancelRecorded);
    if (token !== null) probe.routesCleared.push(token);
    if (result !== 'already-answered') probe.denials.push('denied');
    setPending(null);
  }
  probe.done = done;

  if (!pending) return <p>home</p>;
  if (locked) return <p>locked</p>;
  const key = requestObjectKey(pending);
  return (
    <ApproveConnect
      key={key}
      request={pending}
      outcome={outcome?.key === key ? outcome : undefined}
      signChoice={signChoice?.key === key ? signChoice.mode : undefined}
      onSignChoice={mode => setSignChoice({ key, mode })}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={[PERSONA]}
      requireNpConfirmation={true}
      canHandOffToHeartwood={() => true}
      onApprove={approve}
      onDeny={done}
    />
  );
}

function mount(...runs: Run[]) {
  const probe: Probe = {
    lock: () => {}, unlock: () => {}, done: () => {}, replaceRequest: () => {},
    denials: [], routesCleared: [], pendingName: () => null,
    settlement: new AuthRequestSettlement(), approvedWith: [],
  };
  render(<Harness runs={runs} probe={probe} />);
  return probe;
}

async function settleMicrotasks() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Press Approve, lock while the approval is running, let it end, unlock. */
async function approveLockFinishUnlock(probe: Probe, finish: () => void) {
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('Sending...');
  act(() => probe.lock());
  expect(screen.getByText('locked')).toBeTruthy();
  finish();
  await settleMicrotasks();
  act(() => probe.unlock());
}

function expectNoApproveOrDeny() {
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
}

const KEY = () => requestObjectKey(request);

describe('ApproveConnect remounted after a lock: Heartwood branch (its own approval path)', () => {
  const pick = () => fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));

  it('success: Connected, no Approve or Deny; Close sends no callback', async () => {
    const g = gate();
    const probe = mount(heartwoodRun(async () => { await g.wait; return MINTED; }));
    pick();
    await approveLockFinishUnlock(probe, g.open);
    expect(await screen.findByText('Connected!')).toBeTruthy();
    expectNoApproveOrDeny();
    expect(probe.settlement.isAnswered(KEY())).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
    expect(screen.getByText('home')).toBeTruthy();
  });

  it.each([
    ['link dropped', HANDOFF_LINK_DROPPED_KEPT_COPY],
    ['uncertain', HANDOFF_UNCERTAIN_KEPT_COPY],
  ])('a kept hand-off (%s): its copy with Close only; Close sends no second callback', async (_n, copy) => {
    const g = gate();
    const probe = mount(heartwoodRun(async () => { await g.wait; throw new HandoffKeptError(KEPT_SLOT, copy); }));
    pick();
    await approveLockFinishUnlock(probe, g.open);
    expect(await screen.findByText(copy)).toBeTruthy();
    expectNoApproveOrDeny();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
    expect(screen.getByText('home')).toBeTruthy();
  });

  it('a pairing the phone could not save: its error with Close only', async () => {
    const g = gate();
    const probe = mount(heartwoodRun(async () => MINTED, async () => { await g.wait; throw new Error('db'); }));
    pick();
    await approveLockFinishUnlock(probe, g.open);
    expect(await screen.findByText(new HandoffNotSavedError().message)).toBeTruthy();
    expectNoApproveOrDeny();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
  });

  it('a mint that failed before the device answered leaves the request open: Try again after the remount', async () => {
    const g = gate();
    const probe = mount(heartwoodRun(async () => { await g.wait; throw new Error('The device did not answer'); }));
    pick();
    await approveLockFinishUnlock(probe, g.open);
    expect(await screen.findByText('The device did not answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(probe.settlement.isAnswered(KEY())).toBe(false);
  });
});

describe('ApproveConnect remounted after a lock: phone branch (its own approval path)', () => {
  const pick = () => fireEvent.click(screen.getByLabelText('Through My Signet, automatically'));

  it('success: Connected, no Approve or Deny; Close sends no callback and leaves the live route alone', async () => {
    const g = gate();
    const probe = mount(phoneRun(async () => { await g.wait; return true; }));
    pick();
    await approveLockFinishUnlock(probe, g.open);
    expect(await screen.findByText('Connected!')).toBeTruthy();
    expectNoApproveOrDeny();
    expect(probe.settlement.isAnswered(KEY())).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
    expect(probe.routesCleared).toEqual([]);
    expect(screen.getByText('home')).toBeTruthy();
  });

  it('a failed publish gives the claim back: the error with Try again, and the request still open', async () => {
    const g = gate();
    const probe = mount(phoneRun(async () => { await g.wait; throw new Error('relay closed'); }));
    pick();
    await approveLockFinishUnlock(probe, g.open);
    expect(await screen.findByText(/Could not complete NostrConnect pairing\. Tried 1 relay: .*relay closed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(probe.settlement.isAnswered(KEY())).toBe(false);
  });

  it('Try again after the remount runs a fresh attempt and ends as Connected', async () => {
    const g = gate();
    const probe = mount(
      phoneRun(async () => { await g.wait; throw new Error('relay closed'); }),
      phoneRun(async () => true),
    );
    pick();
    await approveLockFinishUnlock(probe, g.open);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Connected!')).toBeTruthy();
    expectNoApproveOrDeny();
  });
});

describe.each([
  ['Heartwood', (g: ReturnType<typeof gate>) => heartwoodRun(async () => { await g.wait; return MINTED; }), () => fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/))],
  ['phone', (g: ReturnType<typeof gate>) => phoneRun(async () => { await g.wait; return true; }), () => fireEvent.click(screen.getByLabelText('Through My Signet, automatically'))],
])('while an approval is running (%s branch)', (_name, build, pick) => {
  it('a remount keeps showing Sending, never Approve, then follows the approval to the end', async () => {
    const g = gate();
    const probe = mount(build(g));
    pick();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Sending...');
    act(() => probe.lock());
    act(() => probe.unlock());
    expect(screen.getByText('Sending...')).toBeTruthy();
    expectNoApproveOrDeny();
    g.open();
    expect(await screen.findByText('Connected!')).toBeTruthy();
  });

  it('Back once the answer is on its way sends no second answer, and the approval ending later shows nothing', async () => {
    const g = gate();
    const probe = mount(build(g));
    pick();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Sending...');
    act(() => probe.done());
    expect(probe.denials).toEqual([]);
    g.open();
    await settleMicrotasks();
    expect(screen.getByText('home')).toBeTruthy();
    expect(screen.queryByText('Connected!')).toBeNull();
  });

  it('a request replaced mid-run never shows the old request\'s outcome', async () => {
    const g = gate();
    const probe = mount(build(g));
    pick();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Sending...');
    act(() => probe.replaceRequest());
    g.open();
    await settleMicrotasks();
    expect(probe.pendingName()).toBe('Other App');
    expect(screen.queryByText('Connected!')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });
});

describe('the same mount: error, Try again, Connected', () => {
  it('shows the error, then Sending, then Connected', async () => {
    const probe = mount(phoneRun(async () => { throw new Error('relay closed'); }), phoneRun(async () => true));
    fireEvent.click(screen.getByLabelText('Through My Signet, automatically'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Connected!')).toBeTruthy();
    expect(probe.approvedWith).toHaveLength(2);
  });
});

describe('the sign mode chosen survives a lock remount', () => {
  it('"Ask me each time" is still what Try again uses, and still the checked radio', async () => {
    const g = gate();
    const probe = mount(
      phoneRun(async () => { await g.wait; throw new Error('relay closed'); }),
      phoneRun(async () => true),
    );
    fireEvent.click(screen.getByLabelText('Through My Signet, ask me each time it signs'));
    await approveLockFinishUnlock(probe, g.open);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect((screen.getByLabelText('Through My Signet, ask me each time it signs') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(retry);
    await screen.findByText('Connected!');
    expect(probe.approvedWith).toEqual([
      { askToSign: true, viaHeartwood: false },
      { askToSign: true, viaHeartwood: false },
    ]);
  });

  it('a default mode (nothing clicked) is still the checked radio on an answered request', async () => {
    const g = gate();
    const probe = mount(phoneRun(async () => { await g.wait; return true; }));
    // Heartwood is the default here: the app asks for nothing the phone would ask about.
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
    await approveLockFinishUnlock(probe, g.open);
    await screen.findByText('Connected!');
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
  });

  it('is dropped with the request: the next request starts from the default again', async () => {
    const probe = mount(phoneRun(async () => true));
    fireEvent.click(screen.getByLabelText('Through My Signet, ask me each time it signs'));
    act(() => probe.replaceRequest());
    expect((screen.getByLabelText('Through My Signet, ask me each time it signs') as HTMLInputElement).checked).toBe(false);
  });
});

describe('an error from this mount wins over an older one App kept', () => {
  it('a refusal thrown before App records anything is the one shown', async () => {
    const outcome: ConnectOutcome = { key: 'k', status: 'error', error: 'older failure' };
    render(
      <ApproveConnect
        request={request}
        outcome={outcome}
        identity={identity}
        canSwitchGuardianPersona={true}
        availableGuardianPubkeys={[PERSONA]}
        requireNpConfirmation={true}
        onApprove={async () => { throw new Error('Refused in child mode'); }}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText('older failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Refused in child mode')).toBeTruthy();
    expect(screen.queryByText('older failure')).toBeNull();
  });
});

describe('a saved "Straight to my Heartwood" never pairs through the phone', () => {
  const failed: ConnectOutcome = { key: 'k', status: 'error', error: 'The device did not answer' };
  function page(over: Partial<React.ComponentProps<typeof ApproveConnect>>, onApprove: React.ComponentProps<typeof ApproveConnect>['onApprove'] = async () => {}) {
    return (
      <ApproveConnect
        request={request}
        outcome={failed}
        signChoice="heartwood"
        identity={identity}
        canSwitchGuardianPersona={true}
        availableGuardianPubkeys={[PERSONA]}
        requireNpConfirmation={true}
        onApprove={onApprove}
        onDeny={() => {}}
        {...over}
      />
    );
  }

  it('while the link is coming back: the choice stays checked but waiting, and Try again is held until it is up', async () => {
    const calls: Array<{ askToSign: boolean; viaHeartwood?: boolean }> = [];
    const onApprove = async (_s: unknown, o: { askToSign: boolean; viaHeartwood?: boolean }) => { calls.push(o); };
    const { rerender } = render(page({ heartwoodLinkPending: true, canHandOffToHeartwood: () => false }, onApprove));
    const straight = screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement;
    expect(straight.checked).toBe(true);
    expect(straight.disabled).toBe(true);
    expect(screen.getByTestId('connect-straight-waiting').textContent).toBe('Waiting for your Heartwood…');
    expect((screen.getByLabelText('Through My Signet, automatically') as HTMLInputElement).checked).toBe(false);
    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(calls).toEqual([]);

    rerender(page({ heartwoodLinkPending: false, canHandOffToHeartwood: () => true }, onApprove));
    const ready = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    await waitFor(() => expect(calls).toEqual([{ askToSign: false, viaHeartwood: true }]));
  });

  it('nothing is held when no Heartwood choice was saved', () => {
    render(page({ heartwoodLinkPending: true, canHandOffToHeartwood: () => false, signChoice: undefined, outcome: undefined }));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('without a pending link a saved Heartwood choice that is on offer works as before', () => {
    render(page({ canHandOffToHeartwood: () => true }));
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
