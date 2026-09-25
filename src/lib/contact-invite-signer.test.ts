import { expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { contactInviteSigner } from './contact-invite-signer';
import type { SignetIdentity } from '../types';
const secret = '1'.repeat(64), pubkey = getPublicKey(hexToBytes(secret));
const identity = { naturalPerson: { publicKey: pubkey, privateKey: secret },
  persona: { publicKey: '2'.repeat(64), privateKey: '' } } as SignetIdentity;
it('signs only an owned identity and rejects stale sessions before signing', async () => {
  let current = true;
  const options = { identity, mode: 'local', routed: vi.fn(() => null), isCurrent: () => current };
  const signer = contactInviteSigner(pubkey, options);
  const event = await signer.signEvent({ pubkey, kind: 13, content: 'test', tags: [], created_at: 100 });
  expect(event.pubkey).toBe(pubkey);
  expect(options.routed).not.toHaveBeenCalled();
  expect(() => contactInviteSigner('3'.repeat(64), options)).toThrow('not owned');
  current = false;
  await expect(signer.signEvent({ pubkey, kind: 13, content: '', tags: [], created_at: 100 })).rejects.toThrow('session changed');
});
it('does not fall back to local recovery keys for hardware identities', async () => {
  const signer = contactInviteSigner(pubkey, { identity, mode: 'bunker', routed: () => null, isCurrent: () => true });
  await expect(signer.signEvent({ pubkey, kind: 13, content: '', tags: [], created_at: 100 })).rejects.toThrow('Connect the signer');
});
it('routes a dependant persona without admitting the guardian or using hardware recovery keys', async () => {
  const own = getPublicKey(hexToBytes('4'.repeat(64)));
  const holder = { persona: { publicKey: own, privateKey: '4'.repeat(64), displayName: 'Child' } };
  const route = vi.fn(() => null);
  expect(() => contactInviteSigner(pubkey, { identity: holder, mode: 'local', routed: route, isCurrent: () => true })).toThrow('not owned');
  const hardware = contactInviteSigner(own, { identity: holder, mode: 'bunker', routed: route, isCurrent: () => true });
  await expect(hardware.signEvent({ pubkey: own, kind: 13, content: '', tags: [], created_at: 100 })).rejects.toThrow('Connect the signer');
  expect(route).toHaveBeenCalledWith(own);
  const imported = contactInviteSigner(own, { identity: holder, mode: 'bunker', imported: true, routed: route, isCurrent: () => true });
  expect((await imported.signEvent({ pubkey: own, kind: 13, content: '', tags: [], created_at: 100 })).pubkey).toBe(own);
});
