import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyEvent } from 'signet-protocol';
import { generateSecretKey, getPublicKey, verifyEvent as verifyNostrEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigningBackend, BunkerSigningBackend, createLocalBackends, createLocalBackendsFromKeyMaterial, RELAY_READY_CAP_MS } from './signing-backend';

// Deterministic test fixture derived from the standard BIP-39 all-zeros mnemonic.
// Do not change these values — they are stable cross-environment fixtures.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Pre-derived values from the mnemonic above (natural-person path).
const NP_PRIVKEY_HEX = '7ad182ece38995010513cf6940186fe49354603a895c3ea71e48bcf21388514c';
const NP_PUBKEY_HEX  = '7964f124878b3528f1e1c3e946512f340d761a29a9d1d5a445faa5a2ebd62574';

// Pre-derived values for the persona path.
const PERSONA_PUBKEY_HEX  = 'c230e979e698e8e67068c8e3061eb0bf136e8e96ff81e3c1ceb133961eda40af';
const STORED_PERSONA_PRIVKEY_HEX = '2'.repeat(64);

describe('LocalSigningBackend', () => {
  describe('constructor / activePublicKeyHex', () => {
    it('derives the correct public key from a known private key', () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      expect(backend.activePublicKeyHex).toBe(NP_PUBKEY_HEX);
    });

    it('exposes type "local"', () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      expect(backend.type).toBe('local');
    });
  });

  describe('signEvent', () => {
    it('returns an event with all required NIP-01 fields', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const template = {
        pubkey: NP_PUBKEY_HEX,
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'hello signet',
      };
      const signed = await backend.signEvent(template);

      expect(signed).toHaveProperty('id');
      expect(signed).toHaveProperty('pubkey');
      expect(signed).toHaveProperty('sig');
      expect(signed).toHaveProperty('kind');
      expect(signed).toHaveProperty('created_at');
      expect(signed).toHaveProperty('tags');
      expect(signed).toHaveProperty('content');
    });

    it('sets pubkey to the backend public key', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const template = {
        pubkey: NP_PUBKEY_HEX,
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: '',
      };
      const signed = await backend.signEvent(template);
      expect(signed.pubkey).toBe(NP_PUBKEY_HEX);
    });

    it('signs NIP-46 templates that omit pubkey using the backend public key', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const signed = await backend.signEvent({
        kind: 25519,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', 'f'.repeat(64)]],
        content: 'relay invite request',
      } as Parameters<LocalSigningBackend['signEvent']>[0]);

      expect(signed.pubkey).toBe(NP_PUBKEY_HEX);
      expect(verifyNostrEvent(signed as Parameters<typeof verifyNostrEvent>[0])).toBe(true);
    });

    it('fills empty template pubkeys with the backend public key', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const emptyPubkey = await backend.signEvent({
        pubkey: '',
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'empty pubkey from NIP-46 parser',
      });

      expect(emptyPubkey.pubkey).toBe(NP_PUBKEY_HEX);
      expect(verifyNostrEvent(emptyPubkey as Parameters<typeof verifyNostrEvent>[0])).toBe(true);
    });

    it('rejects templates that explicitly request a different pubkey', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);

      await expect(backend.signEvent({
        pubkey: 'f'.repeat(64),
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'wrong pubkey from caller',
      })).rejects.toThrow('Cannot sign event for a different pubkey.');
    });

    it('produces a cryptographically valid Schnorr signature', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const template = {
        pubkey: NP_PUBKEY_HEX,
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'verification test',
      };
      const signed = await backend.signEvent(template);
      const valid = await verifyEvent(signed);
      expect(valid).toBe(true);
    });

    it('id is a 64-char lowercase hex string', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const template = {
        pubkey: NP_PUBKEY_HEX,
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: '',
      };
      const signed = await backend.signEvent(template);
      expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sig is a 128-char lowercase hex string', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const template = {
        pubkey: NP_PUBKEY_HEX,
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: '',
      };
      const signed = await backend.signEvent(template);
      expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    });

    it('preserves the event kind, content, and tags from the template', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const tags = [['t', 'signet'], ['p', NP_PUBKEY_HEX]];
      const template = {
        pubkey: NP_PUBKEY_HEX,
        kind: 29999,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: 'credential payload',
      };
      const signed = await backend.signEvent(template);
      expect(signed.kind).toBe(29999);
      expect(signed.content).toBe('credential payload');
      expect(signed.tags).toEqual(tags);
    });

    it('each signing call produces a unique event id', async () => {
      // created_at differs between calls since time advances, but even at the
      // same second a different nonce in the Schnorr signing must yield a unique id.
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const now = Math.floor(Date.now() / 1000);
      const t1 = await backend.signEvent({ pubkey: NP_PUBKEY_HEX, kind: 1, created_at: now, tags: [], content: 'a' });
      const t2 = await backend.signEvent({ pubkey: NP_PUBKEY_HEX, kind: 1, created_at: now + 1, tags: [], content: 'b' });
      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe('destroy', () => {
    it('zeroises the private key (subsequent signs may fail or produce garbage)', async () => {
      const backend = new LocalSigningBackend(NP_PRIVKEY_HEX);
      backend.destroy();
      // After destroy the private key is 64 zeroes — signing should throw
      // because 0x0000...0000 is not a valid secp256k1 scalar.
      await expect(
        backend.signEvent({ pubkey: NP_PUBKEY_HEX, kind: 1, created_at: 0, tags: [], content: '' }),
      ).rejects.toThrow();
    });
  });

  describe('nip44 encrypt / decrypt', () => {
    // Build a second backend with a fresh random key to play the "Bob" role.
    function makeBob(): { backend: LocalSigningBackend; pubkey: string } {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      const backend = new LocalSigningBackend(bytesToHex(sk));
      sk.fill(0);
      return { backend, pubkey: pk };
    }

    it('Alice encrypts to Bob, Bob decrypts and recovers plaintext', async () => {
      const alice = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const { backend: bob, pubkey: bobPubkey } = makeBob();

      const plaintext = 'hello from alice';
      const ciphertext = await alice.nip44Encrypt(bobPubkey, plaintext);
      const decrypted = await bob.nip44Decrypt(alice.activePublicKeyHex, ciphertext);

      expect(decrypted).toBe(plaintext);
      alice.destroy();
      bob.destroy();
    });

    it('Bob encrypts to Alice, Alice decrypts — symmetric per NIP-44 conversation key', async () => {
      const alice = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const { backend: bob, pubkey: bobPubkey } = makeBob();

      const plaintext = 'reply from bob';
      const ciphertext = await bob.nip44Encrypt(alice.activePublicKeyHex, plaintext);
      const decrypted = await alice.nip44Decrypt(bobPubkey, ciphertext);

      expect(decrypted).toBe(plaintext);
      alice.destroy();
      bob.destroy();
    });

    it('decrypt with the wrong peer key throws', async () => {
      const alice = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const { backend: bob, pubkey: bobPubkey } = makeBob();
      const { backend: carol } = makeBob();

      const ciphertext = await alice.nip44Encrypt(bobPubkey, 'secret');
      // Carol's private key + Alice's pubkey ≠ Alice–Bob conversation key.
      await expect(
        carol.nip44Decrypt(alice.activePublicKeyHex, ciphertext),
      ).rejects.toThrow();

      alice.destroy();
      bob.destroy();
      carol.destroy();
    });

    it('preserves unicode content across the roundtrip', async () => {
      const alice = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const { backend: bob, pubkey: bobPubkey } = makeBob();

      const plaintext = 'emoji 🔑 и немного kanji 鍵';
      const ciphertext = await alice.nip44Encrypt(bobPubkey, plaintext);
      const decrypted = await bob.nip44Decrypt(alice.activePublicKeyHex, ciphertext);

      expect(decrypted).toBe(plaintext);
      alice.destroy();
      bob.destroy();
    });

    it('decrypting after destroy throws', async () => {
      const alice = new LocalSigningBackend(NP_PRIVKEY_HEX);
      const { backend: bob, pubkey: bobPubkey } = makeBob();
      const ciphertext = await alice.nip44Encrypt(bobPubkey, 'will-fail');
      bob.destroy();
      await expect(
        bob.nip44Decrypt(alice.activePublicKeyHex, ciphertext),
      ).rejects.toThrow();
      alice.destroy();
    });
  });
});

describe('createLocalBackends', () => {
  it('derives natural-person backend with the correct public key', () => {
    const { naturalPerson } = createLocalBackends(TEST_MNEMONIC);
    expect(naturalPerson.activePublicKeyHex).toBe(NP_PUBKEY_HEX);
    naturalPerson.destroy();
  });

  it('derives persona backend with the correct public key', () => {
    const { persona } = createLocalBackends(TEST_MNEMONIC);
    expect(persona.activePublicKeyHex).toBe(PERSONA_PUBKEY_HEX);
    persona.destroy();
  });

  it('natural-person and persona public keys are distinct', () => {
    const { naturalPerson, persona } = createLocalBackends(TEST_MNEMONIC);
    expect(naturalPerson.activePublicKeyHex).not.toBe(persona.activePublicKeyHex);
    naturalPerson.destroy();
    persona.destroy();
  });

  it('derivation is deterministic — same mnemonic produces same keys', () => {
    const first  = createLocalBackends(TEST_MNEMONIC);
    const second = createLocalBackends(TEST_MNEMONIC);
    expect(first.naturalPerson.activePublicKeyHex).toBe(second.naturalPerson.activePublicKeyHex);
    expect(first.persona.activePublicKeyHex).toBe(second.persona.activePublicKeyHex);
    first.naturalPerson.destroy();
    first.persona.destroy();
    second.naturalPerson.destroy();
    second.persona.destroy();
  });

  it('professional backend is deterministic + distinct from NP/persona (single-tree refactor regression lock — 2026-06-15)', () => {
    // The Pro key is now derived from the first tree's root before destroy.
    // Lock its determinism + distinctness so that refactor can't silently
    // change the Pro key (which would orphan a user's Pro-surface identity).
    const a = createLocalBackends(TEST_MNEMONIC);
    const b = createLocalBackends(TEST_MNEMONIC);
    expect(a.professional.activePublicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.professional.activePublicKeyHex).toBe(b.professional.activePublicKeyHex);
    expect(a.professional.activePublicKeyHex).not.toBe(a.naturalPerson.activePublicKeyHex);
    expect(a.professional.activePublicKeyHex).not.toBe(a.persona.activePublicKeyHex);
    a.naturalPerson.destroy(); a.persona.destroy(); a.professional.destroy();
    b.naturalPerson.destroy(); b.persona.destroy(); b.professional.destroy();
  });

  it('natural-person backend produces a verifiable signed event', async () => {
    const { naturalPerson } = createLocalBackends(TEST_MNEMONIC);
    const pubkey = naturalPerson.activePublicKeyHex;
    const signed = await naturalPerson.signEvent({
      pubkey,
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'createLocalBackends natural-person test',
    });
    expect(await verifyEvent(signed)).toBe(true);
    naturalPerson.destroy();
  });

  it('persona backend produces a verifiable signed event', async () => {
    const { persona } = createLocalBackends(TEST_MNEMONIC);
    const pubkey = persona.activePublicKeyHex;
    const signed = await persona.signEvent({
      pubkey,
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'createLocalBackends persona test',
    });
    expect(await verifyEvent(signed)).toBe(true);
    persona.destroy();
  });

  it('returns backends with type "local"', () => {
    const { naturalPerson, persona } = createLocalBackends(TEST_MNEMONIC);
    expect(naturalPerson.type).toBe('local');
    expect(persona.type).toBe('local');
    naturalPerson.destroy();
    persona.destroy();
  });

  it('natural-person private key hex is distinct from the expected persona private key hex', () => {
    // Indirect check: different pubkeys imply different privkeys were derived.
    const { naturalPerson, persona } = createLocalBackends(TEST_MNEMONIC);
    expect(naturalPerson.activePublicKeyHex).toBe(NP_PUBKEY_HEX);
    expect(persona.activePublicKeyHex).toBe(PERSONA_PUBKEY_HEX);
    naturalPerson.destroy();
    persona.destroy();
  });
});

describe('createLocalBackendsFromKeyMaterial', () => {
  it('prefers stored slot keys over mnemonic-derived Persona keys', () => {
    const backends = createLocalBackendsFromKeyMaterial({
      naturalPersonPrivateKey: NP_PRIVKEY_HEX,
      personaPrivateKey: STORED_PERSONA_PRIVKEY_HEX,
      mnemonicForProfessional: TEST_MNEMONIC,
    });

    expect(backends).not.toBeNull();
    expect(backends!.naturalPerson.activePublicKeyHex).toBe(NP_PUBKEY_HEX);
    expect(backends!.persona.activePublicKeyHex).toBe(getPublicKey(hexToBytes(STORED_PERSONA_PRIVKEY_HEX)));
    expect(backends!.persona.activePublicKeyHex).not.toBe(PERSONA_PUBKEY_HEX);
    expect(backends!.professional?.activePublicKeyHex).toMatch(/^[0-9a-f]{64}$/);

    backends!.naturalPerson.destroy();
    backends!.persona.destroy();
    backends!.professional?.destroy();
  });
});

describe('BunkerSigningBackend constructor validation', () => {
  it('rejects empty clientSecretHex', () => {
    expect(() => new BunkerSigningBackend('')).toThrow(/expected 64-char hex/);
  });

  it('rejects short hex', () => {
    expect(() => new BunkerSigningBackend('abcd1234')).toThrow(/length 8/);
  });

  it('rejects non-hex characters', () => {
    const nonHex = 'z'.repeat(64);
    expect(() => new BunkerSigningBackend(nonHex)).toThrow(/expected 64-char hex/);
  });

  it('rejects uppercase hex (LocalSigningBackend parity)', () => {
    const upper = '7AD182ECE38995010513CF6940186FE49354603A895C3EA71E48BCF21388514C';
    expect(() => new BunkerSigningBackend(upper)).toThrow(/expected 64-char hex/);
  });

  it('does not echo the candidate key in the error message', () => {
    const secret = 'deadbeef'.repeat(8); // valid hex, but only 64 chars
    try {
      new BunkerSigningBackend(secret + 'extra');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('deadbeef');
    }
  });

  it('accepts a valid 64-char hex secret', () => {
    const valid = 'deadbeef'.repeat(8);
    expect(() => new BunkerSigningBackend(valid)).not.toThrow();
  });
});

/**
 * `BunkerSigningBackend.connect` stores whatever the remote signer answers to
 * `get_public_key`. NIP-46 does not oblige a signer to answer in lowercase,
 * and everything downstream — the vault envelope's strict-lowercase seal
 * guard, route lookups keyed by pubkey, `===` comparisons against locally
 * derived keys — treats this field as canonical 64-hex lowercase. So the
 * backend normalises on the way in, exactly as `RoutedBunkerSigningBackend`
 * does in `bunker-router.ts`.
 *
 * `nostr-tools/nip46` is mocked for this block only; nothing else in this file
 * touches it (every other test here is `LocalSigningBackend` or
 * `createLocalBackends`, neither of which imports a bunker signer).
 */
const bunkerMock = vi.hoisted(() => ({
  /** What the fake remote signer answers to `get_public_key`. */
  pubkeyReply: '',
  /** Requests the fake signer was asked to send. */
  sent: [] as string[],
  /** Fake signers closed. */
  closed: 0,
}));

vi.mock('nostr-tools/nip46', () => ({
  parseBunkerInput: async () => ({
    pubkey: 'b'.repeat(64),
    relays: ['wss://relay.example'],
    secret: 'pairing-secret',
  }),
  BunkerSigner: {
    fromBunker: () => ({
      getPublicKey: async () => { bunkerMock.sent.push('get_public_key'); return bunkerMock.pubkeyReply; },
      sendRequest: async (method: string) => { bunkerMock.sent.push(method); return 'ack'; },
      close: async () => { bunkerMock.closed += 1; },
    }),
  },
}));

/** Fake relay pool: the probe subscription EOSEs on the next tick unless
 * `silent`, in which case it never answers and only the cap releases it. */
const poolMock = vi.hoisted(() => ({
  silent: false,
  probeFilters: [] as unknown[],
  probesClosed: 0,
  destroyed: 0,
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    subscribe(_relays: string[], filter: unknown, params: { oneose?: () => void }) {
      poolMock.probeFilters.push(filter);
      if (!poolMock.silent) setTimeout(() => params.oneose?.(), 0);
      return { close: () => { poolMock.probesClosed += 1; } };
    }
    destroy() { poolMock.destroyed += 1; }
  },
}));

/**
 * `BunkerSigningBackend.vaultBackend` caching tests mock `./heartwood-vault`
 * entirely. `HeartwoodVaultBackend.fromResolvedPubkey` is reimplemented to
 * run the same hex-format + identityPubkeys exclusion check the real one
 * does, synchronously and with no RPC — so a call into it never touches
 * `heartwoodVaultRequest` — and `heartwoodVaultRequest` is the only path
 * that records an RPC. Counting its calls (filtered by method, since a
 * returned instance's own nip44Decrypt/etc. also go through it) is
 * therefore equivalent to counting Heartwood round trips, without needing to
 * also drive the NIP-46/relay plumbing `heartwoodVaultRequest` itself would
 * otherwise touch (that's covered separately in heartwood-vault.test.ts).
 */
const heartwoodVaultMock = vi.hoisted(() => ({
  rpcCalls: [] as string[],
  shouldReject: false,
  nextPubkey: 'a'.repeat(64),
  /** When set, the next `get_public_key` call awaits this before resolving —
   * lets a test hold a resolution in flight across a generation bump. */
  gate: null as Promise<void> | null,
}));

function getPublicKeyRpcCount(): number {
  return heartwoodVaultMock.rpcCalls.filter(m => m === 'get_public_key').length;
}

vi.mock('./heartwood-vault', () => ({
  HeartwoodVaultBackend: {
    fromResolvedPubkey: vi.fn((pubkey: string, context: unknown, rpc: (m: string, p: string[], c: unknown) => Promise<string>, identityPubkeys: string[]) => {
      if (!/^[0-9a-f]{64}$/.test(pubkey) || identityPubkeys.includes(pubkey)) throw new Error('Signer did not resolve a dedicated vault key');
      let destroyed = false;
      return {
        type: 'bunker' as const,
        activePublicKeyHex: pubkey,
        nip44Decrypt: async (peer: string, ciphertext: string) => {
          if (destroyed) throw new Error('Vault backend destroyed');
          return rpc('nip44_decrypt', [peer, ciphertext], context);
        },
        destroy: () => { destroyed = true; },
      };
    }),
  },
  heartwoodVaultRequest: vi.fn(async (args: { method: string }) => {
    heartwoodVaultMock.rpcCalls.push(args.method);
    if (heartwoodVaultMock.gate) { await heartwoodVaultMock.gate; heartwoodVaultMock.gate = null; }
    if (args.method === 'get_public_key' && heartwoodVaultMock.shouldReject) throw new Error('vault create rejected');
    return heartwoodVaultMock.nextPubkey;
  }),
}));

describe('BunkerSigningBackend reply-subscription readiness', () => {
  const CANONICAL = 'cd'.repeat(32);
  const CLIENT_SECRET = 'a'.repeat(64);

  beforeEach(() => {
    bunkerMock.pubkeyReply = CANONICAL;
    poolMock.silent = false;
    poolMock.probeFilters = [];
    poolMock.probesClosed = 0;
    poolMock.destroyed = 0;
  });

  it('connects as soon as the reply subscription is live, not after a fixed wait', async () => {
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      let connected = false;
      const connecting = backend.connect('bunker://x?relay=wss://relay.example').then(() => { connected = true; });
      await vi.advanceTimersByTimeAsync(10);
      expect(connected).toBe(true);
      await connecting;
    } finally {
      vi.useRealTimers();
    }
    expect(backend.activePublicKeyHex).toBe(CANONICAL);
    // The probe mirrors the signer's own reply filter, then is closed.
    expect(poolMock.probeFilters).toEqual([{
      kinds: [24133],
      authors: ['b'.repeat(64)],
      '#p': [backend.transportClientPubkeyHex],
      limit: 0,
    }]);
    expect(poolMock.probesClosed).toBe(1);
  });

  it('proceeds after RELAY_READY_CAP_MS when a relay never answers the probe', async () => {
    poolMock.silent = true;
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      let connected = false;
      const connecting = backend.connect('bunker://x?relay=wss://relay.example').then(() => { connected = true; });
      await vi.advanceTimersByTimeAsync(RELAY_READY_CAP_MS - 1);
      expect(connected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await connecting;
    } finally {
      vi.useRealTimers();
    }
    expect(backend.activePublicKeyHex).toBe(CANONICAL);
    expect(poolMock.probesClosed).toBe(1);
  });

  it('a destroy during the readiness wait cancels the connect cleanly and sends nothing', async () => {
    poolMock.silent = true;
    bunkerMock.sent = [];
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      const connecting = backend.connect('bunker://x?relay=wss://relay.example');
      const outcome = connecting.then(() => 'resolved', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(100);
      backend.destroy();
      await vi.advanceTimersByTimeAsync(RELAY_READY_CAP_MS);
      expect(await outcome).toBe('Connection cancelled');
    } finally {
      vi.useRealTimers();
    }
    expect(bunkerMock.sent).toEqual([]);
    expect(poolMock.destroyed).toBeGreaterThanOrEqual(1);
    expect(backend.activePublicKeyHex).toBe('');
  });

  it('a timed-out connect releases its sockets and never completes later', async () => {
    poolMock.silent = true;
    bunkerMock.sent = [];
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      const connecting = backend.connect('bunker://x?relay=wss://relay.example', 1_000);
      const outcome = connecting.then(() => 'resolved', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toBe('Connection timed out');
      expect(poolMock.destroyed).toBe(1);
      // The abandoned attempt reaches its next checkpoint and stops there.
      await vi.advanceTimersByTimeAsync(RELAY_READY_CAP_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(bunkerMock.sent).toEqual([]);
    expect(backend.activePublicKeyHex).toBe('');
  });

  it('closes its relay sockets on destroy', async () => {
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    await backend.connect('bunker://x?relay=wss://relay.example');
    backend.destroy();
    expect(poolMock.destroyed).toBe(1);
  });
});

describe('BunkerSigningBackend pubkey normalisation', () => {
  const CANONICAL = 'ab'.repeat(32);
  const CLIENT_SECRET = 'a'.repeat(64);

  /** Drive `connect` past its reply-subscription readiness wait on fake timers. */
  async function connectWith(reply: string): Promise<BunkerSigningBackend> {
    bunkerMock.pubkeyReply = reply;
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      const connecting = backend.connect('bunker://x?relay=wss://relay.example');
      await vi.advanceTimersByTimeAsync(RELAY_READY_CAP_MS);
      await connecting;
    } finally {
      vi.useRealTimers();
    }
    return backend;
  }

  it('lowercases an uppercase pubkey the signer reports', async () => {
    const backend = await connectWith(CANONICAL.toUpperCase());
    expect(backend.activePublicKeyHex).toBe(CANONICAL);
    expect(backend.activePublicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('trims surrounding whitespace', async () => {
    const backend = await connectWith(`  ${CANONICAL}\n`);
    expect(backend.activePublicKeyHex).toBe(CANONICAL);
  });

  it('leaves an already-canonical pubkey untouched', async () => {
    const backend = await connectWith(CANONICAL);
    expect(backend.activePublicKeyHex).toBe(CANONICAL);
  });

  it('still pins the identity case-insensitively on reconnect', async () => {
    // The mismatch guard compares, it does not store: an uppercase reply must
    // still satisfy a lowercase `expectedPubkey`, and the stored value is the
    // normalised one.
    bunkerMock.pubkeyReply = CANONICAL.toUpperCase();
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      const connecting = backend.reconnect('bunker://x?relay=wss://relay.example', 30_000, CANONICAL);
      await vi.advanceTimersByTimeAsync(RELAY_READY_CAP_MS);
      await connecting;
    } finally {
      vi.useRealTimers();
    }
    expect(backend.activePublicKeyHex).toBe(CANONICAL);
  });
});

describe('BunkerSigningBackend.vaultBackend caching', () => {
  const CLIENT_SECRET = 'e'.repeat(64);
  const CANONICAL = 'cd'.repeat(32);

  async function connectedBackend(): Promise<BunkerSigningBackend> {
    bunkerMock.pubkeyReply = CANONICAL;
    poolMock.silent = false;
    const backend = new BunkerSigningBackend(CLIENT_SECRET);
    await backend.connect('bunker://x?relay=wss://relay.example');
    return backend;
  }

  beforeEach(() => {
    heartwoodVaultMock.rpcCalls = [];
    heartwoodVaultMock.shouldReject = false;
    heartwoodVaultMock.nextPubkey = 'a'.repeat(64);
    heartwoodVaultMock.gate = null;
  });

  it('two sequential resolves of the same context return DISTINCT instances, sharing one get_public_key RPC', async () => {
    const backend = await connectedBackend();
    const first = await backend.vaultBackend('profiles', 0, []);
    const second = await backend.vaultBackend('profiles', 0, []);
    expect(second).not.toBe(first);
    expect(second.activePublicKeyHex).toBe(first.activePublicKeyHex);
    expect(getPublicKeyRpcCount()).toBe(1);
  });

  it('destroying the first instance leaves the second usable — its own calls still forward to rpc', async () => {
    const backend = await connectedBackend();
    const first = await backend.vaultBackend('profiles', 0, []);
    const second = await backend.vaultBackend('profiles', 0, []);
    first.destroy();
    await expect(first.nip44Decrypt(first.activePublicKeyHex, 'x')).rejects.toThrow('destroyed');
    await expect(second.nip44Decrypt(second.activePublicKeyHex, 'x')).resolves.toBe(heartwoodVaultMock.nextPubkey);
  });

  it('a different rotation issues a second RPC', async () => {
    const backend = await connectedBackend();
    await backend.vaultBackend('profiles', 0, []);
    await backend.vaultBackend('profiles', 1, []);
    expect(getPublicKeyRpcCount()).toBe(2);
  });

  it('concurrent resolves for the same context share one RPC (still distinct instances)', async () => {
    const backend = await connectedBackend();
    const [a, b] = await Promise.all([
      backend.vaultBackend('profiles', 0, []),
      backend.vaultBackend('profiles', 0, []),
    ]);
    expect(b).not.toBe(a);
    expect(b.activePublicKeyHex).toBe(a.activePublicKeyHex);
    expect(getPublicKeyRpcCount()).toBe(1);
  });

  it('a rejected resolution is not cached — the next call retries', async () => {
    const backend = await connectedBackend();
    heartwoodVaultMock.shouldReject = true;
    await expect(backend.vaultBackend('profiles', 0, [])).rejects.toThrow('vault create rejected');
    heartwoodVaultMock.shouldReject = false;
    await backend.vaultBackend('profiles', 0, []);
    expect(getPublicKeyRpcCount()).toBe(2);
  });

  it('the exclusion check runs on every call, including a cache hit', async () => {
    const backend = await connectedBackend();
    const first = await backend.vaultBackend('profiles', 0, []);
    // A cache hit for the same context, but this call's own identityPubkeys
    // now names the already-resolved pubkey — must still reject.
    await expect(backend.vaultBackend('profiles', 0, [first.activePublicKeyHex])).rejects.toThrow('dedicated vault');
    // Only one RPC was ever issued — the exclusion check ran without a retry.
    expect(getPublicKeyRpcCount()).toBe(1);
  });

  it('destroying a resolved instance does not evict the cached pubkey — the next resolve issues no new RPC', async () => {
    const backend = await connectedBackend();
    const first = await backend.vaultBackend('profiles', 0, []);
    first.destroy();
    await backend.vaultBackend('profiles', 0, []);
    expect(getPublicKeyRpcCount()).toBe(1);
  });

  it('after destroy(), a new resolve issues a new RPC', async () => {
    const backend = await connectedBackend();
    await backend.vaultBackend('profiles', 0, []);
    backend.destroy();
    bunkerMock.pubkeyReply = CANONICAL;
    await backend.connect('bunker://x?relay=wss://relay.example');
    await backend.vaultBackend('profiles', 0, []);
    expect(getPublicKeyRpcCount()).toBe(2);
  });

  it('a reconnect (signer replaced) bumps the generation even without an explicit destroy()', async () => {
    const backend = await connectedBackend();
    await backend.vaultBackend('profiles', 0, []);
    bunkerMock.pubkeyReply = CANONICAL;
    await backend.connect('bunker://x?relay=wss://relay.example');
    await backend.vaultBackend('profiles', 0, []);
    expect(getPublicKeyRpcCount()).toBe(2);
  });

  it('a resolution in flight when the generation bumps is not kept for a later, post-bump caller', async () => {
    const backend = await connectedBackend();
    let releaseGate: () => void = () => {};
    heartwoodVaultMock.gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const firstCall = backend.vaultBackend('profiles', 0, []);
    // Let the in-flight resolution actually reach and register its RPC
    // before the pairing changes underneath it.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getPublicKeyRpcCount()).toBe(1);

    backend.destroy(); // bumps the generation (transport released)
    bunkerMock.pubkeyReply = CANONICAL;
    await backend.connect('bunker://x?relay=wss://relay.example'); // bumps it again after the new pairing commits

    releaseGate();
    await firstCall; // the original caller still gets its answer; it just must not be cached under the new pairing

    const before = getPublicKeyRpcCount();
    await backend.vaultBackend('profiles', 0, []);
    expect(getPublicKeyRpcCount()).toBe(before + 1);
  });
});
