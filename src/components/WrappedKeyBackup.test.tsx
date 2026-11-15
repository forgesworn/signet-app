// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WrappedKeyRestore } from './WrappedKeyBackup';

const record = 'nstw1:' + 'A'.repeat(175);
function chooseFile(text = record, size = text.length) {
  fireEvent.change(screen.getByLabelText('Encrypted backup file'), {target: {files: [{size, text: async () => text}]}});
}

describe('wrapped account restore confirmation', () => {
  it('checks the file, displays the account, and requires a separate confirmation before saving', async () => {
    const inspect = vi.fn(async () => 'npub1-test-account');
    const restore = vi.fn(async () => ({added: true as const, pubkey: 'abc'}));
    render(<WrappedKeyRestore onInspect={inspect} onRestore={restore} />);
    chooseFile();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Check backup file'})).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Restored account name'), {target: {value: 'Existing account'}});
    fireEvent.click(screen.getByRole('button', {name: 'Check backup file'}));
    await screen.findByText('npub1-test-account');
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Restore this account'}));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(record, 'Existing account', 'npub1-test-account'));
    expect(await screen.findByRole('status')).toHaveTextContent('Restored');
  });

  it('does not inspect oversized files and clears a previously checked account when the file changes', async () => {
    const inspect = vi.fn(async () => 'npub1-first');
    render(<WrappedKeyRestore onInspect={inspect} onRestore={vi.fn()} />);
    chooseFile(record, 5000);
    expect(await screen.findByRole('alert')).toHaveTextContent('file');
    expect(inspect).not.toHaveBeenCalled();
    chooseFile();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Check backup file'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name: 'Check backup file'}));
    await screen.findByText('npub1-first');
    chooseFile(record.slice(0, -1) + 'B');
    await waitFor(() => expect(screen.queryByText('npub1-first')).toBeNull());
    expect(screen.queryByRole('button', {name: 'Restore this account'})).toBeNull();
  });
});
