import { parseContactExchangeMessage } from '@forgesworn/signet-contacts';
import type { DecryptingSigningBackend } from './signing-backend';
import type { ContactInviteDecision } from './contact-invite-policy';

/** Defence at the actual signing boundary, including remembered grants and
 * delayed approval. Only recognised contact exchange seals are affected;
 * unrelated event signing and transport encryption keep their existing policy.
 * This does not grant permission or replace the bunker autonomy policy. */
export function contactPolicySigningBackend(backend: DecryptingSigningBackend,
  decision: (peer: string, signer: string) => Promise<ContactInviteDecision>): DecryptingSigningBackend {
  return {
    type: backend.type,
    get activePublicKeyHex() { return backend.activePublicKeyHex; },
    async signEvent(event) {
      const template = { ...event, tags: event.tags.map(tag => [...tag]) };
      const message = template.kind === 13 ? parseContactExchangeMessage(template.content) : null;
      if (!message) return backend.signEvent(template);
      const signer = backend.activePublicKeyHex;
      if (message.from !== signer || (template.pubkey && template.pubkey !== signer) || template.tags.length) {
        throw new Error('Contact exchange identity mismatch');
      }
      const check = async () => {
        const result = await decision(message.to, signer);
        if (result !== 'allow') throw new Error(result === 'guardian-review'
          ? 'Guardian contact approval required' : 'Contact invitations are not allowed for this person');
      };
      await check();
      const signed = await backend.signEvent(template);
      // A hardware prompt or human decision can outlive a policy update. Do not
      // return the resulting seal to the client if authority was withdrawn.
      await check();
      return signed;
    },
    nip44Encrypt: (peer, text) => backend.nip44Encrypt(peer, text),
    nip44Decrypt: (peer, text) => backend.nip44Decrypt(peer, text),
    ...(backend.nip04Encrypt ? { nip04Encrypt: backend.nip04Encrypt.bind(backend) } : {}),
    ...(backend.nip04Decrypt ? { nip04Decrypt: backend.nip04Decrypt.bind(backend) } : {}),
    destroy: () => backend.destroy(),
  };
}
