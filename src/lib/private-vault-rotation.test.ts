import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const mocks = vi.hoisted(() => ({ reader: vi.fn(), flush: vi.fn() }));
vi.mock('./private-vault', async original => ({ ...await original<typeof import('./private-vault')>(), relayVaultReader: mocks.reader }));
vi.mock('./private-vault-publish', () => ({ flushVaultBackup: mocks.flush }));
// At-rest encryption (PBKDF2, 600k iterations per call) is not under test here
// and dominated runtime: every rotation-walk resolve reloads encrypted state.
// A key-bound reversible stand-in keeps the store's behaviour, not its cost.
vi.mock('./crypto-store', async original => ({ ...await original<typeof import('./crypto-store')>(),
  encryptSecret: async (plaintext: string, key: string) => `test:${btoa(key)}:${btoa(unescape(encodeURIComponent(plaintext)))}`,
  decryptSecret: async (encrypted: string, key: string) => {
    const [, bound, body] = encrypted.split(':');
    if (bound !== btoa(key)) throw new Error('wrong key');
    return decodeURIComponent(escape(atob(body)));
  } }));
import { rotatePrivateVaultDataset, syncPrivateVaultDataset } from './private-vault-sync';
import { localVaultBackend } from './private-vault';
import { confirmVaultBackup, loadVaultBackup } from './private-vault-store';
import { loadVaultRotation } from './private-vault-rotation-store';
import { openVaultPayload } from './vault-envelope';
import { purgeAllUserData } from './db';
const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const events = new Map<string, NostrEvent>();
const sent: Array<{ rotation: number; next?: number }> = [];
let fail: 'target' | 'forward' | undefined;
beforeEach(async () => {
  await purgeAllUserData(); vi.clearAllMocks(); events.clear(); sent.length = 0; fail = undefined;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() } });
  mocks.reader.mockImplementation((_relays, backend) => ({
    checkpoints: async (author: string) => [...events.values()].filter(event => event.pubkey === author),
    chunk: async (id: string) => events.get(id) ?? null,
    open: (content: string, author: string) => openVaultPayload(content, backend, author, { legacyFallback: false }),
  }));
  mocks.flush.mockImplementation(async options => {
    const stored = await loadVaultBackup(options.backend.activePublicKeyHex, options.encryptionKey);
    const pending = stored.pending!;
    if ((fail === 'target' && pending.manifest.rotation === 1) || (fail === 'forward' && pending.manifest.nextRotation !== undefined)) return { state: 'pending', confirmedRelays: [] };
    sent.push({ rotation: pending.manifest.rotation, next: pending.manifest.nextRotation });
    for (const event of [...pending.chunks, pending.checkpoint]) {
      const tag = event.tags.find(tag => tag[0] === 'd')?.[1];
      for (const [id, previous] of events) if (previous.pubkey === event.pubkey && previous.kind === event.kind
        && previous.tags.find(tag => tag[0] === 'd')?.[1] === tag) events.delete(id);
      events.set(event.id, event);
    }
    await confirmVaultBackup(options.backend.activePublicKeyHex, options.encryptionKey, pending.checkpoint.id, options.now, options.relays);
    return { state: 'verified', confirmedRelays: options.relays };
  });
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
  let version = 1;
  return { adapter: { dataset: 'profiles' as const, snapshot: async () => JSON.stringify({ v: version }), merge: async (text: string) => { version = Math.max(version, JSON.parse(text).v); } },
    ownerPubkey: 'a'.repeat(64), encryptionKey: 'rotation-test-key', relays: { read: ['wss://relay.example'], write: ['wss://relay.example'] },
    resolve: async (rotation: number) => localVaultBackend(words, 'profiles', rotation), isCurrent: () => true, now: 1800000000 };
}
it('verifies the old copy, then the new copy, then its forward pointer, and resumes ordinary sync at the new key', async () => {
  const args = setup();
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'complete', rotation: 1 });
  expect(sent).toEqual([{ rotation: 0, next: undefined }, { rotation: 1, next: undefined }, { rotation: 0, next: 1 }]);
  expect(await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey)).toMatchObject({ phase: 'complete', to: 1 });
  expect((await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey))?.target).toBeUndefined();
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'verified', rotation: 1 });
});
it('keeps the old key recoverable after a failed destination upload, without automatic signing retries', async () => {
  const args = setup(); fail = 'target';
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'pending', rotation: 1 });
  expect(sent).toEqual([{ rotation: 0, next: undefined }]);
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'verified', rotation: 0 });
  expect((await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey))?.phase).toBe('preparing');
  fail = undefined;
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'complete', rotation: 1 });
});
it('repairs a vanished destination from retained signed bytes and finishes the same interrupted rotation', async () => {
  const args = setup(); fail = 'forward';
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'pending', rotation: 1 });
  const intent = (await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey))!;
  expect(intent.phase).toBe('forwarding'); expect(intent.target).toBeDefined();
  for (const event of [intent.target!.checkpoint, ...intent.target!.chunks]) events.delete(event.id);
  fail = undefined;
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'complete', rotation: 1 });
  expect(sent.some(row => row.rotation === 2)).toBe(false);
  expect(events.has(intent.target!.checkpoint.id)).toBe(true);
  expect((await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey))?.id).toBe(intent.id);
});
it('ordinary sync resumes an already signed forward pointer without starting another rotation', async () => {
  const args = setup(); fail = 'forward';
  expect(await rotatePrivateVaultDataset(args)).toMatchObject({ state: 'pending' });
  fail = undefined;
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'verified', rotation: 1 });
  expect((await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey))?.phase).toBe('complete');
  expect(sent.some(row => row.rotation === 2)).toBe(false);
});
it('a stuck forward pointer does not block ordinary sync once the new rotation is complete', async () => {
  let version = 1;
  const args = { ...setup(), adapter: { dataset: 'profiles' as const, snapshot: async () => JSON.stringify({ v: version }),
    merge: async (text: string) => { version = Math.max(version, JSON.parse(text).v); } } };
  fail = 'forward';
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'pending', rotation: 1 });
  const before = sent.length;
  version = 2;
  // Pointer still cannot publish; sync must still write the new state to rotation 1.
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'verified', rotation: 1 });
  expect(sent.slice(before)).toEqual([{ rotation: 1, next: undefined }]);
  // Within the backoff window the pointer is not retried, and sync still works.
  version = 3;
  expect(await syncPrivateVaultDataset({ ...args, now: args.now + 1 })).toMatchObject({ state: 'verified', rotation: 1 });
  expect(sent.some(row => row.next !== undefined)).toBe(false);
  const source = await args.resolve(0);
  expect((await loadVaultBackup(source.activePublicKeyHex, args.encryptionKey)).pending?.manifest.nextRotation).toBe(1);
  source.destroy();
});
it('stops before the forward pointer when the session locks after uploading the destination', async () => {
  const args = setup(); let unlocked = true;
  args.isCurrent = () => unlocked;
  const publish = mocks.flush.getMockImplementation()!;
  // Check the publication rather than trusting local metadata fields.
  mocks.flush.mockImplementation(async options => {
    const result = await publish(options);
    if (sent.at(-1)?.rotation === 1) unlocked = false;
    return result;
  });
  expect(await rotatePrivateVaultDataset(args)).toMatchObject({ state: 'cancelled' });
  expect(sent.some(row => row.next !== undefined)).toBe(false);
  expect((await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey))?.target).toBeDefined();
  mocks.flush.mockImplementation(publish); unlocked = true;
  expect(await rotatePrivateVaultDataset(args)).toMatchObject({ state: 'complete', rotation: 1 });
});
it('refuses manual rotation without a cross-tab lock', async () => {
  vi.stubGlobal('navigator', {});
  await expect(rotatePrivateVaultDataset(setup())).rejects.toThrow('coordinate');
  expect(sent).toEqual([]);
});
