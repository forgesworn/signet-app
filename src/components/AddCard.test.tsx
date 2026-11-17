// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AddCard } from './AddCard';
import { HEARTWOOD_HOLD_TO_FINISH } from '../lib/local-key-only-copy';

afterEach(() => cleanup());

async function startSaving(heartwoodHold: boolean) {
  let finish!: () => void;
  render(<AddCard context="guardian" heartwoodHold={heartwoodHold}
    onAddPersona={() => new Promise<void>(r => { finish = r; })} onAddDependant={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /add persona/i }));
  fireEvent.change(screen.getByPlaceholderText('e.g. CryptoAlice'), { target: { value: 'Gamer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create persona' }));
  return () => act(async () => { finish(); });
}

describe('AddCard — Heartwood hold hint', () => {
  it('says to press and hold while the Heartwood derives the persona', async () => {
    const done = await startSaving(true);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeInTheDocument();
    expect(screen.getByText(HEARTWOOD_HOLD_TO_FINISH)).toBeInTheDocument();
    await done();
  });

  it('is not shown when the keys are local', async () => {
    const done = await startSaving(false);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeInTheDocument();
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
    await done();
  });
});

it('the hint copy', () => {
  expect(HEARTWOOD_HOLD_TO_FINISH).toBe('Press and hold the button on your Heartwood to finish.');
});
