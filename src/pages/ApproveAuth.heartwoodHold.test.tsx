// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import { HEARTWOOD_HOLD_TO_FINISH } from '../lib/local-key-only-copy';

const request: AuthRequest = {
  type: 'signet-auth-request', relays: [], requestId: 'f'.repeat(32), challenge: 'c'.repeat(64),
  origin: 'https://example.com', timestamp: Date.now(),
};
// No persona yet: the empty state offers "Add persona now".
const identity = {
  id: 'a'.repeat(64), mnemonic: '', primaryKeypair: 'persona', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: '', privateKey: '', displayName: '' },
} as SignetIdentity;

afterEach(() => cleanup());

async function addPersona(addPersonaHeartwoodHold: boolean) {
  let finish!: () => void;
  render(
    <ApproveAuth request={request} hasCredentialForSelection={() => false} identity={identity} canSwitchGuardianPersona
      consumerHint={{ allow: ['persona'] }} requireNpConfirmation onApprove={vi.fn()} onDeny={vi.fn()}
      onAddPersona={() => new Promise<void>(r => { finish = r; })} addPersonaHeartwoodHold={addPersonaHeartwoodHold} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add persona now' }));
  fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'Gamer' } });
  expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }));
  return () => act(async () => { finish(); });
}

describe('ApproveAuth (sign-in picker) — Heartwood hold hint on Add persona now', () => {
  it('shows while the Heartwood derives the persona (Save disabled), and goes when it is done', async () => {
    const done = await addPersona(true);
    expect(screen.getByText(HEARTWOOD_HOLD_TO_FINISH)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled();
    await done();
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
  });

  it('is not shown when the keys are local', async () => {
    const done = await addPersona(false);
    expect(screen.queryByText(HEARTWOOD_HOLD_TO_FINISH)).toBeNull();
    await done();
  });
});
