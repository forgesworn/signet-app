// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingApp } from './OnboardingApp';
import { HEARTWOOD_ONBOARDING_COPY } from '../lib/heartwood-onboarding';

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
    expect(onConnectHeartwood).toHaveBeenLastCalledWith(URI, 'Moss');
  });
});
