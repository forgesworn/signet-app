import { expect, it } from 'vitest';
import { assertContactMailboxCapacity } from './contact-invite-limits';
import { createStoredContactInvite } from './contact-invite-store';
import type { ContactInviteVault } from './contact-invite-store';
const owner = 'a'.repeat(64);
const state = (): ContactInviteVault => ({ v: 1, directoryId: 'owner', invites: Array.from({ length: 16 }, (_, n) =>
  createStoredContactInvite({ identityPubkey: owner, name: `Invite ${n}`, now: 100, relays: [`wss://relay${n}.example`] })),
  arrivals: [], exchanges: [], outbox: [] });
it('limits admissions per identity and frees capacity when an invite is disabled', () => {
  const full = state();
  expect(() => assertContactMailboxCapacity(full, owner, 101, ['wss://relay0.example/'], 'invite')).toThrow('16 active');
  expect(() => assertContactMailboxCapacity(full, 'b'.repeat(64), 101, ['wss://other.example'], 'invite')).not.toThrow();
  full.invites[0].enabled = false;
  expect(() => assertContactMailboxCapacity(full, owner, 101, ['wss://relay0.example/'], 'invite')).not.toThrow();
});
it('bounds the distinct relay set without double-counting URL spellings', () => {
  expect(() => assertContactMailboxCapacity(state(), owner, 101, ['wss://relay0.example/'], 'exchange')).not.toThrow();
  expect(() => assertContactMailboxCapacity(state(), owner, 101, ['wss://another.example'], 'exchange')).toThrow('relay addresses');
});
