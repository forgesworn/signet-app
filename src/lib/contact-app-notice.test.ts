import { expect, it } from 'vitest';
import { vaultContentHash } from 'signet-protocol/experimental';
import { uncheckedAppConnection } from './contact-app-notice';
import type { ContactRecord } from '../types';
it('allows Undo only for a new exchange contact, never a reused existing contact or another identity', () => {
  const own = 'a'.repeat(64), exchange = 'b'.repeat(32);
  const contact = { directoryId: 'owner', contactId: vaultContentHash(`contact-exchange:owner:${exchange}:contact`).slice(0, 32),
    lifecycle: 'active', origins: [{ id: exchange, ownerIdentityPubkey: own, method: 'app', appName: 'Example game', addedAt: 100 }], identities: [] } as unknown as ContactRecord;
  expect(uncheckedAppConnection(contact, own)).toEqual({ appName: 'Example game', canUndo: true });
  expect(uncheckedAppConnection({ ...contact, contactId: 'c'.repeat(32) }, own)?.canUndo).toBe(false);
  expect(uncheckedAppConnection(contact, 'd'.repeat(64))).toBeNull();
  expect(uncheckedAppConnection({ ...contact, lifecycle: 'removed' }, own)).toBeNull();
});
