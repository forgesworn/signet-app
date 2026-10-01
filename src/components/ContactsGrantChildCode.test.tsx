// @vitest-environment jsdom
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPairingUriV2 } from '@forgesworn/signet-contacts/wire';
import { ContactsGrantChildCode } from './ContactsGrantChildCode';
import { parseContactsPairingRequestV2 } from '../lib/companion-pair-v2';
import { routeQR } from '../lib/qr-router';
import {
  CONTACTS_GRANT_CHILD_CODE_EXPIRED_COPY, CONTACTS_GRANT_CHILD_CODE_PAIRING_CODE_COPY,
  contactsGrantChildCodeExpiryCopy,
} from '../lib/contacts-v2-copy';

vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <output data-testid="qr">{data}</output> }));

const T0_MS = 1_800_000_000_000;
const NOW_SEC = T0_MS / 1000;

function request(appName = 'Flock') {
  const r = parseContactsPairingRequestV2(buildPairingUriV2({
    appPubkey: 'a'.repeat(64), appName, capabilities: ['signet.contacts.read:directory'],
    directory: 'owner', relay: 'wss://relay.example.com', nowSec: NOW_SEC, challenge: 'D'.repeat(32),
  }), { nowSec: NOW_SEC }).request;
  if (!r) throw new Error('fixture request did not parse');
  return r;
}

describe('ContactsGrantChildCode', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0_MS); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows a QR the guardian scanner routes back as a dependant request', () => {
    const req = request();
    render(<ContactsGrantChildCode request={req} onDismiss={() => {}} />);
    const action = routeQR(screen.getByTestId('qr').textContent!);
    expect(action.type === 'contacts-pair-v2' && action.request).toEqual({ ...req, directory: 'dependant' });
    expect(screen.getByText(CONTACTS_GRANT_CHILD_CODE_PAIRING_CODE_COPY)).toBeTruthy();
    expect(screen.getByText('Flock wants to connect to contacts.')).toBeTruthy();
  });

  it('counts down, then hides the QR and says the code has expired', () => {
    render(<ContactsGrantChildCode request={request()} onDismiss={() => {}} />);
    expect(screen.getByText(contactsGrantChildCodeExpiryCopy(300))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(250_000); });
    expect(screen.getByText('This code works for less than a minute.')).toBeTruthy();
    expect(screen.getByTestId('qr')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByText(CONTACTS_GRANT_CHILD_CODE_EXPIRED_COPY)).toBeTruthy();
  });

  it('Dismiss calls back', () => {
    const onDismiss = vi.fn();
    render(<ContactsGrantChildCode request={request()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a new request replaces the old one and restarts the clock', () => {
    const { rerender } = render(<ContactsGrantChildCode request={request('Flock')} onDismiss={() => {}} />);
    act(() => { vi.advanceTimersByTime(299_000); });
    const next = parseContactsPairingRequestV2(buildPairingUriV2({
      appPubkey: 'b'.repeat(64), appName: 'Nest', capabilities: ['signet.contacts.read:directory'],
      directory: 'owner', relay: 'wss://relay.example.com', nowSec: Math.floor(Date.now() / 1000), challenge: 'E'.repeat(32),
    })).request!;
    rerender(<ContactsGrantChildCode request={next} onDismiss={() => {}} />);
    expect(screen.getByText('Nest wants to connect to contacts.')).toBeTruthy();
    expect(screen.getByText(contactsGrantChildCodeExpiryCopy(300))).toBeTruthy();
  });
});

describe('contactsGrantChildCodeExpiryCopy', () => {
  it('words minutes and the last minute', () => {
    expect(contactsGrantChildCodeExpiryCopy(300)).toBe('This code works for about 5 more minutes.');
    expect(contactsGrantChildCodeExpiryCopy(61)).toBe('This code works for about 2 more minutes.');
    expect(contactsGrantChildCodeExpiryCopy(60)).toBe('This code works for about 1 more minute.');
    expect(contactsGrantChildCodeExpiryCopy(59)).toBe('This code works for less than a minute.');
  });
});
