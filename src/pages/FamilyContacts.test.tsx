// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FamilyContacts } from './FamilyContacts';
import { buildManagerRows, type ManagerDirectory } from '../lib/contacts-v2-manager-rows';
import type { EffectiveContact } from '../types';
import type { FamilyOpRequest } from '../hooks/useFamilyContactsV2';
import { buildOperation } from '../lib/contacts-v2-mutations';
import { validateOperation } from '../lib/contacts-v2-reducer';
import { newOperationId } from '../lib/contacts-v2-ids';

const ME = '1'.repeat(64);
const DAVE = 'a'.repeat(64);
const TOM = 'b'.repeat(64);

function contact(over: Partial<EffectiveContact> & { contactId: string }): EffectiveContact {
  return {
    directoryId: 'owner', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [],
    identities: [{ itemId: 'i1', pubkey: DAVE, provenance: 'direct', verification: 'proven', addedAt: 1 }],
    contactMethods: [], accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  } as EffectiveContact;
}

const directories: ManagerDirectory[] = [
  { directoryId: 'owner', label: 'You', isOwner: true, contacts: [contact({ contactId: 'c-owner' })] },
  { directoryId: 'dependant:0', label: 'Sam', isOwner: false, contacts: [] },
  { directoryId: 'dependant:1', label: 'Lily', isOwner: false, contacts: [] },
];

function renderManager(onApply = vi.fn(async (_reqs: FamilyOpRequest[]) => {})) {
  const rows = buildManagerRows(directories, { actorPubkey: ME });
  render(
    <FamilyContacts
      rows={rows}
      directories={directories}
      actorPubkey={ME}
      guardianPubkey={ME}
      guardianName="Joe"
      loading={false}
      error={null}
      onApply={onApply}
      onBack={() => {}}
    />,
  );
  return onApply;
}

describe('FamilyContacts', () => {
  it('renders a column per directory and a row per contact', () => {
    renderManager();
    expect(screen.getByText('You')).toBeDefined();
    expect(screen.getByText('Sam')).toBeDefined();
    expect(screen.getByText('Lily')).toBeDefined();
    expect(screen.getByRole('button', { name: /Dave/ })).toBeDefined();
  });

  it('names every affected directory before sharing, and only applies on confirm', async () => {
    const onApply = renderManager();
    fireEvent.click(screen.getByRole('button', { name: /Dave/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Share with my dependants' }));
    fireEvent.click(screen.getByLabelText('Sam'));
    fireEvent.click(screen.getByLabelText('Lily'));
    expect(screen.getByText(/Sam and Lily/)).toBeDefined();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onApply).toHaveBeenCalled();
    const requests = onApply.mock.calls[0][0];
    expect(requests.filter((r: { action: string }) => r.action === 'add')).toHaveLength(2);
    expect(requests.filter((r: { action: string }) => r.action !== 'record-share').every((r: { directoryId: string }) => r.directoryId !== 'owner')).toBe(true);
  });

  it('vouches per selected directory with the per-child role', () => {
    const onApply = renderManager();
    fireEvent.click(screen.getByRole('button', { name: /Dave/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vouch as Kin for…' }));
    fireEvent.click(screen.getByLabelText('Sam'));
    fireEvent.change(screen.getByLabelText('Role for Sam'), { target: { value: 'Uncle Dave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const requests = onApply.mock.calls[0][0];
    const vouch = requests.find((r: { action: string }) => r.action === 'vouch');
    expect(vouch!.value).toMatchObject({ tier: 'kin', role: 'Uncle Dave' });
    expect(vouch!.directoryId).toBe('dependant:0');
  });

  it('offers Add here on an empty cell and Remove here on a filled one', () => {
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: /Dave/ }));
    expect(screen.getAllByRole('button', { name: 'Add here' }).length).toBe(2);
    expect(screen.getByRole('button', { name: 'Remove here' })).toBeDefined();
  });

  it('disables Confirm until at least one directory is selected', () => {
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: /Dave/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Share with my dependants' }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Sam'));
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
  });

  it('renders the ceiling select — never a dead Set ceiling button — on a present non-owner cell', () => {
    const nonOwnerDirectories: ManagerDirectory[] = [
      { directoryId: 'owner', label: 'You', isOwner: true, contacts: [] },
      {
        directoryId: 'dependant:0', label: 'Sam', isOwner: false,
        contacts: [contact({
          contactId: 'c-sam', directoryId: 'dependant:0', displayName: 'Uncle Tom',
          identities: [{ itemId: 'i2', pubkey: TOM, provenance: 'direct', verification: 'proven', addedAt: 1 }],
        })],
      },
      { directoryId: 'dependant:1', label: 'Lily', isOwner: false, contacts: [] },
    ];
    const rows = buildManagerRows(nonOwnerDirectories, { actorPubkey: ME });
    render(
      <FamilyContacts
        rows={rows}
        directories={nonOwnerDirectories}
        actorPubkey={ME}
        guardianPubkey={ME}
        guardianName="Joe"
        loading={false}
        error={null}
        onApply={vi.fn(async (_reqs: FamilyOpRequest[]) => {})}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Uncle Tom/ }));
    expect(screen.queryByRole('button', { name: 'Set ceiling' })).toBeNull();
    expect(screen.getByLabelText('Ceiling for Sam')).toBeDefined();
  });

  it('C0: every request confirmBulk builds for a keyed contact is independently valid (share, vouch-with-role, own-directory)', async () => {
    // A dedicated fixture with a proper 32-hex contactId AND 64-hex dependant
    // directory ids: `validateOperation` checks both structurally (R-15
    // tightened `directoryId` to `owner|quarantine|dependant:<64-hex>`), and
    // the module-level `directories` fixture's 'c-owner'/'dependant:0' are
    // not — fine for the other tests here (none of them build a real op), but
    // this test needs every id realistic.
    const ownerContactId = 'c'.repeat(32);
    const c0Directories: ManagerDirectory[] = [
      { directoryId: 'owner', label: 'You', isOwner: true, contacts: [contact({ contactId: ownerContactId })] },
      { directoryId: `dependant:${'b'.repeat(64)}`, label: 'Sam', isOwner: false, contacts: [] },
      { directoryId: `dependant:${'c'.repeat(64)}`, label: 'Lily', isOwner: false, contacts: [] },
    ];
    const onApply = vi.fn(async (_reqs: FamilyOpRequest[]) => {});
    render(
      <FamilyContacts
        rows={buildManagerRows(c0Directories, { actorPubkey: ME })}
        directories={c0Directories}
        actorPubkey={ME}
        guardianPubkey={ME}
        guardianName="Joe"
        loading={false}
        error={null}
        onApply={onApply}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Dave/ }));

    // Share branch: Sam + Lily.
    fireEvent.click(screen.getByRole('button', { name: 'Share with my dependants' }));
    fireEvent.click(screen.getByLabelText('Sam'));
    fireEvent.click(screen.getByLabelText('Lily'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const shareRequests = onApply.mock.calls[0][0] as FamilyOpRequest[];
    expect(shareRequests.some(r => r.action === 'add-identity')).toBe(true);

    // Vouch branch: You (own-directory) + Sam (vouch, with a role). The bulk
    // trigger buttons are `disabled={busy}` — wait for the share Confirm's
    // `run()` to settle (busy clears) before this click can land at all.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Vouch as Kin for…' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Vouch as Kin for…' }));
    fireEvent.click(screen.getByLabelText('You'));
    fireEvent.click(screen.getByLabelText('Sam'));
    fireEvent.change(screen.getByLabelText('Role for Sam'), { target: { value: 'Uncle Dave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    const vouchRequests = onApply.mock.calls[1][0] as FamilyOpRequest[];
    expect(vouchRequests.some(r => r.action === 'vouch')).toBe(true);
    expect(vouchRequests.some(r => r.action === 'set-tier')).toBe(true);
    expect(vouchRequests.some(r => r.action === 'add-identity')).toBe(true);

    // C0: `add-identity` requests used to omit `itemId` entirely, which
    // `validateOperation` rejects outright — build a REAL op from each
    // request exactly the way `useFamilyContactsV2.applyOps` does, and
    // confirm every one of them is independently valid.
    const actor = { actorPubkey: ME, actorRole: 'guardian' as const, actorDeviceId: 'd'.repeat(32) };
    let clock = 1;
    for (const req of [...shareRequests, ...vouchRequests]) {
      const op = buildOperation({
        directoryId: req.directoryId,
        contactId: req.contactId,
        action: req.action,
        value: req.value,
        clock: clock++,
        actor,
        now: Date.now(),
        operationId: newOperationId(),
        ...(req.itemId ? { itemId: req.itemId } : {}),
        ...(req.targetOperationId ? { targetOperationId: req.targetOperationId } : {}),
      });
      expect(validateOperation(op), `${req.action} on ${req.directoryId} failed validation`).toBe(true);
    }
  });

  it('I3: the ceiling select shows the actor\'s own ceiling and revokes it on the blank option, not a bare set-tier `""`', () => {
    const cappedDirectories: ManagerDirectory[] = [
      { directoryId: 'owner', label: 'You', isOwner: true, contacts: [] },
      {
        directoryId: 'dependant:0', label: 'Sam', isOwner: false,
        contacts: [contact({
          contactId: 'c-sam', directoryId: 'dependant:0', displayName: 'Uncle Tom',
          identities: [{ itemId: 'i2', pubkey: TOM, provenance: 'direct', verification: 'proven', addedAt: 1 }],
          ceilings: [{ guardianPubkey: ME, maxTier: 'kith', createdAt: 1, operationId: 'op-1' }],
        })],
      },
      { directoryId: 'dependant:1', label: 'Lily', isOwner: false, contacts: [] },
    ];
    const rows = buildManagerRows(cappedDirectories, { actorPubkey: ME });
    const onApply = vi.fn(async (_reqs: FamilyOpRequest[]) => {});
    render(
      <FamilyContacts
        rows={rows}
        directories={cappedDirectories}
        actorPubkey={ME}
        guardianPubkey={ME}
        guardianName="Joe"
        loading={false}
        error={null}
        onApply={onApply}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Uncle Tom/ }));

    const select = screen.getByLabelText('Ceiling for Sam') as HTMLSelectElement;
    // The select already reflects the actor's own active ceiling.
    expect(select.value).toBe('kith');

    fireEvent.change(select, { target: { value: '' } });
    expect(onApply).toHaveBeenCalledWith([{
      directoryId: 'dependant:0', contactId: 'c-sam', action: 'revoke-ceiling', value: { guardianPubkey: ME },
    }]);
  });

  it('shows an empty state when nothing is shared yet', () => {
    render(
      <FamilyContacts
        rows={[]}
        directories={directories}
        actorPubkey={ME}
        guardianPubkey={ME}
        guardianName="Joe"
        loading={false}
        error={null}
        onApply={vi.fn(async (_reqs: FamilyOpRequest[]) => {})}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText('No contacts across the family yet')).toBeDefined();
  });
});
