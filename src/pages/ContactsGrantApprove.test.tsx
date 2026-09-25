// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ContactsGrantApprove } from './ContactsGrantApprove';
import { CONTACTS_GRANT_CAPABILITY_COPY } from '../lib/contacts-v2-copy';
import type { PairingRequestV2 } from '@forgesworn/signet-contacts/wire';

const REQUEST: PairingRequestV2 = {
  v: 2, appPubkey: 'a'.repeat(64), appName: 'Flock',
  capabilities: ['signet.contacts.read:directory', 'signet.contacts.blocks.read', 'signet.contacts.propose:add-ken'],
  directory: 'owner', rendezvousRelay: 'wss://relay.example.com',
  t: 1_700_000_000, challenge: 'D'.repeat(32),
};

const DIRECTORIES = [
  { directoryId: 'owner', label: 'You' },
  { directoryId: `dependant:${'b'.repeat(64)}`, label: 'Robin' },
];

function setup(over: Partial<React.ComponentProps<typeof ContactsGrantApprove>> = {}) {
  const onApprove = vi.fn(async () => {});
  const onDeny = vi.fn();
  render(
    <ContactsGrantApprove
      request={REQUEST} directories={DIRECTORIES}
      onApprove={onApprove} onDeny={onDeny} {...over}
    />,
  );
  return { onApprove, onDeny };
}

describe('ContactsGrantApprove', () => {
  it('names the app and lists every requested capability in plain English', () => {
    setup();
    expect(screen.getByText(/Flock/)).toBeInTheDocument();
    for (const cap of REQUEST.capabilities) {
      expect(screen.getByText(CONTACTS_GRANT_CAPABILITY_COPY[cap])).toBeInTheDocument();
    }
    expect(screen.queryByText(/signet\.contacts\./)).not.toBeInTheDocument();
  });

  it('pre-ticks read:directory ONLY, leaving everything else opt-in (R-12)', async () => {
    const { onApprove } = setup();
    expect(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:directory'] })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.blocks.read'] })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.propose:add-ken'] })).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith({
      directoryId: 'owner',
      capabilities: ['signet.contacts.read:directory'],
      maxStalenessSeconds: 21600,
    }));
  });

  it('lets the owner widen the grant up to what was asked for, in request order', async () => {
    const { onApprove } = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.propose:add-ken'] }));
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: ['signet.contacts.read:directory', 'signet.contacts.propose:add-ken'],
    })));
  });

  it('keeps both ticks when two boxes are clicked in quick succession', async () => {
    const { onApprove } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.blocks.read'] }));
    await user.click(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.propose:add-ken'] }));
    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: REQUEST.capabilities,
    })));
  });

  it('disables Approve when every capability is unticked', async () => {
    setup();
    await userEvent.click(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:directory'] }));
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled();
  });

  it('lets the owner choose a dependant directory', async () => {
    const { onApprove } = setup();
    await userEvent.click(screen.getByRole('radio', { name: 'Robin' }));
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
      directoryId: `dependant:${'b'.repeat(64)}`,
    })));
  });

  it('defaults the directory to a dependant when the app asked for one', async () => {
    const { onApprove } = setup({ request: { ...REQUEST, directory: 'dependant' } });
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
      directoryId: `dependant:${'b'.repeat(64)}`,
    })));
  });

  it('offers the four staleness windows, defaulting to 6 hours', async () => {
    const { onApprove } = setup();
    await userEvent.selectOptions(screen.getByLabelText(/How fresh/i), '86400');
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ maxStalenessSeconds: 86400 })));
  });

  it('states the revocation boundary honestly, including the staleness window (S5)', () => {
    setup();
    expect(screen.getByText(/already downloaded/i)).toBeInTheDocument();
    expect(screen.getByText(/seven days/i)).toBeInTheDocument();
  });

  it('warns that blocks.read hands over those people’s keys (S9)', async () => {
    setup();
    expect(CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.blocks.read']).toMatch(/key/i);
  });

  it('surfaces an approval failure and re-enables the button', async () => {
    const onApprove = vi.fn(async () => { throw new Error('relay unreachable'); });
    render(<ContactsGrantApprove request={REQUEST} directories={DIRECTORIES} onApprove={onApprove} onDeny={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(await screen.findByText(/relay unreachable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled();
  });

  it('calls onDeny from Deny', async () => {
    const { onDeny } = setup();
    await userEvent.click(screen.getByRole('button', { name: /^Deny/ }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('moves the default onto a dependant when the roster arrives late (B/I2)', async () => {
    // On a mount-carrier entry the first render can happen before
    // `useDependants` has resolved, so an app that asked for a child's
    // contacts settled on the OWNER's directory — the larger disclosure —
    // and stayed there silently when the list grew a moment later.
    const onApprove = vi.fn(async () => {});
    const { rerender } = render(
      <ContactsGrantApprove
        request={{ ...REQUEST, directory: 'dependant' }}
        directories={[{ directoryId: 'owner', label: 'You' }]}
        onApprove={onApprove} onDeny={vi.fn()}
      />,
    );
    rerender(
      <ContactsGrantApprove
        request={{ ...REQUEST, directory: 'dependant' }}
        directories={DIRECTORIES}
        onApprove={onApprove} onDeny={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
      directoryId: `dependant:${'b'.repeat(64)}`,
    })));
  });

  it('leaves a directory the user has chosen alone when the list changes', async () => {
    const onApprove = vi.fn(async () => {});
    const { rerender } = render(
      <ContactsGrantApprove
        request={{ ...REQUEST, directory: 'dependant' }}
        directories={DIRECTORIES}
        onApprove={onApprove} onDeny={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'You' }));
    rerender(
      <ContactsGrantApprove
        request={{ ...REQUEST, directory: 'dependant' }}
        directories={[...DIRECTORIES, { directoryId: `dependant:${'c'.repeat(64)}`, label: 'Sam' }]}
        onApprove={onApprove} onDeny={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ directoryId: 'owner' })));
  });

  it('explains when there is no dependant to grant against', () => {
    setup({ directories: [{ directoryId: 'owner', label: 'You' }], request: { ...REQUEST, directory: 'dependant' } });
    expect(screen.getByText(/no dependants/i)).toBeInTheDocument();
  });
});


it('requires separate consent for method kinds, tiers and checks', async () => {
  const { onApprove } = setup({ request: { ...REQUEST, capabilities: [
    'signet.contacts.read:directory', 'signet.contacts.read:method:phone',
    'signet.contacts.read:method:email', 'signet.contacts.read:tier', 'signet.contacts.read:checks',
  ] } });
  for (const cap of ['signet.contacts.read:method:phone', 'signet.contacts.read:method:email', 'signet.contacts.read:tier', 'signet.contacts.read:checks'] as const) {
    expect(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY[cap] })).not.toBeChecked();
  }
  await userEvent.click(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:method:email'] }));
  await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
  expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
    capabilities: ['signet.contacts.read:directory', 'signet.contacts.read:method:email'],
  }));
});

it('chooses exactly one identity when two lists share the owner vault', async () => {
  const user = userEvent.setup();
  const { onApprove } = setup({ directories: [
    { directoryId: 'owner', ownerIdentityPubkey: '1'.repeat(64), label: 'Personal' },
    { directoryId: 'owner', ownerIdentityPubkey: '2'.repeat(64), label: 'Work' },
  ] });
  await user.click(screen.getByRole('radio', { name: 'Work' }));
  expect(screen.getByRole('radio', { name: 'Personal' })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
    directoryId: 'owner', ownerIdentityPubkey: '2'.repeat(64),
  })));
});

it('disables approval when switching an invite-only grant to a dependant', async () => {
  const capability = 'signet.contacts.invites:create' as const;
  const { onApprove } = setup({ request: { ...REQUEST, capabilities: [capability] } });
  const approve = screen.getByRole('button', { name: 'Approve' });
  await userEvent.click(screen.getByRole('checkbox', { name: CONTACTS_GRANT_CAPABILITY_COPY[capability] }));
  expect(approve).toBeEnabled();
  await userEvent.click(screen.getByRole('radio', { name: 'Robin' }));
  expect(approve).toBeDisabled();
  expect(onApprove).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('radio', { name: 'You' }));
  expect(approve).toBeEnabled();
});
