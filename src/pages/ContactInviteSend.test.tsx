// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContactInviteSend } from './ContactInviteSend';
const A = 'a'.repeat(64), B = 'b'.repeat(64), R = 'c'.repeat(64);
const invite = { v: 1 as const, recipient: R, secret: 'd'.repeat(64), relays: ['wss://relay.example/'] };
const personas = [{ pubkey: A, label: 'Alice' }, { pubkey: B, label: 'Work' }];
const props = { invite, personas, defaultPersona: B, ownPubkeys: [A, B], onSend: vi.fn(async () => {}), onDone() {}, onCancel() {} };
describe('ContactInviteSend', () => {
  it('defaults to the given persona and sends from it, then confirms', async () => {
    const onSend = vi.fn(async () => {});
    render(<ContactInviteSend {...props} onSend={onSend} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(B);
    expect(screen.getByText(/^npub1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByText(/Request sent\. You.ll both be added once they accept\./);
    expect(onSend).toHaveBeenCalledWith(B);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
  it('shows the public caption and no select for a single persona', () => {
    render(<ContactInviteSend {...props} invite={{ ...invite, caption: 'Bob at the fair' }} personas={[personas[0]]} defaultPersona={A} />);
    expect(screen.getByText('Bob at the fair')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Alice')).toBeTruthy();
  });
  it('refuses your own invite', () => {
    render(<ContactInviteSend {...props} invite={{ ...invite, recipient: A }} />);
    expect(screen.getByText('This is your own invite.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send request' })).toBeNull();
  });
  it('guards double taps and shows errors inline', async () => {
    let fail!: (e: Error) => void;
    const onSend = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    render(<ContactInviteSend {...props} onSend={onSend} />);
    const button = screen.getByRole('button', { name: 'Send request' });
    fireEvent.click(button); fireEvent.click(button);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy();
    fail(new Error('Relay refused'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Relay refused'));
    expect(screen.getByRole('button', { name: 'Send request' })).toBeTruthy();
  });
});
