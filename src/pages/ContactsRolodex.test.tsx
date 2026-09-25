// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactsRolodex } from './ContactsRolodex';
import type { EffectiveContact } from '../types';

function contact(over: Partial<EffectiveContact> & { contactId: string }): EffectiveContact {
  return {
    directoryId: 'owner', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  } as EffectiveContact;
}

/**
 * `relayUrl=''` is deliberately invalid: `fetchContactAvatarPointers` bails
 * out on an invalid relay URL before touching the network, so the page's
 * avatar-batch effect never opens a real connection in this test.
 */
function renderRolodex(contacts: EffectiveContact[], extra: Record<string, unknown> = {}) {
  render(
    <ContactsRolodex
      contacts={contacts}
      loading={false}
      actorPubkey={'1'.repeat(64)}
      guardianName={null}
      subjectName={null}
      relayUrl=""
      encryptionKey={null}
      onSelectContact={() => {}}
      onNewContact={() => {}}
      {...extra}
    />,
  );
}

describe('ContactsRolodex', () => {
  it('sorts A to Z under All and puts a blocked contact last', () => {
    const dave = contact({ contactId: 'dave', displayName: 'Dave' });
    const amy = contact({ contactId: 'amy', displayName: 'Amy' });
    const bad = contact({ contactId: 'bad', displayName: 'Bad Bob', blocked: true });
    renderRolodex([dave, amy, bad]);
    const rows = screen.getAllByRole('button', { name: /^Open / });
    expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['Open Amy', 'Open Dave', 'Open Bad Bob']);
  });

  it('excludes a blocked contact from a tier filter, and shows it only under Blocked', () => {
    const dave = contact({ contactId: 'dave', displayName: 'Dave', effectiveTier: 'kin' });
    const bad = contact({ contactId: 'bad', displayName: 'Bad Bob', effectiveTier: 'kin', blocked: true });
    renderRolodex([dave, bad]);

    fireEvent.click(screen.getByRole('button', { name: 'Kin' }));
    expect(screen.getByRole('button', { name: 'Open Dave' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open Bad Bob' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Blocked' }));
    expect(screen.getByRole('button', { name: 'Open Bad Bob' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open Dave' })).toBeNull();
  });

  it('shows the empty state with an add prompt when there are no contacts at all', () => {
    renderRolodex([]);
    expect(screen.getByText('No contacts yet')).toBeDefined();
    expect(screen.getByText('Add someone to see them here.')).toBeDefined();
  });

  it('shows the no-matches state, without the add prompt, for a query with no hits', () => {
    renderRolodex([contact({ contactId: 'dave', displayName: 'Dave' })]);
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeDefined();
    expect(screen.queryByText('Add someone to see them here.')).toBeNull();
    // Still offered, so a no-match search doesn't strand the user.
    expect(screen.getByRole('button', { name: 'New contact' })).toBeDefined();
  });

  it('sanitises the interpolated dependant name in the subject heading', () => {
    const malicious = 'Eve‮Joe'; // LRO bidi override
    renderRolodex([], { subjectName: malicious });
    expect(screen.getByText("EveJoe's contacts")).toBeDefined();
  });
});
