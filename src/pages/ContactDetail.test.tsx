// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactDetail } from './ContactDetail';
import type { EffectiveContact, SignetIdentity } from '../types';
import { resolveActorRights } from '../lib/contacts-v2-rights';
import { detailSections } from '../lib/contacts-v2-detail';
import { CONTACT_ACTION_FAILED_COPY } from '../lib/contacts-v2-copy';

const ME = '1'.repeat(64);
const GUARDIAN = '2'.repeat(64);

function identity(): SignetIdentity {
  return {
    id: ME, mnemonic: '',
    naturalPerson: { publicKey: ME, privateKey: '', displayName: 'Real' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Anon' },
    primaryKeypair: 'persona', isChild: false, createdAt: 1,
  } as SignetIdentity;
}

function contact(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'c1', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  };
}

function detailProps(record: EffectiveContact, actorRole: 'owner' | 'dependant', handlers: Record<string, unknown> = {}) {
  const rights = resolveActorRights(record, { actorRole, actorPubkey: ME });
  const legacy = { hasSharedSecret: false, hasKenEntry: false };
  const noop = async () => {};
  return {
    contact: record,
    identity: identity(),
    rights,
    sections: detailSections(record, rights, legacy),
    legacy,
    legacyContact: undefined,
    actorPubkey: ME,
    guardianName: 'Joe',
    onRename: noop,
    onSetTier: noop,
    onAddRole: noop,
    onRemoveRole: noop,
    onAddMethod: noop,
    onRemoveItem: noop,
    onSetNote: noop,
    onBlock: noop,
    onUnblock: noop,
    onRemove: noop,
    onOpenKenDetail: () => {},
    ...handlers,
  };
}

function renderDetail(record: EffectiveContact, actorRole: 'owner' | 'dependant', handlers = {}) {
  return render(<ContactDetail {...detailProps(record, actorRole, handlers)} />);
}

describe('ContactDetail on v2', () => {
  it('shows the keyless marker and explainer when there is no identity', () => {
    renderDetail(contact(), 'owner');
    expect(screen.getByText('No key verified')).toBeDefined();
    expect(screen.getByText(/need a verified key/)).toBeDefined();
  });

  it('shows the effective tier line with provenance', () => {
    renderDetail(contact({ effectiveTier: 'ken', tierSource: 'guardian-limited' }), 'dependant');
    expect(screen.getByText('Joe limited this to Ken')).toBeDefined();
  });

  it('offers Block with a reason field and reports the boundary', () => {
    const onBlock = vi.fn(async () => {});
    renderDetail(contact(), 'owner', { onBlock });
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'spam' } });
    expect(screen.getByText(/cannot stop someone posting on Nostr/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Block Dave' }));
    expect(onBlock).toHaveBeenCalledWith('spam');
  });

  it('disables Unblock with the guardian copy for a dependant', () => {
    const record = contact({
      blocked: true, blockedBy: [GUARDIAN],
      blocks: [{ blockedBy: GUARDIAN, scope: { kind: 'contact' }, blockedAt: 5, operationId: 'op-b' }],
    });
    renderDetail(record, 'dependant');
    expect(screen.getByText('Joe blocked Dave')).toBeDefined();
    const unblock = screen.getByRole('button', { name: 'Unblock' }) as HTMLButtonElement;
    expect(unblock.disabled).toBe(true);
    expect(screen.getByText('A guardian applied this block')).toBeDefined();
  });

  it('enables Unblock for the actor own block', () => {
    const record = contact({
      blocked: true, blockedBy: [ME],
      blocks: [{ blockedBy: ME, scope: { kind: 'contact' }, blockedAt: 5, operationId: 'op-b' }],
    });
    renderDetail(record, 'owner');
    expect(screen.getByText('Blocked by you')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Unblock' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds a contact method through the validator', () => {
    const onAddMethod = vi.fn(async () => {});
    renderDetail(contact(), 'owner', { onAddMethod });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'dave@example.com' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add method' }));
    expect(onAddMethod).toHaveBeenCalledWith({
      kind: 'email', value: 'dave@example.com',
      verification: 'unverified', sharingPolicy: 'private',
    });
  });

  it('confirms before removing', () => {
    const onRemove = vi.fn(async () => {});
    renderDetail(contact(), 'owner', { onRemove });
    fireEvent.click(screen.getByRole('button', { name: 'Remove contact' }));
    expect(screen.getByText(/Remove Dave from your contacts/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalled();
  });

  // I1 (fix round 1): a rejected mutator must not become a silent unhandled
  // rejection. `onRemove` is the closest stand-in for "the navigation
  // callback" this page has — in App.tsx it's `async () => { await
  // contactsV2.removeContact(...); navigateReplace('contacts'); }`, so a
  // rejection here is exactly the case where navigation must never fire.
  // The page itself has no separate navigation prop to assert against, so
  // this asserts the error copy renders and `onRemove` was invoked exactly
  // once (no retry-on-failure loop hiding the rejection).
  it('shows the error copy when a mutation rejects, and does not retry', async () => {
    const onRemove = vi.fn(async () => { throw new Error('boom'); });
    renderDetail(contact(), 'owner', { onRemove });
    fireEvent.click(screen.getByRole('button', { name: 'Remove contact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(CONTACT_ACTION_FAILED_COPY)).toBeDefined();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // M6
  it('requires field selection before exporting even an unclassified contact', () => {
    const record = contact({
      effectiveTier: 'none', tierSource: 'direct',
      identities: [{ itemId: 'i1', pubkey: 'a'.repeat(64), provenance: 'direct', verification: 'proven', addedAt: 1 }],
    });
    renderDetail(record, 'owner');
    expect(screen.queryByRole('link', { name: /vCard/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose fields to share' }));
    expect(screen.getByRole('link', { name: /vCard/ })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: /Public key/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Notes' })).not.toBeChecked();
  });

  // M10
  it('re-seeds the name and note drafts when the record changes underneath an untouched field', () => {
    const record = contact({ displayName: 'Dave', notes: 'old note' });
    const { rerender } = render(<ContactDetail {...detailProps(record, 'owner')} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Dave');
    expect((screen.getByLabelText('Private note') as HTMLTextAreaElement).value).toBe('old note');

    const renamed = contact({ displayName: 'David', notes: 'new note' });
    rerender(<ContactDetail {...detailProps(renamed, 'owner')} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('David');
    expect((screen.getByLabelText('Private note') as HTMLTextAreaElement).value).toBe('new note');
  });

  it('never clobbers a touched name or note draft with an incoming record change', () => {
    const record = contact({ displayName: 'Dave', notes: 'old note' });
    const { rerender } = render(<ContactDetail {...detailProps(record, 'owner')} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft name' } });
    fireEvent.change(screen.getByLabelText('Private note'), { target: { value: 'my draft note' } });

    const renamed = contact({ displayName: 'David', notes: 'new note' });
    rerender(<ContactDetail {...detailProps(renamed, 'owner')} />);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My draft name');
    expect((screen.getByLabelText('Private note') as HTMLTextAreaElement).value).toBe('my draft note');
  });
});
