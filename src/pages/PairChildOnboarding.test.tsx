// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../components/QRScanner', () => ({
  QRScanner: () => <div>scanner</div>,
}));

// The tap radios are a hook of their own (tested in useChildPairNearby.test.ts); the page is driven by its state.
const nearbyMock = vi.hoisted(() => {
  const handlers = { offer: vi.fn(() => () => {}), event: vi.fn(() => () => {}) };
  const tap = { onOffer: handlers.offer, onEvent: handlers.event, sendEvent: vi.fn(async () => true), end: vi.fn() };
  const make = (over: Record<string, unknown> = {}) => ({
    phase: 'idle', available: false, reason: undefined, secondPhone: false, wrongScreen: null,
    tap, probe: vi.fn(async () => ({})), begin: vi.fn(async () => true), end: vi.fn(), ...over,
  });
  return { make, tap, current: make() as ReturnType<typeof make> };
});
vi.mock('../hooks/useChildPairNearby', () => ({ useChildPairNearby: () => nearbyMock.current }));

import { PairChildOnboarding } from './PairChildOnboarding';
import { buildChildPairUri, type ChildPairOffer } from '../lib/child-pair-wire';
import { buildPairingURI } from '../lib/pairing-uri';
import { ChildDirectPairError } from '../lib/child-direct-pairing';
import { CHILD_SIDE_COPY } from '../lib/child-device-copy';

const DEP = 'ef'.repeat(32);

function offer(over: Partial<ChildPairOffer> = {}): ChildPairOffer {
  return {
    v: 2, rail: '12'.repeat(32), guardian: 'cd'.repeat(32), dependant: DEP, persona: 'ab'.repeat(32),
    name: 'Alice', relay: 'wss://rail.example', hwRelays: ['wss://hw.example'],
    code: '0123456789abcdef0123456789abcdef', t: Math.floor(Date.now() / 1000), ...over,
  };
}

beforeEach(() => { nearbyMock.current = nearbyMock.make(); });

function pasteAndContinue(text: string) {
  fireEvent.click(screen.getByText('Paste pairing code'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByText('Continue'));
}

describe('PairChildOnboarding — legacy bunker:// (unchanged)', () => {
  it('parses a bunker:// code and hands it to onConfirm verbatim', async () => {
    const uri = buildPairingURI({ endpointPubkey: '12'.repeat(32), relays: ['wss://relay.example'], secret: 's'.repeat(16),
      dependantPubkey: DEP, dependantName: 'Bob' });
    const onConfirm = vi.fn(async () => {});
    const onStartDirect = vi.fn(async () => {});
    render(<PairChildOnboarding onConfirm={onConfirm} onStartDirect={onStartDirect} onCancel={() => {}} />);
    pasteAndContinue(uri);
    expect(screen.getByText('Bob')).toBeTruthy();
    fireEvent.click(screen.getByText("That's me"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]).toEqual([expect.objectContaining({ dependantPubkey: DEP }), uri]);
    expect(onStartDirect).not.toHaveBeenCalled();
  });
});

describe('PairChildOnboarding — signet-child: direct pairing', () => {
  it('shows the child name and guardian, then shows the check words while it waits', async () => {
    let finish!: () => void;
    const onStartDirect = vi.fn((_o: unknown, ctl: { onCheckWords(w: string[]): void; signal: AbortSignal }) => {
      ctl.onCheckWords(['apple', 'banana', 'cherry', 'damson']);
      return new Promise<void>((r) => { finish = r; });
    });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={onStartDirect} onCancel={() => {}} />);
    pasteAndContinue(buildChildPairUri(offer()));
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText(CHILD_SIDE_COPY.confirmHeading)).toBeTruthy();
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.confirmGo));
    await waitFor(() => expect(screen.getByText(CHILD_SIDE_COPY.checkHeading)).toBeTruthy());
    for (const w of ['apple', 'banana', 'cherry', 'damson']) expect(screen.getByText(w)).toBeTruthy();
    expect(onStartDirect.mock.calls[0][0]).toMatchObject({ dependant: DEP, persona: 'ab'.repeat(32) });
    await act(async () => { finish(); });
  });

  it('a timeout shows the timeout copy and sends the child back to scan a new code (A28)', async () => {
    const onStartDirect = vi.fn(async () => { throw new ChildDirectPairError('timeout'); });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={onStartDirect} onCancel={() => {}} />);
    pasteAndContinue(buildChildPairUri(offer()));
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.confirmGo));
    await waitFor(() => expect(screen.getByText(CHILD_SIDE_COPY.errors.timeout)).toBeTruthy());
    expect(screen.queryByText('Try again')).toBeNull();
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.scanNew));
    await waitFor(() => expect(screen.queryByText(CHILD_SIDE_COPY.errors.timeout)).toBeNull());
    expect(onStartDirect).toHaveBeenCalledTimes(1);
  });

  it('a guardian refusal with client-reused shows its copy', async () => {
    const onStartDirect = vi.fn(async () => { throw new ChildDirectPairError('refused', 'client-reused'); });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={onStartDirect} onCancel={() => {}} />);
    pasteAndContinue(buildChildPairUri(offer()));
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.confirmGo));
    await waitFor(() => expect(screen.getByText(CHILD_SIDE_COPY.errors.refused['client-reused'])).toBeTruthy());
  });

  it('cancel aborts the running pairing', async () => {
    let seen: AbortSignal | null = null;
    const onStartDirect = vi.fn((_o: unknown, ctl: { signal: AbortSignal }) => {
      seen = ctl.signal;
      return new Promise<void>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new ChildDirectPairError('cancelled'))));
    });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={onStartDirect} onCancel={() => {}} />);
    pasteAndContinue(buildChildPairUri(offer()));
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.confirmGo));
    await waitFor(() => expect(onStartDirect).toHaveBeenCalled());
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.cancel));
    expect(seen!.aborted).toBe(true);
  });

  it('re-pair refuses a code for a different dependant', () => {
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} expectedDependantPubkey={'56'.repeat(32)} />);
    pasteAndContinue(buildChildPairUri(offer()));
    expect(screen.getByText(CHILD_SIDE_COPY.errors.wrongAccount)).toBeTruthy();
  });

  it('an expired code is refused', () => {
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} />);
    pasteAndContinue(buildChildPairUri(offer({ t: Math.floor(Date.now() / 1000) - 3600 })));
    expect(screen.getByText(CHILD_SIDE_COPY.errors.invalid)).toBeTruthy();
  });
});

describe('PairChildOnboarding — tap first', () => {
  it('leads with the tap, says why it asks for Nearby devices, and arms the radios', () => {
    nearbyMock.current = nearbyMock.make({ available: true });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText(CHILD_SIDE_COPY.tap.hold)).toBeTruthy();
    expect(screen.getByText(CHILD_SIDE_COPY.tap.permissionReason)).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_SIDE_COPY.tap.scanInstead })).toBeTruthy();
    expect(screen.queryByText('Scan pairing code')).toBeNull();
    expect(nearbyMock.current.begin).toHaveBeenCalledTimes(1);
  });

  it('shows a checking line, not the scan buttons, while the radios are being probed', () => {
    nearbyMock.current = nearbyMock.make({ available: null });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText(CHILD_SIDE_COPY.tap.checking)).toBeTruthy();
    expect(screen.queryByText('Paste pairing code')).toBeNull();
  });

  it('"Scan a code instead" stops NFC and turns the camera on; going back re-arms it', () => {
    nearbyMock.current = nearbyMock.make({ available: true, phase: 'waiting' });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: CHILD_SIDE_COPY.tap.scanInstead }));
    expect(nearbyMock.current.end).toHaveBeenCalled();
    expect(screen.getByText('scanner')).toBeTruthy();
    // The tap is idle again (as the hook reports after end()): Back must arm a fresh attempt.
    nearbyMock.current = nearbyMock.make({ available: true, phase: 'idle' });
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText(CHILD_SIDE_COPY.tap.hold)).toBeTruthy();
    expect(nearbyMock.current.begin).toHaveBeenCalledTimes(1);
  });

  it('a tapped phone starts the run over the link and shows no check words', async () => {
    nearbyMock.current = nearbyMock.make({ available: true, phase: 'linking' });
    let finish!: () => void;
    const onStartDirect = vi.fn((_s: unknown, ctl: { onCheckWords(w: string[]): void }) => {
      ctl.onCheckWords(['apple', 'banana', 'cherry', 'damson']); // never called in tap mode, but must not show if it were
      return new Promise<void>((r) => { finish = r; });
    });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={onStartDirect} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(CHILD_SIDE_COPY.tap.waitingConfirm)).toBeTruthy());
    expect(onStartDirect).toHaveBeenCalledTimes(1);
    expect(onStartDirect.mock.calls[0][0]).toEqual({ tap: expect.objectContaining({ onOffer: expect.any(Function), sendEvent: expect.any(Function), end: expect.any(Function) }) });
    expect(screen.queryByText('apple')).toBeNull();
    expect(screen.queryByText(CHILD_SIDE_COPY.checkHeading)).toBeNull();
    await act(async () => { finish(); });
  });

  it('cancelling a tap run ends the link and goes back to the welcome', async () => {
    nearbyMock.current = nearbyMock.make({ available: true, phase: 'linked' });
    const onStartDirect = vi.fn((_s: unknown, ctl: { signal: AbortSignal }) =>
      new Promise<void>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new ChildDirectPairError('cancelled')))));
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={onStartDirect} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(CHILD_SIDE_COPY.tap.waitingConfirm)).toBeTruthy());
    nearbyMock.current = nearbyMock.make({ available: true, phase: 'idle' });
    fireEvent.click(screen.getByText(CHILD_SIDE_COPY.cancel));
    expect(screen.getByText(CHILD_SIDE_COPY.tap.hold)).toBeTruthy();
    expect(onStartDirect).toHaveBeenCalledTimes(1);
  });

  it('the guardian being on the Handshake screen is explained', () => {
    nearbyMock.current = nearbyMock.make({ available: true, phase: 'waiting', wrongScreen: 'handshake' });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText(CHILD_SIDE_COPY.tap.wrongScreen)).toBeTruthy();
  });

  it('with the radios unavailable it goes straight to scan and paste, with one line why', () => {
    nearbyMock.current = nearbyMock.make({ available: false, reason: 'off', phase: 'unavailable' });
    render(<PairChildOnboarding onConfirm={vi.fn()} onStartDirect={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText(CHILD_SIDE_COPY.tap.unavailable.off)).toBeTruthy();
    expect(screen.getByText('Scan pairing code')).toBeTruthy();
    expect(screen.getByText('Paste pairing code')).toBeTruthy();
    expect(screen.queryByText(CHILD_SIDE_COPY.tap.hold)).toBeNull();
    expect(nearbyMock.current.begin).not.toHaveBeenCalled();
  });
});
