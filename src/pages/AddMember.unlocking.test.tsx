// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SignetIdentity } from '../types';
import { AddMember } from './AddMember';

// Unlock sets the encryption key before the stored identity is decrypted, so
// for a moment the key fields still hold ciphertext. Add must wait for a real
// key rather than feed ciphertext into ECDH.
const CIPHERTEXT = 'U2FsdGVkX1'.padEnd(144, 'A');

function identityWith(privateKey: string): SignetIdentity {
  const sk = bytesToHex(generateSecretKey());
  return {
    id: getPublicKey(Uint8Array.from(Buffer.from(sk, 'hex'))),
    primaryKeypair: 'persona', mnemonic: '', isChild: false, createdAt: 0,
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Alex' },
    persona: { publicKey: getPublicKey(Uint8Array.from(Buffer.from(sk, 'hex'))), privateKey, displayName: 'Alex' },
  } as SignetIdentity;
}

async function reachPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'Enter their npub' }));
  const theirs = npubEncode(getPublicKey(generateSecretKey()));
  fireEvent.change(screen.getByPlaceholderText('npub1…'), { target: { value: theirs } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('AddMember while keys are still unlocking', () => {
  it('holds Add until the identity is decrypted, then adds', async () => {
    const onAddMember = vi.fn().mockResolvedValue(undefined);
    const props = { onAddMember, onDone: vi.fn(), signingMode: 'local' as const };
    const { rerender } = render(<AddMember identity={identityWith(CIPHERTEXT)} {...props} />);
    await reachPreview();

    const waiting = screen.getByRole('button', { name: 'Unlocking…' }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    fireEvent.click(waiting);
    expect(onAddMember).not.toHaveBeenCalled();

    rerender(<AddMember identity={identityWith(bytesToHex(generateSecretKey()))} {...props} />);
    const add = screen.getByRole('button', { name: 'Add contact' }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(onAddMember).toHaveBeenCalledTimes(1));
  });
});
