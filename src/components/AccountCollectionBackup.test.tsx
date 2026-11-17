// @vitest-environment jsdom
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {AccountCollectionBackup} from './AccountCollectionBackup';
vi.mock('../lib/wrapped-backup-file', () => ({saveAccountCollectionFile: vi.fn(async () => true),
  readAccountCollectionFile: vi.fn(async () => new Uint8Array([1]))}));

describe('collection recovery confirmation', () => {
  it('shows the authenticated inventory and restores only the selected absent accounts after separate approval', async () => {
    const restore = vi.fn(async () => {});
    render(<AccountCollectionBackup accounts={[]} existingNpubs={['npub-existing']}
      onCreate={vi.fn()} onInspect={vi.fn(async () => ({createdAt: 1, sha256: 'a'.repeat(64), accounts: [
        {name: 'First', npub: 'npub-new'}, {name: 'Already here', npub: 'npub-existing'}, {name: 'Optional', npub: 'npub-optional'},
      ]}))} onRestore={restore} />);
    fireEvent.change(screen.getByLabelText('Account collection file'), {target: {files: [{}]}});
    await waitFor(() => expect(screen.getByRole('button', {name: 'Open collection'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name: 'Open collection'}));
    await screen.findByText('npub-new');
    expect(screen.getByLabelText('Restore Already here')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Restore Optional'));
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Restore 1 selected account'}));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(new Uint8Array([1]), ['npub-new'], 'a'.repeat(64)));
    expect(await screen.findByRole('status')).toHaveTextContent('Restored 1');
  });
});
