// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContactInvites } from './ContactInvites';
import { NEEDS_GUARDIAN_ERROR } from '../lib/contact-invite-service';

vi.mock('../lib/contact-invite-link', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/contact-invite-link')>(),
  parseContactInviteLink: () => ({ recipient: 'b'.repeat(64) }),
}));

const ME = 'a'.repeat(64);
const emptyVault = { invites: [], exchanges: [], outbox: [], arrivals: [] };

function setup(error: string, guardianApproves?: boolean) {
  const service = { read: vi.fn(async () => emptyVault), flush: vi.fn(async () => {}),
    request: vi.fn(async () => { throw new Error(error); }) };
  render(<ContactInvites service={service as never} identityPubkey={ME} identityName="Pip" relays={[]} version={0}
    guardianApproves={guardianApproves} onAddContact={async () => {}} onBack={() => {}} />);
  fireEvent.change(screen.getByLabelText('Invite link'), { target: { value: 'signet-contact:whatever' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send contact request' }));
}

describe('sending a contact request that the policy refuses', () => {
  it('a guardian not in child mode sees the policy text on send, not the accept-side copy, when only guardian approval is missing', async () => {
    setup(NEEDS_GUARDIAN_ERROR);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This contact is not allowed by the contact policy'));
  });
  it('the child-mode page reads the same refusal as waiting for the guardian', async () => {
    setup(NEEDS_GUARDIAN_ERROR, true);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Waiting for your guardian to approve this contact.'));
  });
  it('a blocked peer keeps its own message', async () => {
    setup('This contact is not allowed by the contact policy');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This contact is not allowed by the contact policy'));
  });
});
