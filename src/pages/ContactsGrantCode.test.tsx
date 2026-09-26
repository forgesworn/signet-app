// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ContactsGrantCode } from './ContactsGrantCode';
import type { ContactsGrantCodeCheck } from './ContactsGrantCode';
import { pairingCode, formatPairingCode } from '@forgesworn/signet-contacts/wire';
import { CONTACTS_GRANT_DISCONNECT_FAILED_COPY } from '../lib/contacts-v2-copy';

const INPUT = {
  appPubkey: 'a'.repeat(64), challenge: 'D'.repeat(32),
  grantId: 'f'.repeat(32), railPubkey: 'b'.repeat(64),
};
const CODE = pairingCode(INPUT);

const CHECK: ContactsGrantCodeCheck = { grantId: INPUT.grantId, appName: 'Flock', input: INPUT, mismatches: 0 };

function setup(over: Partial<React.ComponentProps<typeof ContactsGrantCode>> = {}) {
  const onMismatch = vi.fn();
  const onRevoke = vi.fn(async () => {});
  const onDone = vi.fn();
  const { rerender } = render(
    <ContactsGrantCode check={CHECK} onMismatch={onMismatch} onRevoke={onRevoke} onDone={onDone} {...over} />,
  );
  return { onMismatch, onRevoke, onDone, rerender };
}

/** SDK B1/F1: My Signet must NEVER display its own code, in any form. */
function expectCodeNeverShown() {
  expect(screen.queryByText(CODE)).not.toBeInTheDocument();
  expect(screen.queryByText(formatPairingCode(CODE))).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(CODE);
  expect(document.body.textContent).not.toContain(formatPairingCode(CODE));
}

async function typeAndCheck(code: string) {
  const input = screen.getByLabelText(/6-digit code/i);
  await userEvent.clear(input);
  await userEvent.type(input, code);
  await userEvent.click(screen.getByRole('button', { name: 'Check' }));
}

describe('ContactsGrantCode', () => {
  it('names the app and never renders the code, on the entry screen', () => {
    setup();
    expect(screen.getAllByText(/Flock/).length).toBeGreaterThan(0);
    expectCodeNeverShown();
  });

  it('confirms a match and never rendered the code getting there', async () => {
    const { onDone } = setup();
    await typeAndCheck(CODE);
    expect(await screen.findByText(/codes match/i)).toBeInTheDocument();
    expect(screen.getByText(/Flock/)).toBeInTheDocument();
    expectCodeNeverShown();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('accepts a formatted (grouped) code the same as the bare digits', async () => {
    const { onDone } = setup();
    await typeAndCheck(formatPairingCode(CODE));
    expect(await screen.findByText(/codes match/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('lets a mistyped code try again once, without revoking', async () => {
    const { onRevoke, onMismatch } = setup();
    const wrong = CODE === '000000' ? '111111' : '000000';
    await typeAndCheck(wrong);
    expect(await screen.findByText(/doesn.t match/i)).toBeInTheDocument();
    expect(onRevoke).not.toHaveBeenCalled();
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expectCodeNeverShown();
    // Input is cleared for the retry.
    expect(screen.getByLabelText(/6-digit code/i)).toHaveValue('');
    await typeAndCheck(CODE);
    expect(await screen.findByText(/codes match/i)).toBeInTheDocument();
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it('disconnects after a second mismatch and says so, once', async () => {
    const { onRevoke, onDone, onMismatch } = setup();
    const wrong = CODE === '000000' ? '111111' : '000000';
    await typeAndCheck(wrong);
    await typeAndCheck(wrong);
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
    expect(onRevoke).toHaveBeenCalledWith(INPUT.grantId);
    expect(onMismatch).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/disconnected Flock/i)).toBeInTheDocument();
    expectCodeNeverShown();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('remounts with mismatches=1 (survived App state) and keeps exactly one more try before disconnecting', async () => {
    // Simulates finding 1: an auto-lock unmounted the page after one
    // mismatch; App persisted the count and now remounts with it.
    const { onRevoke, onMismatch } = setup({ check: { ...CHECK, mismatches: 1 } });
    expect(await screen.findByText(/doesn.t match/i)).toBeInTheDocument();
    expectCodeNeverShown();
    const wrong = CODE === '000000' ? '111111' : '000000';
    await typeAndCheck(wrong);
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
    expect(onRevoke).toHaveBeenCalledWith(INPUT.grantId);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/disconnected Flock/i)).toBeInTheDocument();
    expectCodeNeverShown();
  });

  it('mismatches=2 on mount goes straight to the disconnect step, retrying the revoke, never back to entry', async () => {
    // Simulates finding 1: the count reached 2 before an auto-lock unmounted
    // the page (e.g. the retry-on-remount case for a failed first revoke).
    const { onRevoke, onDone } = setup({ check: { ...CHECK, mismatches: 2 } });
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
    expect(onRevoke).toHaveBeenCalledWith(INPUT.grantId);
    expect(await screen.findByText(/disconnected Flock/i)).toBeInTheDocument();
    // No entry screen was ever a real option here — no code input at all
    // once the page settles.
    expect(screen.queryByLabelText(/6-digit code/i)).not.toBeInTheDocument();
    expectCodeNeverShown();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('"Try again" calls the current onRevoke after the prop changes, not the stale one from an earlier render', async () => {
    const staleRevoke = vi.fn(async () => { throw new Error(CONTACTS_GRANT_DISCONNECT_FAILED_COPY); });
    const onDone = vi.fn();
    const { rerender } = setup({ check: { ...CHECK, mismatches: 2 }, onRevoke: staleRevoke, onDone });
    expect(await screen.findByText(/could not disconnect/i)).toBeInTheDocument();
    expect(staleRevoke).toHaveBeenCalledTimes(1);

    const freshRevoke = vi.fn(async () => {});
    rerender(
      <ContactsGrantCode
        check={{ ...CHECK, mismatches: 2 }}
        onMismatch={vi.fn()}
        onRevoke={freshRevoke}
        onDone={onDone}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(freshRevoke).toHaveBeenCalledTimes(1));
    expect(staleRevoke).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/disconnected Flock/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('never claims "disconnected" when the revoke fails, and Try again retries it', async () => {
    const onRevoke = vi.fn()
      .mockRejectedValueOnce(new Error(CONTACTS_GRANT_DISCONNECT_FAILED_COPY))
      .mockResolvedValueOnce(undefined);
    const { onDone } = setup({ onRevoke });
    const wrong = CODE === '000000' ? '111111' : '000000';
    await typeAndCheck(wrong);
    await typeAndCheck(wrong);
    expect(await screen.findByText(/could not disconnect/i)).toBeInTheDocument();
    expect(screen.queryByText(/disconnected Flock/i)).not.toBeInTheDocument();
    expect(onRevoke).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/disconnected Flock/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('offers Keep it / Disconnect when the app isn\'t showing a code, and Keep it finishes without revoking', async () => {
    const { onRevoke, onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: /isn.t showing a code/i }));
    expect(screen.getByText(/older versions/i)).toBeInTheDocument();
    expectCodeNeverShown();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onRevoke).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Disconnect from the "isn\'t showing a code" screen revokes and finishes', async () => {
    const { onRevoke, onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: /isn.t showing a code/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith(INPUT.grantId));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('shows the error and offers Try again when that Disconnect fails', async () => {
    const onRevoke = vi.fn(async () => { throw new Error(CONTACTS_GRANT_DISCONNECT_FAILED_COPY); });
    const { onDone } = setup({ onRevoke });
    await userEvent.click(screen.getByRole('button', { name: /isn.t showing a code/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/could not disconnect/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
