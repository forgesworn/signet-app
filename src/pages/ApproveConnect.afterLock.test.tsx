// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ApproveConnect } from './ApproveConnect';
import type { SignetIdentity } from '../types';
import type { NostrConnectRequest } from '../lib/nip46';
import { AuthRequestSettlement, requestObjectKey } from '../lib/auth-request-settlement';
import { trackApproval, type ConnectOutcome } from '../lib/connect-outcome';
import {
  HANDOFF_LINK_DROPPED_KEPT_COPY,
  HANDOFF_UNCERTAIN_KEPT_COPY,
  HandoffKeptError,
  HandoffNotSavedError,
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

type Run = (settlement: AuthRequestSettlement, key: string) => Promise<void>;

/**
 * Stands in for App: it owns the settlement, the request and the outcome, and
 * mounts the page only while unlocked. `lock()` drops the page (remounting it
 * on `unlock()`) while an approval that already started keeps running.
 */
function Harness({ run, probe }: { run: Run; probe: { lock: () => void; unlock: () => void; denials: string[]; closed: () => boolean; settlement: AuthRequestSettlement } }) {
  const settlementRef = useRef(new AuthRequestSettlement());
  const [pending, setPending] = useState<NostrConnectRequest | null>(request);
  const pendingRef = useRef<NostrConnectRequest | null>(request);
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  const [locked, setLocked] = useState(false);
  probe.lock = () => setLocked(true);
  probe.unlock = () => setLocked(false);
  probe.closed = () => pending === null;
  probe.settlement = settlementRef.current;

  async function approve() {
    const req = pendingRef.current!;
    const key = requestObjectKey(req);
    const began = settlementRef.current.beginApproval(key);
    if (began === 'in-flight') throw new Error('Already connecting this request.');
    if (began === 'settled') return;
    try {
      await trackApproval({
        key,
        settlement: settlementRef.current,
        isCurrent: () => pendingRef.current === req,
        record: setOutcome,
        run: () => run(settlementRef.current, key),
      });
    } finally {
      settlementRef.current.endApproval(key);
    }
  }

  // The same rule as App's handleConnectDone.
  function done() {
    const req = pendingRef.current!;
    const outcomeOfDeny = settlementRef.current.deny(requestObjectKey(req));
    if (outcomeOfDeny !== 'already-answered') probe.denials.push('denied');
    pendingRef.current = null;
    setPending(null);
    setOutcome(null);
  }

  if (!pending) return <p>home</p>;
  if (locked) return <p>locked</p>;
  const key = requestObjectKey(pending);
  return (
    <ApproveConnect
      key={key}
      request={pending}
      outcome={outcome?.key === key ? outcome : undefined}
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

function mount(run: Run) {
  const probe = { lock: () => {}, unlock: () => {}, denials: [] as string[], closed: () => false, settlement: new AuthRequestSettlement() };
  render(<Harness run={run} probe={probe} />);
  return probe;
}

/** Press Approve, lock while the approval is running, let it end, unlock. */
async function approveLockFinishUnlock(probe: ReturnType<typeof mount>, finish: () => void) {
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('Sending...');
  act(() => probe.lock());
  expect(screen.getByText('locked')).toBeTruthy();
  finish();
  await act(async () => { await Promise.resolve(); });
  act(() => probe.unlock());
}

function expectNoApproveOrDeny() {
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
}

/** A run the test ends by hand; `claim` mirrors the delivery claim a real approval makes. */
function gated(claim: boolean, end: (e: { resolve: () => void; reject: (e: unknown) => void }) => void): { run: Run; finish: () => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const ended = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return {
    run: async (settlement, key) => {
      if (claim) settlement.claimDelivery(key);
      await ended;
    },
    finish: () => end({ resolve, reject }),
  };
}

describe.each([
  ['Heartwood branch (straight to my Heartwood)', true],
  ['phone branch (through My Signet)', false],
])('ApproveConnect remounted after a lock: %s', (_name, viaHeartwood) => {
  function pickBranch() {
    const straight = screen.queryByLabelText(/Straight to my Heartwood/) as HTMLInputElement | null;
    if (viaHeartwood) fireEvent.click(straight!);
    else fireEvent.click(screen.getByLabelText('Through My Signet, automatically'));
  }

  it('shows Connected after a success, with no Approve or Deny, and Close sends no callback', async () => {
    const g = gated(true, e => e.resolve());
    const probe = mount(g.run);
    pickBranch();
    await approveLockFinishUnlock(probe, g.finish);
    expect(await screen.findByText('Connected!')).toBeTruthy();
    expectNoApproveOrDeny();
    expect(probe.settlement.isAnswered(requestObjectKey(request))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
    expect(screen.getByText('home')).toBeTruthy();
  });

  it('shows a kept hand-off\'s copy with Close only, and Close sends no second callback', async () => {
    const copy = viaHeartwood ? HANDOFF_LINK_DROPPED_KEPT_COPY : HANDOFF_UNCERTAIN_KEPT_COPY;
    const g = gated(true, e => e.reject(new HandoffKeptError(KEPT_SLOT, copy)));
    const probe = mount(g.run);
    pickBranch();
    await approveLockFinishUnlock(probe, g.finish);
    expect(await screen.findByText(copy)).toBeTruthy();
    expectNoApproveOrDeny();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
    expect(screen.getByText('home')).toBeTruthy();
  });

  it('shows an answered request\'s error with Close only, and Close sends no second callback', async () => {
    // An error that ends the request, and one that is not a known "ends it"
    // type but arrives after the delivery was claimed: the settlement says it is answered.
    const g = gated(true, e => e.reject(viaHeartwood ? new HandoffNotSavedError() : new Error('Cancelled while sending')));
    const probe = mount(g.run);
    pickBranch();
    await approveLockFinishUnlock(probe, g.finish);
    const copy = viaHeartwood ? new HandoffNotSavedError().message : 'Cancelled while sending';
    expect(await screen.findByText(copy)).toBeTruthy();
    expectNoApproveOrDeny();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(probe.denials).toEqual([]);
  });

  it('keeps showing Sending (never Approve) when the page returns while the approval still runs, then follows it to the end', async () => {
    const g = gated(true, e => e.resolve());
    const probe = mount(g.run);
    pickBranch();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Sending...');
    act(() => probe.lock());
    act(() => probe.unlock());
    expect(screen.getByText('Sending...')).toBeTruthy();
    expectNoApproveOrDeny();
    g.finish();
    expect(await screen.findByText('Connected!')).toBeTruthy();
  });

  it('a failure that left the request unanswered is still retryable after the remount', async () => {
    const g = gated(false, e => e.reject(new Error('Could not complete NostrConnect pairing.')));
    const probe = mount(g.run);
    pickBranch();
    await approveLockFinishUnlock(probe, g.finish);
    expect(await screen.findByText('Could not complete NostrConnect pairing.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(probe.settlement.isAnswered(requestObjectKey(request))).toBe(false);
  });
});
