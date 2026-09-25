import { describe, expect, it, vi } from 'vitest';
import { localVaultBackend, prepareVaultSnapshot, readVaultSnapshot, splitVaultPlaintext, fetchVaultEvents } from './private-vault';
import { LocalSigningBackend } from './signing-backend';
import { openVaultPayload } from './vault-envelope';
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('private vault encrypted transport', () => {
  it('restores a multichunk Unicode snapshot through real signatures and encryption', async () => {
    const vault = localVaultBackend(WORDS, 'profiles');
    const device = new LocalSigningBackend('02'.repeat(32));
    try {
      const plaintext = JSON.stringify({ names: ['é🦊'.repeat(1800)] });
      const prepared = await prepareVaultSnapshot({ plaintext, dataset: 'profiles', rotation: 0, sequence: 1,
        createdAt: 1700000000, vault, device, maxBucket: 4096 });
      expect(prepared.chunks.length).toBeGreaterThan(1);
      expect(new TextEncoder().encode(prepared.checkpoint.content).length).toBeLessThan(12288);
      expect(prepared.chunks.every(c => c.pubkey === device.activePublicKeyHex)).toBe(true);
      const reader = { checkpoints: async () => [prepared.checkpoint],
        chunk: async (id: string) => prepared.chunks.find(c => c.id === id) ?? null,
        open: (content: string, author: string) => openVaultPayload(content, vault, author, { legacyFallback: false }) };
      const expected = { author: vault.activePublicKeyHex, purpose: 'signet:vault:profiles', rotation: 0, publisher: device.activePublicKeyHex };
      expect(await readVaultSnapshot(reader, expected)).toMatchObject({ state: 'ready', plaintext });
      const missing = { ...reader, chunk: async () => null };
      expect(await readVaultSnapshot(missing, expected)).toEqual({ state: 'unusable', reason: 'chunk' });
      const foreign = localVaultBackend(WORDS, 'contacts:owner');
      try {
        const wrongKey = { ...reader, open: (content: string, author: string) => openVaultPayload(content, foreign, author, { legacyFallback: false }) };
        expect(await readVaultSnapshot(wrongKey, expected)).toEqual({ state: 'unusable', reason: 'checkpoint' });
      } finally { foreign.destroy(); }
    } finally { vault.destroy(); device.destroy(); }
  });

  it('keeps empty snapshots explicit and rejects oversize input rather than truncating', () => {
    expect(splitVaultPlaintext('', 4092)).toEqual(['']);
    const text = 'a🦊é'.repeat(5);
    const pieces = splitVaultPlaintext(text, 5);
    expect(pieces.join('')).toBe(text);
    expect(pieces.every(p => new TextEncoder().encode(p).length <= 5)).toBe(true);
    expect(() => splitVaultPlaintext('a'.repeat(129), 4)).toThrow('chunk limit');
  });

  it('separates owner, dependant and rotation keys', () => {
    const backends = [localVaultBackend(WORDS, 'contacts:owner'), localVaultBackend(WORDS, { dependant: 0 }),
      localVaultBackend(WORDS, 'contacts:owner', 1)];
    try { expect(new Set(backends.map(b => b.activePublicKeyHex)).size).toBe(3); }
    finally { backends.forEach(b => b.destroy()); }
  });
});

it('does not treat a relay timeout as an absent backup', async () => {
  vi.useFakeTimers();
  try {
    const relay = { subscribe: vi.fn(() => 'subscription'), closeSubscription: vi.fn() };
    const pending = fetchVaultEvents(relay, {}, 100);
    const check = expect(pending).rejects.toThrow('did not complete');
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(relay.closeSubscription).toHaveBeenCalledWith('subscription');
  } finally { vi.useRealTimers(); }
});

it('restores both device heads after concurrent offline snapshots', async () => {
  const { readVaultHeads } = await import('signet-protocol/experimental');
  const vault = localVaultBackend(WORDS, 'contacts:owner');
  const devices = [new LocalSigningBackend('02'.repeat(32)), new LocalSigningBackend('03'.repeat(32))];
  try {
    const snapshots = await Promise.all(devices.map((device, i) => prepareVaultSnapshot({ plaintext: JSON.stringify({ edit: i }),
      dataset: 'contacts:owner', rotation: 0, sequence: 1, createdAt: 1700000000, vault, device })));
    expect(snapshots[0].checkpoint.tags).not.toEqual(snapshots[1].checkpoint.tags);
    const reader = { checkpoints: async () => snapshots.map(s => s.checkpoint),
      chunk: async (id: string) => snapshots.flatMap(s => s.chunks).find(c => c.id === id) ?? null,
      open: (content: string, author: string) => openVaultPayload(content, vault, author, { legacyFallback: false }) };
    const result = await readVaultHeads(reader, { author: vault.activePublicKeyHex, purpose: 'signet:vault:contacts:owner', rotation: 0 });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Expected both device heads');
    expect(result.snapshots.map(s => JSON.parse(s.plaintext).edit).sort()).toEqual([0, 1]);
    const incomplete = { ...reader, chunk: async (id: string) => snapshots[0].chunks.find(c => c.id === id) ?? null };
    expect(await readVaultHeads(incomplete, { author: vault.activePublicKeyHex, purpose: 'signet:vault:contacts:owner', rotation: 0 }))
      .toEqual({ state: 'unusable', reason: 'chunk' });
  } finally { vault.destroy(); devices.forEach(d => d.destroy()); }
});
