import { expect, it, vi } from 'vitest';
import { guardedSigningBackend } from './guarded-signing-backend';
import { LocalSigningBackend } from './signing-backend';

it('discards a late signature after the publication scope changes', async () => {
  const backend = new LocalSigningBackend('1'.repeat(64));
  const event = { kind: 30078, pubkey: backend.activePublicKeyHex, created_at: 1, tags: [], content: '' };
  const signed = await backend.signEvent(event);
  let finish!: () => void;
  vi.spyOn(backend, 'signEvent').mockImplementation(() => new Promise(resolve => { finish = () => resolve(signed); }));
  let current = true;
  const guarded = guardedSigningBackend(backend, () => current);
  const pending = guarded.signEvent(event);
  current = false;
  finish();
  await expect(pending).rejects.toThrow('superseded');
  await expect(guarded.signEvent(event)).rejects.toThrow('superseded');
  expect(backend.signEvent).toHaveBeenCalledTimes(1);
  backend.destroy();
});
