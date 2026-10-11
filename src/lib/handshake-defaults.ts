import type { ContactCardChoice, ContactCardInfo } from './contact-card-share';
import { updateEncryptedPrivateState } from './private-vault-store';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
const rowId = (persona: string) => {
  if (!/^[0-9a-f]{64}$/.test(persona)) throw new Error('Invalid persona');
  return `handshake-default:${persona}`;
};
/** `blurDefault`: the user's own `blurIdentityNames`, which is what "hide me" starts as. `blur` is present only when true. */
export function defaultHandshakeChoice(info: ContactCardInfo, blurDefault = false): ContactCardChoice {
  return { name: !!info.name, photo: info.hasPhoto, ...(blurDefault ? { blur: true } : {}) };
}
export async function loadHandshakeChoice(persona: string, key: string, info: ContactCardInfo, blurDefault = false): Promise<ContactCardChoice> {
  const row = await (await getDb()).get('privateVaultState', rowId(persona));
  if (!row) return defaultHandshakeChoice(info, blurDefault);
  const value: unknown = JSON.parse(await decryptSecret(row.encrypted, key));
  if (!value || typeof value !== 'object' || !('name' in value) || !('photo' in value)
    || typeof value.name !== 'boolean' || typeof value.photo !== 'boolean') throw new Error('Invalid handshake default');
  // A choice saved before "hide me" existed has no `blur`: it follows the user's own setting.
  const blur = 'blur' in value && typeof value.blur === 'boolean' ? value.blur : blurDefault;
  return { name: value.name && !!info.name, photo: value.photo && info.hasPhoto, ...(blur ? { blur: true } : {}) };
}
export function saveHandshakeChoice(persona: string, key: string, choice: ContactCardChoice) {
  return updateEncryptedPrivateState(rowId(persona), key, () => ({ name: choice.name, photo: choice.photo, blur: choice.blur === true }));
}
