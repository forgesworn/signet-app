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
