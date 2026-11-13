import { describe, it, expect, vi, beforeEach } from 'vitest';

const MASTER = 'a'.repeat(64);
const CLIENT_SECRET = 'c'.repeat(64);

const state = vi.hoisted(() => ({
  fromBunker: vi.fn(),
  close: vi.fn(async () => {}),
  destroy: vi.fn(),
  getPublicKey: vi.fn(),
  sendRequest: vi.fn(),
  secretSeen: null as Uint8Array | null,
}));

vi.mock('nostr-tools/nip46', () => ({
  BunkerSigner: {
    fromBunker: (sk: Uint8Array, bp: unknown, params: unknown) => {
      state.secretSeen = sk;
      state.fromBunker(sk, bp, params);
      return { close: state.close, getPublicKey: state.getPublicKey, sendRequest: state.sendRequest };
    },
  },
}));
vi.mock('nostr-tools/pool', () => ({ SimplePool: class { destroy = state.destroy; } }));
vi.mock('./relay-ready', () => ({ RELAY_READY_CAP_MS: 3000, waitForReplySubscription: async () => {} }));

import { createBunkerProbe } from './signer-relay-probe';

describe('createBunkerProbe', () => {
  beforeEach(() => { vi.clearAllMocks(); state.secretSeen = null; });

  it('asks get_public_key on ONE relay with no secret and no connect, then tears down', async () => {
    state.getPublicKey.mockResolvedValue(MASTER);
    const reply = await createBunkerProbe(CLIENT_SECRET, MASTER)('wss://r.example', new AbortController().signal);
    expect(reply).toBe(MASTER);
    expect(state.fromBunker).toHaveBeenCalledTimes(1);
    const bp = state.fromBunker.mock.calls[0][1] as { pubkey: string; relays: string[]; secret: unknown };
    expect(bp).toEqual({ pubkey: MASTER, relays: ['wss://r.example'], secret: null });
    expect(state.sendRequest).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalledTimes(1);
    expect(Array.from(state.secretSeen!).every(b => b === 0)).toBe(true);
  });

  it('tears down and zeroizes when the request fails', async () => {
    state.getPublicKey.mockRejectedValue(new Error('no reply'));
    await expect(createBunkerProbe(CLIENT_SECRET, MASTER)('wss://r.example', new AbortController().signal)).rejects.toThrow();
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalledTimes(1);
    expect(Array.from(state.secretSeen!).every(b => b === 0)).toBe(true);
  });

  it('closes the client when aborted while waiting', async () => {
    state.getPublicKey.mockReturnValue(new Promise(() => {}));
    const ctl = new AbortController();
    const p = createBunkerProbe(CLIENT_SECRET, MASTER)('wss://r.example', ctl.signal);
    await vi.waitFor(() => expect(state.getPublicKey).toHaveBeenCalled());
    ctl.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(state.destroy).toHaveBeenCalledTimes(1);
    expect(Array.from(state.secretSeen!).every(b => b === 0)).toBe(true);
  });

  it('does nothing when already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(createBunkerProbe(CLIENT_SECRET, MASTER)('wss://r.example', ctl.signal)).rejects.toThrow();
    expect(state.fromBunker).not.toHaveBeenCalled();
  });
});
