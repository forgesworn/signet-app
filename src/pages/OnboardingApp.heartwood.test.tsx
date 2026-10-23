// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { OnboardingApp } from './OnboardingApp';
import { HEARTWOOD_ONBOARDING_COPY } from '../lib/heartwood-onboarding';
import { FULL_ACCESS_COPY, type FullAccessDecision, type FullAccessOffer, type HeartwoodConnectUi } from '../lib/heartwood-one-hold';

const URI = 'bunker://' + 'a'.repeat(64) + '?relay=wss://relay.example.com&secret=x';

function openNameStep(onConnectHeartwood: (u: string, n: string) => Promise<void>) {
  render(<OnboardingApp onCreate={vi.fn()} onImport={vi.fn()} onImportLiteMnemonic={vi.fn()} onImportNsec={vi.fn()}
    onConnectHeartwood={onConnectHeartwood} onConnectNip07={vi.fn()} onStartChildPair={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'I already have a Signet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect a remote signer' }));
  fireEvent.change(screen.getByPlaceholderText('bunker://...'), { target: { value: URI } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByPlaceholderText(/not your real name/), { target: { value: 'Moss' } });
}

describe('OnboardingApp Heartwood connect', () => {
  it('shows the button hint while connecting, then the error and a Try again button', async () => {
    let reject!: (e: Error) => void;
    const onConnectHeartwood = vi.fn(() => new Promise<void>((_, rej) => { reject = rej; }));
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/press its button to approve/)).toBeTruthy();
    reject(new Error(HEARTWOOD_ONBOARDING_COPY['not-approved']));
    expect(await screen.findByText(HEARTWOOD_ONBOARDING_COPY['not-approved'])).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Try again' });
    onConnectHeartwood.mockImplementationOnce(() => Promise.resolve());
    fireEvent.click(retry);
    await waitFor(() => expect(onConnectHeartwood).toHaveBeenCalledTimes(2));
    expect(onConnectHeartwood).toHaveBeenLastCalledWith(URI, 'Moss', expect.objectContaining({ chooseFullAccess: expect.any(Function) }));
  });

  it('stops on the full-access choice when offered, sends nothing until the tap, and carries the decision back', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      reply: { naturalPerson: 'a'.repeat(64), persona: 'b'.repeat(64), actAs: ['persona'], style: 'everyday' },
    });
    let decision: FullAccessDecision | undefined;
    const onConnectHeartwood = vi.fn(async (_u: string, _n: string, ui?: HeartwoodConnectUi) => {
      const offer: FullAccessOffer = { words: ['nice', 'never', 'repair', 'area', 'upgrade'], run };
      decision = await ui!.chooseFullAccess(offer);
    });
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    await waitFor(() => expect(decision?.mode).toBe('bundle'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('everyday');
  });

  it('note 2: the decision carries the style the device answered with, not the one tapped', async () => {
    // The device answered careful although Everyday was tapped.
    const run = vi.fn().mockResolvedValue({
      ok: true,
      reply: { naturalPerson: 'a'.repeat(64), persona: 'b'.repeat(64), actAs: ['persona'], style: 'careful' },
    });
    let decision: FullAccessDecision | undefined;
    const onConnectHeartwood = vi.fn(async (_u: string, _n: string, ui?: HeartwoodConnectUi) => {
      decision = await ui!.chooseFullAccess({ words: ['nice', 'never', 'repair', 'area', 'upgrade'], run });
    });
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    await waitFor(() => expect(decision?.mode).toBe('bundle'));
    expect(run).toHaveBeenCalledWith('everyday');
    expect(decision).toMatchObject({ mode: 'bundle', style: 'careful', reply: { style: 'careful' } });
  });

  it('"Approve each thing separately" resolves to today\'s flow and shows the connecting screen again', async () => {
    let decision: FullAccessDecision | undefined;
    const onConnectHeartwood = vi.fn(async (_u: string, _n: string, ui?: HeartwoodConnectUi) => {
      decision = await ui!.chooseFullAccess({ words: ['a', 'b', 'c', 'd', 'e'], run: vi.fn() });
      await new Promise(() => {}); // stay "connecting"
    });
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: FULL_ACCESS_COPY.separately }));
    await waitFor(() => expect(decision).toEqual({ mode: 'separate' }));
    expect(await screen.findByText('Connecting to your signer...')).toBeTruthy();
  });

  it('a connect that never reaches the choice (older firmware) shows no choice screen', async () => {
    const onConnectHeartwood = vi.fn(() => new Promise<void>(() => {}));
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/press its button to approve/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeNull();
  });

  it('m9: leaving the choice screen by unmounting answers cancel, so the connect does not hang', async () => {
    let decision: FullAccessDecision | undefined;
    const onConnectHeartwood = vi.fn(async (_u: string, _n: string, ui?: HeartwoodConnectUi) => {
      decision = await ui!.chooseFullAccess({ words: ['a', 'b', 'c', 'd', 'e'], run: vi.fn() });
    });
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeTruthy();
    expect(decision).toBeUndefined();
    cleanup(); // unmount, as a flow reset or the Android back gesture would
    await waitFor(() => expect(decision).toEqual({ mode: 'cancel' }));
  });

  it('m9: Back on the choice screen still answers cancel', async () => {
    let decision: FullAccessDecision | undefined;
    const onConnectHeartwood = vi.fn(async (_u: string, _n: string, ui?: HeartwoodConnectUi) => {
      decision = await ui!.chooseFullAccess({ words: ['a', 'b', 'c', 'd', 'e'], run: vi.fn() });
    });
    openNameStep(onConnectHeartwood);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await waitFor(() => expect(decision).toEqual({ mode: 'cancel' }));
  });
});
