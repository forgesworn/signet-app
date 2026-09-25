import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same relay mock as personas-sync.test.ts — capture what each rail actually
// puts in `content` so we can assert the wire format, not just `ok === true`.
const relayMock = vi.hoisted(() => ({
  fetchReturns: {} as Record<string, Array<{ id: string; created_at: number; content: string }>>,
  published: [] as Array<{ url: string; content: string }>,
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      url: string;
      constructor(url: string) { this.url = url; }
      async connect(): Promise<void> {}
      async fetch(filters: Array<{ authors?: string[] }>): Promise<Array<{ id: string; created_at: number; content: string; pubkey?: string }>> {
        const author = filters?.[0]?.authors?.[0];
        return (relayMock.fetchReturns[this.url] ?? []).map((e) => ({ pubkey: author, ...e }));
      }
      async publish(ev: { id: string; content: string }): Promise<{ ok: boolean }> {
        relayMock.published.push({ url: this.url, content: ev.content });
        return { ok: true };
      }
      disconnect(): void {}
    },
  };
});

beforeEach(() => {
  relayMock.fetchReturns = {};
  relayMock.published = [];
});

import { publishGrantsSync, fetchGrantsSync } from './grants-sync';
import { publishContactsSync, fetchContactsSync } from './contacts-sync';
import { publishKensSync, fetchKensSync } from './ken-sync';
import { parseVaultEnvelope, sealVaultPayload } from './vault-envelope';
import type { Contact } from '../types';

const AUTHOR = 'a'.repeat(64);
const RELAY = 'wss://a.example';

/**
 * A fake NIP-44 v2 ciphertext: the version byte 2, then the plaintext,
 * space-padded to the 96-byte body a real v2 payload's floor implies, then
 * base64. `openVaultPayload` pre-filters the legacy fallback on exactly that
 * shape (S5). Trailing spaces are harmless: every rail parses its plaintext
 * with `JSON.parse`, which ignores trailing whitespace.
 */
function fakeNip44(plaintext: string): string {
  const body = new TextEncoder().encode(plaintext.padEnd(96, ' '));
  const bytes = new Uint8Array(1 + body.length);
  bytes[0] = 2;
  bytes.set(body, 1);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Reverse `fakeNip44`. Throws for anything that is not one, as a real signer would. */
function openFakeNip44(ciphertext: string): string {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (bytes[0] !== 2) throw new Error('not our ciphertext');
  return new TextDecoder().decode(bytes.subarray(1));
}

function makeBackend() {
  return {
    activePublicKeyHex: AUTHOR,
    type: 'local',
    nip44Encrypt: vi.fn(async (_pub: string, plaintext: string) => fakeNip44(plaintext)),
    nip44Decrypt: vi.fn(async (_pub: string, ciphertext: string) => openFakeNip44(ciphertext)),
    signEvent: vi.fn(async (ev: Record<string, unknown>) => ({ ...ev, id: 'sig'.padEnd(64, '0'), sig: 's'.repeat(128) })),
  } as never;
}

function makeContact(over: Partial<Contact> = {}): Contact {
  return {
    pubkey: 'b'.repeat(64),
    ownerPubkey: AUTHOR,
    displayName: 'Dave',
    sharedSecret: 'c'.repeat(64),
    verifiedAt: 1000,
    ...over,
  } as Contact;
}

describe('rail publish — the four migrated rails emit a v2 envelope', () => {
  it('publishes grants inside a v2 envelope, not a bare NIP-44 payload', async () => {
    const backend = makeBackend();
    const ok = await publishGrantsSync(
      [{ dependantId: 'd'.repeat(64), scope: 'sign', origin: 'https://x.example', decision: 'allow', decidedAt: 10 } as never],
      backend,
      [RELAY],
    );
    expect(ok).toBe(true);
    const envelope = parseVaultEnvelope(relayMock.published[0].content);
    expect(envelope).not.toBeNull();
    expect(envelope!.b).toBe(4096);
    // The grant body never reaches the NIP-44 leg — only the 32-byte key does.
    expect(relayMock.published[0].content).not.toContain('x.example');
    expect(atob(openFakeNip44(envelope!.k).trim()).length).toBe(32);
  });
});

describe('rail publish — the two legacy rails deliberately stay v1 (R5)', () => {
  it('publishes contacts as a bare NIP-44 payload, readable by an old client', async () => {
    const backend = makeBackend();
    expect(await publishContactsSync([makeContact()], backend, [RELAY])).toBe(true);
    expect(parseVaultEnvelope(relayMock.published[0].content)).toBeNull();
    expect(openFakeNip44(relayMock.published[0].content)).toContain('Dave');
  });

  it('publishes kens as a bare NIP-44 payload too', async () => {
    const backend = makeBackend();
    expect(await publishKensSync(
      [{
        pubkey: 'b'.repeat(64), ownerPubkey: AUTHOR, tier: 'ken', displayName: 'Pub', addedAt: 1000,
        provenance: { source: 'manual', locator: 'x', confirmedAt: 1000 },
      } as never],
      backend,
      RELAY,
    )).toBe(true);
    expect(parseVaultEnvelope(relayMock.published[0].content)).toBeNull();
  });
});

describe('rail fetch — reads both formats', () => {
  it('reads a v2 envelope on the contacts rail even though that rail writes v1', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload(JSON.stringify({ v: 1, contacts: [makeContact()] }), backend))!;
    relayMock.fetchReturns[RELAY] = [{ id: 'e'.repeat(64), created_at: 2000, content: sealed }];
    const result = await fetchContactsSync(AUTHOR, backend, [RELAY]);
    expect(result).not.toBeNull();
    expect(result).not.toBe('unreachable');
    expect((result as { contacts: Contact[] }).contacts[0].displayName).toBe('Dave');
  });

  it('still reads a legacy bare-NIP-44 record written by an older build', async () => {
    const backend = makeBackend();
    const legacy = fakeNip44(JSON.stringify({ v: 1, contacts: [makeContact()] }));
    relayMock.fetchReturns[RELAY] = [{ id: 'f'.repeat(64), created_at: 2000, content: legacy }];
    const result = await fetchContactsSync(AUTHOR, backend, [RELAY]);
    expect((result as { contacts: Contact[] }).contacts[0].displayName).toBe('Dave');
  });

  it('reads a v2 grants record', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload(JSON.stringify({ v: 1, grants: [] }), backend))!;
    relayMock.fetchReturns[RELAY] = [{ id: '1'.repeat(64), created_at: 2000, content: sealed }];
    const result = await fetchGrantsSync(AUTHOR, backend, [RELAY]);
    expect(result).not.toBeNull();
    expect(result).not.toBe('unreachable');
    expect((result as { grants: unknown[]; eventId: string }).grants).toEqual([]);
    expect((result as { eventId: string }).eventId).toBe('1'.repeat(64));
  });

  it('reads a legacy kens record on the un-migrated kens rail', async () => {
    const backend = makeBackend();
    relayMock.fetchReturns[RELAY] = [{
      id: '2'.repeat(64), created_at: 3000,
      content: fakeNip44(JSON.stringify({ v: 1, kens: [] })),
    }];
    const result = await fetchKensSync(AUTHOR, backend, RELAY);
    expect(result).not.toBeNull();
    expect(result!.kens).toEqual([]);
    expect(result!.createdAt).toBe(3000);
  });

  it('reads a v2 kens record too', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload(JSON.stringify({ v: 1, kens: [] }), backend))!;
    relayMock.fetchReturns[RELAY] = [{ id: '3'.repeat(64), created_at: 4000, content: sealed }];
    const result = await fetchKensSync(AUTHOR, backend, RELAY);
    expect(result).not.toBeNull();
    expect(result!.createdAt).toBe(4000);
  });

  it('treats an unopenable record as nothing found, never a throw', async () => {
    const backend = makeBackend();
    relayMock.fetchReturns[RELAY] = [{ id: '4'.repeat(64), created_at: 2000, content: 'garbage-not-our-format' }];
    await expect(fetchContactsSync(AUTHOR, backend, [RELAY])).resolves.toBeNull();
    // Junk never reached the signer — the shape gate refused it first.
    expect((backend as unknown as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls).toHaveLength(0);
  });
});
