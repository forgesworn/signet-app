// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ContactChecks } from './ContactChecks';
import { checkNip05 } from '../lib/nip05-check';
import type { ContactIdentity } from '../types';
vi.mock('../lib/nip05-check', async original => ({ ...await original<typeof import('../lib/nip05-check')>(), checkNip05: vi.fn() }));
const pubkey = 'a'.repeat(64);
const identities = [{ itemId: '1'.repeat(32), pubkey, provenance: 'direct', verification: 'unverified', addedAt: 100 }] as ContactIdentity[];
it('edits the same check and preserves its precise time when the date is unchanged', async () => {
  const onRecord = vi.fn(), onUpdate = vi.fn(async () => {});
  const check = { id: '2'.repeat(32), ownerIdentityPubkey: 'b'.repeat(64), identityPubkey: pubkey,
    method: 'in-person' as const, checkedAt: 1700000123456, evidence: 'Old note' };
  render(<ContactChecks identities={identities} checks={[check]} onRecord={onRecord} onUpdate={onUpdate} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit check' }));
  fireEvent.change(screen.getByLabelText('Private evidence or link'), { target: { value: 'Updated note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save check' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ id: check.id, identityPubkey: pubkey,
    method: 'in-person', checkedAt: check.checkedAt, evidence: 'Updated note' }));
  expect(onRecord).not.toHaveBeenCalled();
});
it('looks up NIP-05 only on a tap and records only a successful key match', async () => {
  vi.mocked(checkNip05).mockReset().mockResolvedValueOnce('mismatch').mockResolvedValueOnce('match');
  const onRecord = vi.fn(async () => {});
  render(<ContactChecks identities={identities} checks={[]} onRecord={onRecord} />);
  fireEvent.change(screen.getByLabelText('NIP-05 address to check'), { target: { value: 'alice@example.com' } });
  expect(checkNip05).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check address and record match' }));
  await screen.findByText('This address lists a different key.');
  expect(onRecord).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check address and record match' }));
  await waitFor(() => expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ identityPubkey: pubkey,
    method: 'nip05', source: 'nip05', evidence: 'alice@example.com' })));
});
