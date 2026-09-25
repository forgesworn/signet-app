import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HeartwoodVaultBackend, heartwoodVaultRequest } from './heartwood-vault';
import { LocalSigningBackend } from './signing-backend';
import { RELAY_READY_CAP_MS } from './relay-ready';

describe('Heartwood dedicated vault context', () => {
  it('never falls back to an existing identity if firmware ignores the context', async () => {
    const rpc = vi.fn(async () => 'a'.repeat(64));
    await expect(HeartwoodVaultBackend.create('profiles', 0, rpc, ['a'.repeat(64)])).rejects.toThrow('dedicated vault');
    expect(rpc).toHaveBeenCalledWith('get_public_key', [], { purpose: 'signet:vault:profiles', index: 0 });
  });
  it('carries the same purpose and rotation on every operation and respects teardown', async () => {
    const local = new LocalSigningBackend('03'.repeat(32));
    const rpc = vi.fn(async (method: string, params: string[]) => {
      if (method === 'get_public_key') return local.activePublicKeyHex;
      if (method === 'sign_event') return JSON.stringify(await local.signEvent(JSON.parse(params[0])));
      if (method === 'nip44_encrypt') return local.nip44Encrypt(params[0], params[1]);
      return local.nip44Decrypt(params[0], params[1]);
    });
    const vault = await HeartwoodVaultBackend.create('profiles', 1, rpc, []);
    try {
      const encrypted = await vault.nip44Encrypt(vault.activePublicKeyHex, 'key');
      expect(await vault.nip44Decrypt(vault.activePublicKeyHex, encrypted)).toBe('key');
      await vault.signEvent({ kind: 30078, pubkey: vault.activePublicKeyHex, created_at: 1, tags: [['d', 'checkpoint']], content: 'control' });
      expect(rpc.mock.calls.every(c => (c as unknown[])[2] && JSON.stringify((c as unknown[])[2]) === JSON.stringify({ purpose: 'signet:vault:profiles', index: 1 }))).toBe(true);
      await expect(vault.nip44Encrypt('a'.repeat(64), 'key')).rejects.toThrow('themselves');
      vault.destroy();
      await expect(vault.nip44Decrypt(vault.activePublicKeyHex, encrypted)).rejects.toThrow('destroyed');
    } finally { local.destroy(); }
  });

  it('fromResolvedPubkey builds an instance with no RPC, and still runs the exclusion check', async () => {
    const rpc = vi.fn(async () => 'a'.repeat(64));
    const pubkey = 'b'.repeat(64);
    const context = { purpose: 'signet:vault:profiles', index: 0 };
    const vault = HeartwoodVaultBackend.fromResolvedPubkey(pubkey, context, rpc, []);
    expect(vault.activePublicKeyHex).toBe(pubkey);
    expect(rpc).not.toHaveBeenCalled();
    expect(() => HeartwoodVaultBackend.fromResolvedPubkey(pubkey, context, rpc, [pubkey])).toThrow('dedicated vault');
  });

  it('two instances built from the same resolved pubkey have independent destroy()', async () => {
    const local = new LocalSigningBackend('03'.repeat(32));
    const rpc = vi.fn(async (method: string, params: string[]) => {
      if (method === 'nip44_encrypt') return local.nip44Encrypt(params[0], params[1]);
      return local.nip44Decrypt(params[0], params[1]);
    });
    const context = { purpose: 'signet:vault:profiles', index: 0 };
    const first = HeartwoodVaultBackend.fromResolvedPubkey(local.activePublicKeyHex, context, rpc, []);
    const second = HeartwoodVaultBackend.fromResolvedPubkey(local.activePublicKeyHex, context, rpc, []);
    try {
      first.destroy();
      await expect(first.nip44Encrypt(first.activePublicKeyHex, 'x')).rejects.toThrow('destroyed');
      const encrypted = await second.nip44Encrypt(second.activePublicKeyHex, 'still works');
      expect(await second.nip44Decrypt(second.activePublicKeyHex, encrypted)).toBe('still works');
    } finally { local.destroy(); }
  });
});

/**
 * `heartwoodVaultRequest` reply-subscription readiness: mirrors
 * BunkerSigningBackend.initSigner's own probe-before-publish wait (now
 * shared via relay-ready.ts) so a fast reply on a freshly opened
 * `subscribeMany` subscription can never race the request that triggers it.
 * `nostr-tools/pool` is mocked for this block only; every other test in this
 * file drives `HeartwoodVaultBackend` directly through a fake `rpc` and never
 * touches the relay layer.
 */
const poolMock = vi.hoisted(() => ({
  /** If true, the probe subscription never EOSEs — only the cap releases it. */
  silent: false,
  /** Order events land in: 'probe-eose', 'publish'. */
  order: [] as string[],
  subscribeManyCalls: 0,
  destroyed: 0,
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    subscribe(_relays: string[], _filter: unknown, params: { oneose?: () => void }) {
      if (!poolMock.silent) setTimeout(() => { poolMock.order.push('probe-eose'); params.oneose?.(); }, 0);
      return { close: () => { /* no-op */ } };
    }
    subscribeMany(_relays: string[], _filter: unknown, _params: unknown) {
      poolMock.subscribeManyCalls += 1;
      return { close: () => { /* no-op */ } };
    }
    publish(_relays: string[], _event: unknown) {
      poolMock.order.push('publish');
      return [Promise.resolve('ok')];
    }
    destroy() { poolMock.destroyed += 1; }
  },
}));

describe('heartwoodVaultRequest reply-subscription readiness', () => {
  const CLIENT_SECRET = 'a'.repeat(64);
  // A real curve point, not an arbitrary 64-hex string: getConversationKey
  // does ECDH against this as the peer pubkey and needs a valid x-coordinate.
  const SIGNER_PUBKEY = new LocalSigningBackend('04'.repeat(32)).activePublicKeyHex;
  const bunkerUri = `bunker://${SIGNER_PUBKEY}?relay=wss://relay.example`;

  beforeEach(() => {
    poolMock.silent = false;
    poolMock.order = [];
    poolMock.subscribeManyCalls = 0;
    poolMock.destroyed = 0;
  });

  it('does not publish before the reply-subscription probe settles', async () => {
    vi.useFakeTimers();
    try {
      const req = heartwoodVaultRequest({
        clientSecret: CLIENT_SECRET, bunkerUri, method: 'get_public_key', params: [],
        context: { purpose: 'signet:vault:profiles', index: 0 }, timeoutMs: 10_000,
      }).catch(() => { /* no reply ever comes; only publish ordering matters here */ });
      await vi.advanceTimersByTimeAsync(0);
      expect(poolMock.order).toEqual(['probe-eose', 'publish']);
      expect(poolMock.subscribeManyCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await req;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still publishes after RELAY_READY_CAP_MS when the probe never settles', async () => {
    poolMock.silent = true;
    vi.useFakeTimers();
    try {
      const req = heartwoodVaultRequest({
        clientSecret: CLIENT_SECRET, bunkerUri, method: 'get_public_key', params: [],
        context: { purpose: 'signet:vault:profiles', index: 0 }, timeoutMs: 10_000,
      }).catch(() => { /* no reply ever comes; only publish ordering matters here */ });
      await vi.advanceTimersByTimeAsync(RELAY_READY_CAP_MS - 1);
      expect(poolMock.order).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(poolMock.order).toEqual(['publish']);
      await vi.advanceTimersByTimeAsync(10_000);
      await req;
    } finally {
      vi.useRealTimers();
    }
  });
});
