import type { ContactCardChoice, ContactCardInfo } from './contact-card-share';
import { updateEncryptedPrivateState } from './private-vault-store';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
const rowId = (persona: string) => {
  if (!/^[0-9a-f]{64}$/.test(persona)) throw new Error('Invalid persona');
  return `handshake-default:${persona}`;
};
export function defaultHandshakeChoice(info: ContactCardInfo): ContactCardChoice {
  return { name: !!info.name, photo: info.hasPhoto };
}
export async function loadHandshakeChoice(persona: string, key: string, info: ContactCardInfo): Promise<ContactCardChoice> {
  const row = await (await getDb()).get('privateVaultState', rowId(persona));
  if (!row) return defaultHandshakeChoice(info);
  const value: unknown = JSON.parse(await decryptSecret(row.encrypted, key));
  if (!value || typeof value !== 'object' || !('name' in value) || !('photo' in value)
    || typeof value.name !== 'boolean' || typeof value.photo !== 'boolean') throw new Error('Invalid handshake default');
  return { name: value.name && !!info.name, photo: value.photo && info.hasPhoto };
}
export function saveHandshakeChoice(persona: string, key: string, choice: ContactCardChoice) {
  return updateEncryptedPrivateState(rowId(persona), key, () => ({ name: choice.name, photo: choice.photo }));
}
