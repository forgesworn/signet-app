/**
 * Cross-repo parity with `@forgesworn/signet-contacts` (R-4, task 23).
 *
 * `signet-contacts/src/wire/envelope.ts` is a byte-for-byte mirror of this
 * app's `vault-envelope.ts` — same wire shape, same padding buckets, same
 * length prefix. Its own test suite freezes a vector
 * (`vectors/envelope.v2.json`) sealed with REAL NIP-44 primitives (not the
 * fake reversible backend `vault-envelope.test.ts` uses to isolate the
 * padding/framing logic from the crypto) and ships it in the published
 * package. This file proves the two implementations agree on the wire in
 * both directions:
 *
 *   1. the app's own `openVaultPayload` can open an envelope the SDK sealed,
 *      using the app's own `LocalSigningBackend` on the vector's `appSecretKey`
 *      — no bespoke test backend on the OPEN leg, decrypt is decrypt.
 *   2. the app's own `sealVaultPayload`, given the SAME injected randomness
 *      and the SAME fixed inner NIP-44 nonce the SDK's vector generator used,
 *      reproduces the vector's `sealed` string byte for byte.
 *
 * The vector is read from the installed package by path (a JSON file is not
 * exported via the package's `exports` map, and the `file:` install is a
 * symlink `readFileSync` follows) — same pattern as
 * `contacts-sdk-smoke.test.ts`'s R-6 sanitiser parity check.
 *
 * `railSecretKey` / `appSecretKey` in the vector are TEST KEYS ONLY, minted
 * once by the SDK's vector generator and hardcoded there for reproducibility
 * — never reused for anything real.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getConversationKey, v2 as nip44v2 } from 'nostr-tools/nip44';
import { hexToBytes } from '@noble/hashes/utils.js';
import { openVaultPayload, sealVaultPayload } from './vault-envelope';
import type { SealBackend } from './vault-envelope';
import { LocalSigningBackend } from './signing-backend';

interface EnvelopeVector {
  railSecretKey: string;
  appSecretKey: string;
  railPubkey: string;
  appPubkey: string;
  plaintext: string;
  sealed: string;
}

/**
 * Fresh xorshift32 stream from a fixed seed — the SAME generator shape the
 * SDK's `vectors.test.ts` uses for `sealVaultPayload`'s injected `opts.random`,
 * so two independent instances started from the same seed produce byte
 * identical output. Re-implemented here rather than imported: it is 8 lines
 * of test-only scaffolding, not part of either package's public surface.
 */
function makeDeterministicRandom(seed: number): (bytes: number) => Uint8Array<ArrayBuffer> {
  let state = seed >>> 0;
  return (n: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17; state >>>= 0;
      state ^= state << 5; state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}
const SEED = 0x5e17ed42;

// Fixed 32-byte NIP-44 nonce, matching the vector generator's
// `NIP44_TEST_NONCE`. Real `sealVaultPayload` callers never see this — the
// nonce lives inside `backend.nip44Encrypt`, and `LocalSigningBackend`'s own
// implementation draws a fresh random one per call, which is why the SEAL
// leg of this test needs a bespoke `SealBackend` wired to the raw
// `nostr-tools/nip44` primitives instead.
const NIP44_TEST_NONCE = hexToBytes('11'.repeat(32));

describe('vault-envelope — vector parity with @forgesworn/signet-contacts (R-4)', () => {
  const vector = JSON.parse(readFileSync(
    'node_modules/@forgesworn/signet-contacts/vectors/envelope.v2.json', 'utf8',
  )) as EnvelopeVector;

  it('opens the SDK-sealed vector with the app\'s own openVaultPayload, via a real LocalSigningBackend', async () => {
    const app = new LocalSigningBackend(vector.appSecretKey);
    expect(app.activePublicKeyHex).toBe(vector.appPubkey);

    const opened = await openVaultPayload(
      vector.sealed,
      app,
      vector.railPubkey,
      { legacyFallback: false },
    );
    expect(opened).toBe(vector.plaintext);
  });

  it('reproduces the vector\'s sealed envelope byte for byte with injected randomness (opts.random)', async () => {
    // `LocalSigningBackend.nip44Encrypt` cannot be handed a fixed nonce (it
    // draws one internally via `nostr-tools`), so the SEAL leg needs a
    // backend that calls the raw `v2.encrypt`/`getConversationKey` primitives
    // directly — exactly what the SDK's own vector generator does. This is
    // the only place in this file that does not go through the app's normal
    // signing-backend surface, and only because reproducing a frozen fixture
    // byte for byte requires pinning the one source of randomness
    // `sealVaultPayload` does not already accept as a parameter.
    const railSecretKey = hexToBytes(vector.railSecretKey);
    const railBackend: SealBackend = {
      activePublicKeyHex: vector.railPubkey,
      async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
        const conversationKey = getConversationKey(railSecretKey, peerPubkey);
        return nip44v2.encrypt(plaintext, conversationKey, NIP44_TEST_NONCE);
      },
    };

    const sealed = await sealVaultPayload(vector.plaintext, railBackend, {
      recipientPubkey: vector.appPubkey,
      random: makeDeterministicRandom(SEED),
    });
    expect(sealed).toBe(vector.sealed);

    // And a fresh instance of the same deterministic randomness is
    // idempotent — proves the match above is not a coincidence of shared
    // generator state.
    const resealed = await sealVaultPayload(vector.plaintext, railBackend, {
      recipientPubkey: vector.appPubkey,
      random: makeDeterministicRandom(SEED),
    });
    expect(resealed).toBe(vector.sealed);
  });
});
