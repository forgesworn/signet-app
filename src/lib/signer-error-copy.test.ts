import { describe, it, expect } from 'vitest';
import { friendlySignerMessage, friendlyApprovalError, SIGNER_TIMEOUT_COPY, SIGNER_DENIED_COPY, SIGNER_BUSY_COPY, SIGNER_REAL_NAME_NEEDS_DEVICE_COPY } from './signer-error-copy';
import { BunkerRequestTimeoutError } from './signing-backend';

describe('friendlySignerMessage', () => {
  it('maps the bare device timeout and our own request timeout', () => {
    expect(friendlySignerMessage('timeout')).toBe(SIGNER_TIMEOUT_COPY);
    expect(friendlySignerMessage(' Timeout ')).toBe(SIGNER_TIMEOUT_COPY);
    expect(friendlyApprovalError(new BunkerRequestTimeoutError('sign_event'))).toBe(SIGNER_TIMEOUT_COPY);
  });
  it('maps other raw signer refusals', () => {
    expect(friendlySignerMessage('user denied')).toBe(SIGNER_DENIED_COPY);
    expect(friendlySignerMessage('signer is busy with another approval')).toBe(SIGNER_BUSY_COPY);
  });
  it('leaves sentences written for the user alone', () => {
    const own = 'Unlock Signet to sign as this persona — your signer reconnects after unlock.';
    expect(friendlySignerMessage(own)).toBe(own);
    expect(friendlyApprovalError(new Error(own))).toBe(own);
  });
  it('keeps the non-Error fallbacks', () => {
    expect(friendlyApprovalError(null)).toBe('Failed to approve — please try again');
    expect(friendlyApprovalError('boom')).toBe('Failed to approve: boom');
  });
});

describe('A2: real-name first use needs the Heartwood', () => {
  const opts = { realNameNeedsHeartwood: true };
  it('says "This needs your Heartwood" when the card times out or the device is unreachable', () => {
    expect(SIGNER_REAL_NAME_NEEDS_DEVICE_COPY).toBe("This needs your Heartwood. Try again when you're with it.");
    expect(friendlySignerMessage('timeout', opts)).toBe(SIGNER_REAL_NAME_NEEDS_DEVICE_COPY);
    expect(friendlyApprovalError(new BunkerRequestTimeoutError('sign_event'), opts)).toBe(SIGNER_REAL_NAME_NEEDS_DEVICE_COPY);
    expect(friendlyApprovalError(new Error('Not connected to bunker'), opts)).toBe(SIGNER_REAL_NAME_NEEDS_DEVICE_COPY);
    expect(friendlyApprovalError('timeout', opts)).toBe(SIGNER_REAL_NAME_NEEDS_DEVICE_COPY);
  });
  it('without the flag nothing changes (older firmware, personas)', () => {
    expect(friendlySignerMessage('timeout')).toBe(SIGNER_TIMEOUT_COPY);
    expect(friendlySignerMessage('timeout', { realNameNeedsHeartwood: false })).toBe(SIGNER_TIMEOUT_COPY);
    expect(friendlyApprovalError(new Error('Not connected to bunker'))).toBe('Not connected to bunker');
  });
  it('other refusals keep their wording even with the flag', () => {
    expect(friendlySignerMessage('user denied', opts)).toBe(SIGNER_DENIED_COPY);
    expect(friendlyApprovalError('boom', opts)).toBe('Failed to approve: boom');
  });
});
