import type { ContactIdentitySigner } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import type { SignetIdentity } from '../types';
import { LocalSigningBackend } from './signing-backend';
import type { DecryptingSigningBackend } from './signing-backend';
import { assertSigningIdentity } from './guardian-signing';

/** Only explicitly owned slots can sign; the active carousel key is no fallback. */
export function contactInviteSigner(pubkey: string, options: {
  identity: Pick<SignetIdentity, 'persona' | 'extraPersonas' | 'professionalPersona'> & { naturalPerson?: SignetIdentity['naturalPerson'] }; mode: string;
  imported?: boolean;
  routed(pubkey: string): DecryptingSigningBackend | null;
  isCurrent(): boolean;
}): ContactIdentitySigner {
  const slots = [...(options.identity.naturalPerson ? [{ ...options.identity.naturalPerson, imported: options.imported ?? false }] : []),
    { ...options.identity.persona, imported: options.imported ?? false },
    ...(options.identity.professionalPersona ? [{ ...options.identity.professionalPersona, imported: false }] : []),
    ...(options.identity.extraPersonas ?? [])];
  const slot = slots.find(s => s.publicKey === pubkey);
  if (!slot) throw new Error('Invite identity is not owned by this account');
  const invoke = async <T>(run: (backend: DecryptingSigningBackend) => Promise<T>): Promise<T> => {
    if (!options.isCurrent()) throw new Error('Invite session changed');
    const local = (options.mode === 'local' || slot.imported) && /^[0-9a-f]{64}$/.test(slot.privateKey);
    const backend = local ? new LocalSigningBackend(slot.privateKey) : options.routed(pubkey);
    if (!backend) throw new Error('Connect the signer for this identity');
    try {
      assertSigningIdentity(backend, pubkey);
      const result = await run(backend);
      if (!options.isCurrent()) throw new Error('Invite session changed');
      return result;
    } finally { if (local) backend.destroy(); }
  };
  return { publicKey: pubkey, signEvent: event => invoke(b => b.signEvent(event)),
    decrypt: (sender, ciphertext) => invoke(b => b.nip44Decrypt(sender, ciphertext)) };
}
