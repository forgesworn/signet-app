// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContactsCard } from './ContactsCard';
import type { EffectiveContact } from '../types';
const contacts = [{ contactId: 'a'.repeat(32), displayName: 'Private friend', effectiveTier: 'kith', lifecycle: 'active', updatedAt: 1 }] as EffectiveContact[];
it('does not render private names or counts before the directory is available', () => {
  render(<ContactsCard name="Child" contacts={contacts} available={false} onOpen={vi.fn()} />);
  expect(screen.queryByText('Private friend')).toBeNull();
  expect(screen.queryByText(/1 contacts/)).toBeNull();
  expect(screen.getByRole('button', { name: 'View contacts' })).toBeTruthy();
});
it('passes the summary search through to the selected identity list', async () => {
  const onOpen = vi.fn(async () => {});
  render(<ContactsCard name="Persona" contacts={contacts} available onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'friend' } });
  fireEvent.click(screen.getByRole('button', { name: 'View contacts' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('view', 'friend'));
});
