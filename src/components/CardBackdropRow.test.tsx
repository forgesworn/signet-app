// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const hook = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../hooks/useCardBackdrop', async (orig) => ({
  ...await orig<typeof import('../hooks/useCardBackdrop')>(),
  useCardBackdrop: () => hook.state,
}));

import { CardBackdropRow } from './CardBackdropRow';
import { BACKDROP_PRIVACY_COPY } from '../hooks/useCardBackdrop';

const set = vi.fn();
const clear = vi.fn();
const base = () => ({ url: 'blob:x', source: 'own', link: null, set, clear });
const pick = () => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });
};

beforeEach(() => { set.mockReset(); clear.mockReset(); hook.state = base(); });
afterEach(cleanup);

describe('CardBackdropRow copy', () => {
  it('own persona: the device-local line, unchanged', () => {
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.getByText(BACKDROP_PRIVACY_COPY)).toBeTruthy();
  });

  it('guardian\'s dependant card: the sent-to-their-phone line, not the device-local one', () => {
    hook.state = { ...base(), link: { name: 'Lily', sent: true, send: vi.fn(), remove: vi.fn() } };
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.getByText("Sent to Lily's phone, encrypted on the way. Not encrypted on either phone, and it shows while the app is locked.")).toBeTruthy();
    expect(screen.queryByText(BACKDROP_PRIVACY_COPY)).toBeNull();
  });

  it('child\'s phone, guardian\'s picture showing: "Set by your guardian", Change, and no Remove', () => {
    hook.state = { ...base(), source: 'guardian' };
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.getByText('Set by your guardian')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('no Remove while the dependant record is locked, so a sent pointer cannot be left behind', () => {
    hook.state = { ...base(), link: { name: 'Lily', sent: true, send: vi.fn(), remove: vi.fn() }, removeBlocked: true };
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('child\'s phone, own pick showing: the device-local line and a Remove', () => {
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByText('Set by your guardian')).toBeNull();
  });
});

describe('CardBackdropRow send state (guardian\'s dependant card)', () => {
  const link = (sent: boolean) => ({ name: 'Lily', sent, send: vi.fn(), remove: vi.fn() });
  const retrySend = vi.fn();
  beforeEach(() => { retrySend.mockReset(); });

  it('a failed send says "Not sent to Lily\'s phone" with the reason, and the picture stays', async () => {
    hook.state = { ...base(), link: link(false), unsent: true, retrySend };
    set.mockResolvedValue({ ok: true, send: { ok: false, reason: 'Turn on Blossom uploads in Advanced settings, then choose it again.' } });
    render(<CardBackdropRow pubkey="a" />);
    pick();
    await waitFor(() => expect(screen.getByText(/Not sent to Lily's phone\. Turn on Blossom uploads/)).toBeTruthy());
  });

  it('a failed replace says the earlier one is still on their phone', async () => {
    hook.state = { ...base(), link: link(true), unsent: true, retrySend };
    set.mockResolvedValue({ ok: true, send: { ok: false, reason: 'Check your connection and choose it again.' } });
    render(<CardBackdropRow pubkey="a" />);
    pick();
    await waitFor(() => expect(screen.getByText(/Lily's phone still shows the earlier one/)).toBeTruthy());
  });

  it('a picture that is not the one last sent says so on every mount, with a Send button', () => {
    hook.state = { ...base(), link: link(false), unsent: true, retrySend };
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.getByText("Not sent to Lily's phone yet.")).toBeTruthy();
    expect(screen.getByRole('button', { name: "Send to Lily's phone" })).toBeTruthy();
  });

  it('Send retries, and a failure keeps the line up with its reason', async () => {
    hook.state = { ...base(), link: link(false), unsent: true, retrySend };
    retrySend.mockResolvedValue({ ok: false, reason: 'Check your connection and choose it again.' });
    render(<CardBackdropRow pubkey="a" />);
    fireEvent.click(screen.getByRole('button', { name: "Send to Lily's phone" }));
    await waitFor(() => expect(screen.getByText(/Not sent to Lily's phone\. Check your connection/)).toBeTruthy());
    expect(retrySend).toHaveBeenCalledTimes(1);
  });

  it('a sent picture shows no warning and no Send button, even if an earlier attempt failed', async () => {
    hook.state = { ...base(), link: link(true), unsent: false, retrySend };
    render(<CardBackdropRow pubkey="a" />);
    expect(screen.queryByText(/Not sent to/)).toBeNull();
    expect(screen.queryByRole('button', { name: "Send to Lily's phone" })).toBeNull();
  });
});
