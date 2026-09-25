import { expect, it, vi } from 'vitest';
import { createContactRequest } from '@forgesworn/signet-contacts';
import { LocalSigningBackend } from './signing-backend';
import { contactPolicySigningBackend } from './contact-policy-signing-backend';
import type { ContactInviteDecision } from './contact-invite-policy';
const local = () => new LocalSigningBackend('01'.repeat(32));
const peer = '02'.repeat(32);
function template(backend: LocalSigningBackend) {
  const request = createContactRequest({ id: 'a'.repeat(32), from: backend.activePublicKeyHex, to: peer, nonce: 'b'.repeat(64),
    reply: { secret: 'c'.repeat(64), relays: ['wss://relay.example'] }, now: 1800000000 });
  return { kind: 13, pubkey: backend.activePublicKeyHex, tags: [], created_at: 1800000000, content: JSON.stringify(request) };
}
it('requires fresh guardian permission at the signing boundary, before any signature', async () => {
  for (const result of ['deny', 'guardian-review'] as const) {
    const backend = local(), sign = vi.spyOn(backend, 'signEvent');
    const decision = vi.fn(async () => result);
    await expect(contactPolicySigningBackend(backend, decision).signEvent(template(backend))).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
    expect(decision).toHaveBeenCalledWith(peer, backend.activePublicKeyHex);
  }
});
it('does not return a signature if permission is withdrawn while hardware is signing', async () => {
  const backend = local();
  let policy: ContactInviteDecision = 'allow';
  const sign = backend.signEvent.bind(backend);
  vi.spyOn(backend, 'signEvent').mockImplementation(async event => { const signed = await sign(event); policy = 'deny'; return signed; });
  await expect(contactPolicySigningBackend(backend, async () => policy).signEvent(template(backend))).rejects.toThrow('not allowed');
});
it('signs allowed exchanges but cannot bind them to another identity', async () => {
  const backend = local(), decision = vi.fn(async () => 'allow' as const);
  const guarded = contactPolicySigningBackend(backend, decision), event = template(backend);
  expect((await guarded.signEvent(event)).pubkey).toBe(backend.activePublicKeyHex);
  expect(decision).toHaveBeenCalledTimes(2);
  const body = JSON.parse(event.content); body.from = '03'.repeat(32);
  await expect(guarded.signEvent({ ...event, content: JSON.stringify(body) })).rejects.toThrow('identity mismatch');
});
it('preserves unrelated signing and binds encryption methods to their backend', async () => {
  const backend = local(), decision = vi.fn(async () => 'deny' as const);
  const guarded = contactPolicySigningBackend(backend, decision);
  await guarded.signEvent({ kind: 1, pubkey: backend.activePublicKeyHex, tags: [], created_at: 1800000000, content: 'hello' });
  expect(decision).not.toHaveBeenCalled();
  const ciphertext = await guarded.nip44Encrypt(backend.activePublicKeyHex, 'private');
  expect(await guarded.nip44Decrypt(backend.activePublicKeyHex, ciphertext)).toBe('private');
});
