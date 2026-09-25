/**
 * Integration regression for the vault-pubkey cache (BunkerSigningBackend):
 * runs a REAL rotation through `runPrivateVaultRotation`, whose `baseline`
 * callback is the REAL `syncPrivateVaultDatasetLocked` — the exact shape
 * private-vault-jobs.ts wires in production. `resolve()` is backed by a
 * single, shared, real `BunkerSigningBackend` instance (its transport
 * stubbed; the Heartwood RPC layer is a deterministic in-test simulator, not
 * a mock of the cache itself), so this exercises the real `vaultBackend()`
 * cache under the exact defect scenario a prior fix attempt introduced:
 * rotation resolves and holds `source`/`target` across many awaited steps,
 * and partway through calls `baseline(args)`, which resolves the SAME
 * contexts again and `destroy()`s its OWN resolved instances in its own
 * `finally`. A cache that shared backend INSTANCES (rather than only the
 * resolved pubkey) would have destroyed rotation's still-in-use `target`
 * from underneath it — rotation would then hit `'Vault backend destroyed'`
 * on its next signing call and stay stuck `pending` forever, and the sync's
 * own `finally` would tear down the just-resolved pubkey's backend every
 * cycle, forcing a fresh `get_public_key` RPC on every poll (the exact
 * symptom this whole fix targets). This test fails under that defect and
 * passes under the fix (each caller gets its own instance; destroying one
 * never touches another's).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const mocks = vi.hoisted(() => ({ reader: vi.fn(), flush: vi.fn(), vaultRpcCalls: [] as string[] }));
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
// Deterministic in-test Heartwood simulator: resolves/signs/encrypts through
// the SAME mnemonic-derived vault key `localVaultBackend` would use for that
// (dataset, rotation) — a real board re-derives on every request rather than
// remembering anything, so this simulator does too. It is the network layer
// only; it never touches BunkerSigningBackend's own cache.
//
// This mock is fully self-contained (no `importOriginal`/spread of the real
// module): mirrors HeartwoodVaultBackend's real validation/dispatch, since a
// plain synchronous factory with no internal `await` is the pattern proven
// reliable elsewhere in this codebase for a module reached via dynamic
// `import()` from multiple call sites in the module under test.
vi.mock('./heartwood-vault', () => {
  class MockHeartwoodVaultBackend {
    readonly type = 'bunker' as const;
    private destroyed = false;
    private constructor(readonly activePublicKeyHex: string, private readonly context: { purpose: string; index: number },
      private readonly rpc: (method: string, params: string[], context: { purpose: string; index: number }) => Promise<string>) {}
    static fromResolvedPubkey(pubkey: string, context: { purpose: string; index: number },
      rpc: (method: string, params: string[], context: { purpose: string; index: number }) => Promise<string>, identityPubkeys: readonly string[]) {
      if (!/^[0-9a-f]{64}$/.test(pubkey) || identityPubkeys.includes(pubkey)) throw new Error('Signer did not resolve a dedicated vault key');
      return new MockHeartwoodVaultBackend(pubkey, context, rpc);
    }
    static async create(dataset: string, rotation: number,
      rpc: (method: string, params: string[], context: { purpose: string; index: number }) => Promise<string>, identityPubkeys: readonly string[]) {
      const context = { purpose: `signet:vault:${dataset}`, index: rotation };
      const pubkey = await rpc('get_public_key', [], context);
      return MockHeartwoodVaultBackend.fromResolvedPubkey(pubkey, context, rpc, identityPubkeys);
    }
    private request(method: string, params: string[]): Promise<string> {
      if (this.destroyed) return Promise.reject(new Error('Vault backend destroyed'));
      return this.rpc(method, params, this.context);
    }
    async signEvent(event: { pubkey: string }) { return JSON.parse(await this.request('sign_event', [JSON.stringify(event)])); }
    nip44Encrypt(peer: string, plaintext: string) {
      if (peer !== this.activePublicKeyHex) return Promise.reject(new Error('Vault keys wrap only to themselves'));
      return this.request('nip44_encrypt', [peer, plaintext]);
    }
    nip44Decrypt(peer: string, ciphertext: string) {
      if (peer !== this.activePublicKeyHex) return Promise.reject(new Error('Vault keys unwrap only their own backups'));
      return this.request('nip44_decrypt', [peer, ciphertext]);
    }
    destroy() { this.destroyed = true; }
  }
  const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  return {
    HeartwoodVaultBackend: MockHeartwoodVaultBackend,
    // Built from THIRD-PARTY primitives only (signet-protocol,
    // signet-protocol/experimental, nostr-tools/nip44, @noble/*), dynamically
    // imported here — never from './signing-backend' (the module under test,
    // which is what dynamically imports THIS mocked module). A dynamic
    // self-import of the very module currently mid-resolution of its own
    // './heartwood-vault' import was empirically found to desync the mock
    // for a SUBSEQUENT `import('./heartwood-vault')` call in the same
    // chain — reproducible, and gone once this stopped reaching back into
    // './signing-backend'.
    heartwoodVaultRequest: vi.fn(async (args: { method: string; params: string[]; context: { purpose: string; index: number } }) => {
      mocks.vaultRpcCalls.push(`${args.method}:${args.context.purpose}:${args.context.index}`);
      const [{ signEvent: protocolSignEvent, zeroise }, { vaultIdentityFromMnemonic, parseVaultPurpose }, { getConversationKey, encrypt: nip44EncryptRaw, decrypt: nip44DecryptRaw }, { schnorr }, { bytesToHex, hexToBytes }] = await Promise.all([
        import('signet-protocol'), import('signet-protocol/experimental'), import('nostr-tools/nip44'),
        import('@noble/curves/secp256k1.js'), import('@noble/hashes/utils.js'),
      ]);
      const dataset = parseVaultPurpose(args.context.purpose)!;
      const child = vaultIdentityFromMnemonic(WORDS, dataset, args.context.index);
      try {
        const privHex = bytesToHex(child.privateKey);
        const pubHex = bytesToHex(schnorr.getPublicKey(hexToBytes(privHex)));
        if (args.method === 'get_public_key') return pubHex;
        if (args.method === 'sign_event') {
          const event = JSON.parse(args.params[0]);
          return JSON.stringify(await protocolSignEvent({ ...event, pubkey: pubHex }, privHex));
        }
        const privBytes = hexToBytes(privHex);
        try {
          const conversationKey = getConversationKey(privBytes, args.params[0]);
          return args.method === 'nip44_encrypt' ? nip44EncryptRaw(args.params[1], conversationKey) : nip44DecryptRaw(args.params[1], conversationKey);
        } finally { privBytes.fill(0); }
      } finally { zeroise(child); }
    }),
  };
});
import { rotatePrivateVaultDataset, syncPrivateVaultDataset } from './private-vault-sync';
import { BunkerSigningBackend } from './signing-backend';
import { confirmVaultBackup, loadVaultBackup } from './private-vault-store';
import { loadVaultRotation } from './private-vault-rotation-store';
import { openVaultPayload } from './vault-envelope';
import { purgeAllUserData } from './db';
const events = new Map<string, NostrEvent>();
const sent: Array<{ rotation: number; next?: number }> = [];
beforeEach(async () => {
  await purgeAllUserData(); vi.clearAllMocks(); events.clear(); sent.length = 0; mocks.vaultRpcCalls.length = 0;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() } });
  mocks.reader.mockImplementation((_relays, backend) => ({
    checkpoints: async (author: string) => [...events.values()].filter(event => event.pubkey === author),
    chunk: async (id: string) => events.get(id) ?? null,
    open: (content: string, author: string) => openVaultPayload(content, backend, author, { legacyFallback: false }),
  }));
  mocks.flush.mockImplementation(async options => {
    const stored = await loadVaultBackup(options.backend.activePublicKeyHex, options.encryptionKey);
    const pending = stored.pending!;
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

/**
 * One shared, real `BunkerSigningBackend` — the production shape
 * (private-vault-jobs.ts holds exactly one per identity and every dataset's
 * `resolve` closure calls `bunker.vaultBackend(...)` on it). Its transport is
 * stubbed directly (no real NIP-46 connect): `vaultBackend()` only checks
 * `this.signer` for truthiness and reads `this.bunkerUri` to build the RPC
 * request — both stubbed here — and delegates every actual vault RPC through
 * the mocked `heartwoodVaultRequest` above. This exercises the REAL
 * `vaultBackend()` cache (vaultPubkeys/vaultGeneration), not a mock of it.
 */
function bunkerResolve() {
  const bunker = new BunkerSigningBackend('03'.repeat(32));
  (bunker as unknown as { signer: unknown }).signer = {};
  bunker.bunkerUri = `bunker://${'b'.repeat(64)}?relay=wss://relay.example`;
  return (rotation: number) => bunker.vaultBackend('profiles', rotation, []);
}
function setup() {
  let version = 1;
  return { adapter: { dataset: 'profiles' as const, snapshot: async () => JSON.stringify({ v: version }), merge: async (text: string) => { version = Math.max(version, JSON.parse(text).v); } },
    ownerPubkey: 'a'.repeat(64), encryptionKey: 'rotation-test-key', relays: { read: ['wss://relay.example'], write: ['wss://relay.example'] },
    resolve: bunkerResolve(), isCurrent: () => true, now: 1800000000 };
}

it('rotation completes with a shared BunkerSigningBackend resolve, even though baseline() resolves and destroys its own copy of the same contexts mid-rotation', async () => {
  const args = setup();
  expect(await rotatePrivateVaultDataset(args)).toEqual({ state: 'complete', rotation: 1 });
  expect(sent).toEqual([{ rotation: 0, next: undefined }, { rotation: 1, next: undefined }, { rotation: 0, next: 1 }]);
  expect(await loadVaultRotation(args.ownerPubkey, 'profiles', args.encryptionKey)).toMatchObject({ phase: 'complete', to: 1 });
  // Ordinary sync afterwards, through the SAME shared backend, still works —
  // proving the cache survived the whole rotation+baseline interleaving.
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'verified', rotation: 1 });
});

it('the shared backend issues only ONE get_public_key RPC per rotation across the whole rotate-then-sync cycle', async () => {
  const args = setup();
  await rotatePrivateVaultDataset(args);
  await syncPrivateVaultDataset(args);
  const getPubkeyCalls = mocks.vaultRpcCalls.filter(entry => entry.startsWith('get_public_key:'));
  const rotation0Calls = getPubkeyCalls.filter(entry => entry.endsWith(':0'));
  const rotation1Calls = getPubkeyCalls.filter(entry => entry.endsWith(':1'));
  expect(rotation0Calls.length).toBe(1);
  expect(rotation1Calls.length).toBe(1);
});
