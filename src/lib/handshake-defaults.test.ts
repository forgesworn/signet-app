import { beforeEach, expect, it } from 'vitest';
import { getDb, purgeAllUserData } from './db';
import { defaultHandshakeChoice, loadHandshakeChoice, saveHandshakeChoice } from './handshake-defaults';

beforeEach(() => purgeAllUserData());
it('defaults to the available name and picture, remembers an encrypted choice per persona', async () => {
  const persona = '1'.repeat(64), other = '2'.repeat(64), key = 'handshake defaults test';
  const info = { name: 'Private name', hasPhoto: true };
  expect(defaultHandshakeChoice(info)).toEqual({ name: true, photo: true });
  expect(defaultHandshakeChoice({ name: '', hasPhoto: false })).toEqual({ name: false, photo: false });
  await saveHandshakeChoice(persona, key, { name: false, photo: true });
  const row = await (await getDb()).get('privateVaultState', `handshake-default:${persona}`);
  expect(row?.encrypted).toBeTruthy();
  expect(row?.encrypted).not.toContain('"photo"');
  expect(await loadHandshakeChoice(persona, key, info)).toEqual({ name: false, photo: true });
  expect(await loadHandshakeChoice(other, key, info)).toEqual({ name: true, photo: true });
  expect(await loadHandshakeChoice(persona, key, { name: '', hasPhoto: false })).toEqual({ name: false, photo: false });
});
it('"Hide me" starts as the user\'s own blur setting, is remembered either way, and an older choice follows the setting', async () => {
  const persona = '1'.repeat(64), key = 'handshake defaults test', info = { name: 'Private name', hasPhoto: false };
  expect(defaultHandshakeChoice(info, true)).toEqual({ name: true, photo: false, blur: true });
  expect(defaultHandshakeChoice(info, false)).toEqual({ name: true, photo: false });
  // No saved choice: the setting decides.
  expect(await loadHandshakeChoice(persona, key, info, true)).toEqual({ name: true, photo: false, blur: true });
  expect(await loadHandshakeChoice(persona, key, info, false)).toEqual({ name: true, photo: false });
  // A saved choice wins over the setting, in both directions.
  await saveHandshakeChoice(persona, key, { name: true, photo: false, blur: false });
  expect(await loadHandshakeChoice(persona, key, info, true)).toEqual({ name: true, photo: false });
  await saveHandshakeChoice(persona, key, { name: true, photo: false, blur: true });
  expect(await loadHandshakeChoice(persona, key, info, false)).toEqual({ name: true, photo: false, blur: true });
  // A choice saved before the field existed (no `blur` in the row) follows the setting.
  const { encryptSecret } = await import('./crypto-store');
  await (await getDb()).put('privateVaultState', { id: `handshake-default:${persona}`, generation: 9, encrypted: await encryptSecret(JSON.stringify({ name: true, photo: false }), key) });
  expect(await loadHandshakeChoice(persona, key, info, true)).toEqual({ name: true, photo: false, blur: true });
  expect(await loadHandshakeChoice(persona, key, info, false)).toEqual({ name: true, photo: false });
});
