import { signEvent, createSignetIdentity as _createSignetIdentity, destroyIdentity as _destroyIdentity, deriveAdditionalPersona as _deriveAdditionalPersona } from 'signet-protocol';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import { encrypt as nip04EncryptRaw, decrypt as nip04DecryptRaw } from 'nostr-tools/nip04';
import { vaultKeyContext } from 'signet-protocol/experimental';
import { waitForReplySubscription, RELAY_READY_CAP_MS } from './relay-ready';

// Re-exported so existing importers of RELAY_READY_CAP_MS from this module
// keep working — the readiness helper itself now lives in relay-ready.ts,
// shared with heartwood-vault.ts's own reply-subscription wait.
export { RELAY_READY_CAP_MS };

// Re-export the interface from signet-protocol for cross-implementation compatibility
import type { SigningBackend as _SigningBackend, SigningMode as _SigningMode } from 'signet-protocol';
export type SigningBackend = _SigningBackend;
export type SigningMode = _SigningMode;

/**
 * signet-app-local extension of the protocol's SigningBackend surface.
 *
 * The protocol interface is send-only (signEvent + nip44Encrypt). NIP-44
 * decrypt is required for the phone to act as a NIP-46 *server* (handle
 * inbound sign_event / nip44_encrypt / nip44_decrypt requests from other
 * apps). That's an app-level concern — Heartwood and other signers in
 * the ecosystem don't need it to be in the protocol interface.
 *
 * Kept local here to avoid a signet-protocol version bump for a purely
 * app-side capability.
 */
export interface DecryptingSigningBackend extends SigningBackend {
  /**
   * Encrypt/decrypt legacy NIP-04 payloads. Optional because not every
   * external backend exposes it; the NIP-46 server returns a clear policy
   * error when the active backend cannot serve these methods.
   */
  nip04Encrypt?(recipientPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;
  /**
   * Decrypt a NIP-44 v2 ciphertext sent to the active pubkey by
   * `senderPubkey`. Throws if the backend cannot decrypt (e.g. NIP-07
   * extension that doesn't expose `nip44.decrypt`).
   */
  nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
  /**
   * For a backend that signs by sending NIP-46 requests to a remote signer:
   * the pubkey those requests are authored by (this app's client key). The
   * app's own NIP-46 server must never treat them as inbound requests — on a
   * shared relay a served route whose key lives on the signer would
   * otherwise receive its own outgoing requests and answer each one with
   * more requests.
   */
  readonly transportClientPubkeyHex?: string;
}

export class LocalSigningBackend implements DecryptingSigningBackend {
  readonly type = 'local' as const;
  readonly activePublicKeyHex: string;
  private privateKeyHex: string;

  constructor(privateKeyHex: string) {
    if (!privateKeyHex || !/^[0-9a-f]{64}$/.test(privateKeyHex)) {
      // Do NOT echo any of the candidate key material. Even 16 chars of
      // what was *meant* to be a private key can end up in toasts, crash
      // telemetry, or the React error overlay. Length-only is enough to
      // diagnose accidental-empty vs accidental-wrong-case vs truncation.
      const length = privateKeyHex ? privateKeyHex.length : 0;
      throw new Error(`Invalid private key: expected 64-char hex, got length ${length}`);
    }
    this.privateKeyHex = privateKeyHex;
    this.activePublicKeyHex = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    const requestedPubkey = typeof event.pubkey === 'string' ? event.pubkey.trim().toLowerCase() : '';
    if (requestedPubkey && requestedPubkey !== this.activePublicKeyHex) {
      throw new Error('Cannot sign event for a different pubkey.');
    }
    return signEvent({ ...event, pubkey: this.activePublicKeyHex }, this.privateKeyHex);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const nip46 = await import('./nip46');
    return nip46.nip44Encrypt(this.privateKeyHex, recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const nip46 = await import('./nip46');
    return nip46.nip44Decrypt(this.privateKeyHex, senderPubkey, ciphertext);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return nip04EncryptRaw(this.privateKeyHex, recipientPubkey, plaintext);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return nip04DecryptRaw(this.privateKeyHex, senderPubkey, ciphertext);
  }

  destroy(): void {
    // NB: this reassigns the field to a new string — it does NOT scrub the
    // original key material's backing memory. JS strings are immutable, so
    // the original characters may still live in the heap/GC arena until
    // collected. This is best-effort hygiene (drops our own reference,
    // stops accidental reuse), not a guarantee against memory-scraping.
    // A real fix needs a byte-buffer (Uint8Array) redesign — out of scope here.
    this.privateKeyHex = '0'.repeat(64);
  }
}

export function createLocalBackends(
  decryptedMnemonic: string,
): { naturalPerson: LocalSigningBackend; persona: LocalSigningBackend; professional: LocalSigningBackend } {
  const tree = _createSignetIdentity(decryptedMnemonic);

  const npPriv = bytesToHex(tree.naturalPerson.identity.privateKey);
  const personaPriv = bytesToHex(tree.persona.identity.privateKey);

  // Derive the Professional Persona key from the SAME tree's root (deterministic
  // from the mnemonic) via the nsec-tree 'professional' path token — before
  // destroying the tree. Avoids materialising a second full identity tree
  // (NP/persona key bytes again) just to reach the Pro key, halving the raw-key
  // exposure window (security audit 2026-06-15). The derived child key is
  // zeroized explicitly (destroyIdentity only zeroizes the tree's own slots).
  const proPersona = _deriveAdditionalPersona(tree.root, 'professional');
  const proPriv = bytesToHex(proPersona.identity.privateKey);
  proPersona.identity.privateKey.fill(0);

  _destroyIdentity(tree);

  return {
    naturalPerson: new LocalSigningBackend(npPriv),
    persona: new LocalSigningBackend(personaPriv),
    professional: new LocalSigningBackend(proPriv),
  };
}

const HEX64_RE = /^[0-9a-f]{64}$/;

function hexKey(value?: string): string {
  return value && HEX64_RE.test(value) ? value : '';
}

/**
 * Build local backends from the private keys stored on the decrypted identity.
 *
 * Most identities store keys that match the canonical mnemonic derivation, but
 * migrated identities can deliberately store a non-canonical Persona key while
 * still keeping the same mnemonic. In those cases the stored slot key must win.
 */
export function createLocalBackendsFromKeyMaterial(opts: {
  naturalPersonPrivateKey?: string;
  personaPrivateKey?: string;
  professionalPrivateKey?: string;
  mnemonicForProfessional?: string;
}): { naturalPerson: LocalSigningBackend; persona: LocalSigningBackend; professional?: LocalSigningBackend } | null {
  const npPriv = hexKey(opts.naturalPersonPrivateKey);
  const personaPriv = hexKey(opts.personaPrivateKey);
  if (!npPriv && !personaPriv) return null;

  const backends: {
    naturalPerson: LocalSigningBackend;
    persona: LocalSigningBackend;
    professional?: LocalSigningBackend;
  } = {
    naturalPerson: new LocalSigningBackend(npPriv || personaPriv),
    persona: new LocalSigningBackend(personaPriv || npPriv),
  };

  const proPriv = hexKey(opts.professionalPrivateKey);
  if (proPriv) {
    backends.professional = new LocalSigningBackend(proPriv);
  } else if (opts.mnemonicForProfessional) {
    const derived = createLocalBackends(opts.mnemonicForProfessional);
    backends.professional = derived.professional;
    derived.naturalPerson.destroy();
    derived.persona.destroy();
  }

  return backends;
}

// A Heartwood board's own approval window is ~30s, so a live signer always
// answers well inside this; the margin covers generic bunkers where a human
// approves. Bounds every BunkerSigningBackend request so a rebooting/offline
// signer rejects instead of leaving a caller (e.g. "Publishing…") hung forever.
export const SIGNER_REQUEST_TIMEOUT_MS = 90_000;

export class BunkerSigningBackend implements DecryptingSigningBackend {
  readonly type = 'bunker' as const;
  activePublicKeyHex: string = '';
  bunkerUri: string = '';
  private signer: BunkerSigner | null = null;
  private pool: SimplePool | null = null;
  private connectAttempt = 0;
  private clientSecretHex: string;
  /** See DecryptingSigningBackend.transportClientPubkeyHex. */
  readonly transportClientPubkeyHex: string;
  /**
   * Per-pairing cache of RESOLVED VAULT PUBKEYS ONLY, keyed by the vault
   * context (`${purpose}:${index}`, see vaultKeyContext). The vault pubkey
   * for a given (paired device, vault context) is deterministic, so repeated
   * resolves — e.g. usePrivateVaults' poll asking every dataset for both
   * rotations, every cycle — share one Heartwood get_public_key round trip
   * instead of re-asking the board each time. The in-flight promise is
   * cached too, so concurrent callers for the same context share one RPC.
   *
   * Deliberately NOT a cache of HeartwoodVaultBackend instances: every
   * caller of vaultBackend() (private-vault-sync/-rotation/-forward) owns
   * and `destroy()`s the instance it's handed, in its own `finally` — two
   * callers resolving the same context and each destroying their own
   * instance must never tear down each other's still-in-use route. So
   * vaultBackend() always builds a FRESH HeartwoodVaultBackend from this
   * cached pubkey (HeartwoodVaultBackend.fromResolvedPubkey).
   *
   * `vaultGeneration` invalidates an entry the moment the pairing it was
   * resolved against stops being current, including one still in flight
   * when that happens: bumped on every transport release (releaseTransport,
   * and the in-flight-attempt teardown in initSigner's `release()`) AND
   * right after a new connection's bunkerUri/activePublicKeyHex is
   * committed — closing the window where this.signer is already set but
   * the pairing fields still read as the OLD pairing. An entry whose
   * generation doesn't match the current one is a miss; a pubkey that
   * resolves after the generation has moved on is evicted rather than kept
   * for a later, differently-paired caller. Never held at module scope.
   */
  private vaultPubkeys = new Map<string, { generation: number; pubkey: Promise<string> }>();
  private vaultGeneration = 0;

  constructor(clientSecretHex: string) {
    if (!clientSecretHex || !/^[0-9a-f]{64}$/.test(clientSecretHex)) {
      // Mirror LocalSigningBackend: length-only error, no echo of the
      // candidate key material.
      const length = clientSecretHex ? clientSecretHex.length : 0;
      throw new Error(`Invalid client secret: expected 64-char hex, got length ${length}`);
    }
    this.clientSecretHex = clientSecretHex;
    this.transportClientPubkeyHex = bytesToHex(schnorr.getPublicKey(hexToBytes(clientSecretHex)));
  }

  /**
   * Initial connect to a Heartwood bunker via NIP-46.
   * Sends the connect handshake with secret and app metadata.
   */
  async connect(bunkerUri: string, timeoutMs: number = 30_000): Promise<void> {
    await this.initSigner(bunkerUri, timeoutMs, true);
  }

  /**
   * Reconnect to an already-paired bunker. Skips the connect handshake
   * since the device already trusts this client key.
   *
   * When `expectedPubkey` is provided, the pubkey returned by the bunker
   * is verified against it after `get_public_key` resolves — a MITM relay
   * could otherwise swap in a different identity. Mismatch destroys the
   * in-flight signer and throws so callers don't proceed with a wrong key.
   *
   * Set `resendConnect` to re-send the `connect`-with-secret handshake on
   * reconnect. Heartwood authorises a client only when it sees that secret
   * (it remembers a SET of authorised client pubkeys per slot), so a plain
   * reconnect after the slot's binding moved on would fall back to per-sign
   * button approval. Re-sending the secret re-authorises this client every
   * reopen. Leave it off for the paired-child path, where the guardian
   * clears the one-time secret after first pairing.
   */
  async reconnect(bunkerUri: string, timeoutMs: number = 30_000, expectedPubkey?: string, resendConnect: boolean = false): Promise<void> {
    await this.initSigner(bunkerUri, timeoutMs, resendConnect, expectedPubkey);
  }

  private async initSigner(bunkerUri: string, timeoutMs: number, sendConnect: boolean, expectedPubkey?: string): Promise<void> {
    // Each attempt owns its own signer and pool. destroy(), a newer attempt
    // or this attempt's timeout makes it stale: it stops at its next await
    // and tears down only what it created, never a newer attempt's transport.
    const attempt = ++this.connectAttempt;
    let signer: BunkerSigner | null = null;
    let pool: SimplePool | null = null;
    const ensureCurrent = () => {
      if (attempt !== this.connectAttempt) throw new Error('Connection cancelled');
    };
    const release = () => {
      if (signer) void signer.close().catch(() => { /* best-effort teardown */ });
      try { pool?.destroy(); } catch { /* best-effort teardown */ }
      if (this.signer === signer) { this.signer = null; this.vaultGeneration++; }
      if (this.pool === pool) this.pool = null;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Connection timed out')), timeoutMs);
    });

    const doConnect = async () => {
      const bp = await parseBunkerInput(bunkerUri);
      if (!bp || !bp.relays || bp.relays.length === 0) {
        throw new Error('Bunker URI must include at least one relay.');
      }
      ensureCurrent();

      this.releaseTransport();
      const clientSk = hexToBytes(this.clientSecretHex);
      pool = new SimplePool();
      signer = BunkerSigner.fromBunker(clientSk, bp, {
        pool,
        onauth() { /* Heartwood auth callback — no action needed in signet */ },
      });
      this.pool = pool;
      this.signer = signer;

      // The signer's reply subscription must be live before the first
      // request, or the bunker's answer can arrive before the REQ and be
      // missed. Wait for that rather than for a fixed 3 s.
      await waitForReplySubscription(pool, bp.relays, {
        kinds: [24133],
        authors: [bp.pubkey],
        '#p': [this.transportClientPubkeyHex],
        limit: 0,
      }, RELAY_READY_CAP_MS);
      ensureCurrent();

      if (sendConnect) {
        // Initial pairing: send connect with secret and app metadata
        const meta = JSON.stringify({ name: 'MySignet', url: 'https://mysignet.app' });
        await signer.sendRequest('connect', [bp.pubkey, bp.secret || '', meta]);
        ensureCurrent();
      }

      // Verify connection by fetching the public key
      const pubkey = await signer.getPublicKey();
      ensureCurrent();

      // Identity pin — protects against a MITM relay substituting a
      // different bunker identity. Tear down the signer on mismatch so the
      // caller can't accidentally sign with the wrong key.
      if (expectedPubkey && pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) {
        this.activePublicKeyHex = ''; // symmetry with destroy() — don't leave stale pubkey visible
        throw new Error(`Bunker pubkey mismatch: expected ${expectedPubkey.slice(0, 8)}… got ${pubkey.slice(0, 8)}…`);
      }

      // Normalise, as `RoutedBunkerSigningBackend` does: a generic bunker can
      // reply with uppercase hex or stray whitespace, and downstream code
      // compares and validates this value as strict lowercase 64-hex (the
      // vault envelope refuses to seal to anything else). The mismatch check
      // above stays case-insensitive — it compares, it does not store.
      this.activePublicKeyHex = pubkey.trim().toLowerCase();
      this.bunkerUri = bunkerUri;
      // A vaultBackend() call racing this window (this.signer already set,
      // but the pairing fields not yet committed) must never have its
      // resolution kept for a later caller under the NEW pairing.
      this.vaultGeneration++;
    };

    try {
      await Promise.race([doConnect(), timeoutPromise]);
    } catch (err) {
      // A timed-out attempt keeps running in the background; retire it so it
      // stops at its next checkpoint instead of finishing later.
      if (attempt === this.connectAttempt) this.connectAttempt++;
      release();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Close the current signer and its relay sockets.
   * BunkerSigner.close() ends its subscription but leaves the sockets open. */
  private releaseTransport(): void {
    if (this.signer) void this.signer.close().catch(() => { /* best-effort teardown */ });
    try { this.pool?.destroy(); } catch { /* best-effort teardown */ }
    this.signer = null;
    this.pool = null;
    this.vaultGeneration++;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    if (!this.signer) throw new Error('Not connected to bunker');
    const template = {
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
    };
    const resp = await this.request('sign_event', [JSON.stringify(template)], SIGNER_REQUEST_TIMEOUT_MS);
    const signed = JSON.parse(resp);
    // Same verification BunkerSigner.signEvent performs before trusting a reply.
    if (!verifyEvent(signed)) {
      throw new Error(`event returned from bunker is improperly signed: ${JSON.stringify(signed)}`);
    }
    // Defence in depth: this backend instance represents exactly one pubkey
    // (set at connect/reconnect time, pinned there against a MITM relay). A
    // reply that verifies but is signed by a different key than the one this
    // route is bound to must never be handed back as if it were ours.
    if (typeof signed.pubkey !== 'string' || signed.pubkey.toLowerCase() !== this.activePublicKeyHex) {
      throw new Error('Signer returned an event for a different pubkey');
    }
    // Convert nostr-tools VerifiedEvent to signet-protocol NostrEvent shape
    return signed as unknown as NostrEvent;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    if (!this.signer) throw new Error('Not connected to bunker');
    return this.request('nip44_encrypt', [recipientPubkey, plaintext], SIGNER_REQUEST_TIMEOUT_MS);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!this.signer) throw new Error('Not connected to bunker');
    return this.request('nip44_decrypt', [senderPubkey, ciphertext], SIGNER_REQUEST_TIMEOUT_MS);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    if (!this.signer) throw new Error('Not connected to bunker');
    return this.request('nip04_encrypt', [recipientPubkey, plaintext], SIGNER_REQUEST_TIMEOUT_MS);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!this.signer) throw new Error('Not connected to bunker');
    return this.request('nip04_decrypt', [senderPubkey, ciphertext], SIGNER_REQUEST_TIMEOUT_MS);
  }

  /**
   * Dedicated vault route on MySignet's own pairing; never registers a
   * persona. Shares the resolved vault PUBKEY across calls for the same
   * context (see the `vaultPubkeys` field), but always returns a FRESH
   * HeartwoodVaultBackend instance built from it — every caller owns and
   * `destroy()`s the instance it's handed, so two callers resolving the same
   * context must get independent instances, not the same one.
   *
   * The context/cache-key/generation are computed synchronously, before any
   * await, so two calls issued in the same tick for the same context always
   * share one in-flight pubkey resolution rather than racing to resolve two.
   * The identityPubkeys exclusion check always runs against what THIS call
   * was passed, whether the pubkey came from cache or was just resolved.
   */
  async vaultBackend(dataset: import('signet-protocol/experimental').VaultDataset, rotation: number,
    identityPubkeys: readonly string[]): Promise<DecryptingSigningBackend> {
    if (!this.signer) throw new Error('Not connected to bunker');
    const context = vaultKeyContext(dataset, rotation);
    const key = `${context.purpose}:${context.index}`;
    const generation = this.vaultGeneration;
    const transportPubkey = new URL(this.bunkerUri).hostname;
    const forbidden = [...identityPubkeys, this.activePublicKeyHex, transportPubkey];

    const cached = this.vaultPubkeys.get(key);
    const pubkeyPromise = (cached && cached.generation === generation)
      ? cached.pubkey
      : this.resolveVaultPubkey(key, context, generation);

    // Awaited before this call's own module import: on a cache miss,
    // resolveVaultPubkey() already performs the identical import internally,
    // and issuing a second import() for the same specifier concurrently
    // (rather than after the first has settled) buys nothing once the
    // module is cached — doing it sequentially avoids two in-flight
    // resolutions of the same dynamic import racing each other.
    const pubkey = await pubkeyPromise;
    const { HeartwoodVaultBackend, heartwoodVaultRequest } = await this.heartwoodVaultModule();
    return HeartwoodVaultBackend.fromResolvedPubkey(pubkey, context, (method, params, ctx) => {
      if (!this.signer) return Promise.reject(new Error('Not connected to bunker'));
      return heartwoodVaultRequest({ clientSecret: this.clientSecretHex, bunkerUri: this.bunkerUri,
        method, params, context: ctx });
    }, forbidden);
  }

  /**
   * Resolve and cache a fresh vault pubkey for `key`/`context` at
   * `generation` — called only from vaultBackend() on a cache miss. The map
   * write happens synchronously (before any await), so concurrent
   * vaultBackend() calls for the same context in the same tick observe it
   * and share this one in-flight RPC instead of issuing a second.
   */
  private resolveVaultPubkey(key: string, context: { purpose: string; index: number }, generation: number): Promise<string> {
    const pubkeyPromise: Promise<string> = (async () => {
      const { heartwoodVaultRequest } = await this.heartwoodVaultModule();
      return heartwoodVaultRequest({ clientSecret: this.clientSecretHex, bunkerUri: this.bunkerUri,
        method: 'get_public_key', params: [], context });
    })();
    this.vaultPubkeys.set(key, { generation, pubkey: pubkeyPromise });
    pubkeyPromise.then(
      () => {
        // Resolved against a pairing that is no longer current — never leave
        // it behind for a later, differently-paired caller to reuse.
        if (generation !== this.vaultGeneration && this.vaultPubkeys.get(key)?.pubkey === pubkeyPromise) {
          this.vaultPubkeys.delete(key);
        }
      },
      () => {
        if (this.vaultPubkeys.get(key)?.pubkey === pubkeyPromise) this.vaultPubkeys.delete(key);
      },
    );
    return pubkeyPromise;
  }

  /** Single call site for the lazy `./heartwood-vault` import — both
   * vaultBackend() and resolveVaultPubkey() go through this rather than each
   * calling `import(...)` directly. */
  private heartwoodVaultModule(): Promise<typeof import('./heartwood-vault')> {
    return import('./heartwood-vault');
  }

  /**
   * Raw NIP-46 request passthrough for Heartwood extension methods
   * (heartwood_capabilities, heartwood_derive_persona, …). Returns the
   * response `result` string verbatim; callers parse/validate.
   */
  async request(method: string, params: string[], timeoutMs?: number): Promise<string> {
    if (!this.signer) throw new Error('Not connected to bunker');
    if (timeoutMs === undefined) return this.signer.sendRequest(method, params);
    // BunkerSigner has no request timeout and never forgets a listener whose
    // reply does not come. Its `listeners` map is TS-private but a plain
    // object at runtime, and sendRequest registers the listener synchronously
    // (before its first await), so the one key that appears across the call
    // is ours — dropped on timeout. If a nostr-tools upgrade changes that
    // shape, the lookup finds nothing and the timeout still fires; only the
    // cleanup is lost.
    const listeners = (this.signer as unknown as { listeners?: unknown }).listeners;
    const map = listeners && typeof listeners === 'object' ? listeners as Record<string, unknown> : null;
    const before = map ? new Set(Object.keys(map)) : null;
    const pending = this.signer.sendRequest(method, params);
    const ours = map && before ? Object.keys(map).filter((k) => !before.has(k)) : [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (map) for (const k of ours) delete map[k];
            reject(new BunkerRequestTimeoutError(method));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  destroy(): void {
    this.connectAttempt++; // an in-flight connect stops at its next await
    this.releaseTransport();
    // Same caveat as LocalSigningBackend.destroy — reassigning a string
    // field doesn't scrub the original backing memory (JS strings are
    // immutable). Best-effort hygiene, not a memory-scraping guarantee.
    this.clientSecretHex = '0'.repeat(64);
    this.activePublicKeyHex = '';
    this.bunkerUri = '';
  }
}

/** A NIP-46 request got no reply within its timeout (no answer, as opposed
 * to the signer answering with an error). */
export class BunkerRequestTimeoutError extends Error {
  constructor(method: string) { super(`${method} timed out`); this.name = 'BunkerRequestTimeoutError'; }
}

/** Generate a new 64-char hex client secret for bunker pairing */
export function generateBunkerClientSecret(): string {
  const sk = generateSecretKey();
  const hex = bytesToHex(sk);
  sk.fill(0);
  return hex;
}

export class Nip07SigningBackend implements DecryptingSigningBackend {
  readonly type = 'nip07' as const;
  activePublicKeyHex: string;

  constructor(publicKeyHex: string) {
    this.activePublicKeyHex = publicKeyHex;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    if (!window.nostr?.signEvent) throw new Error('NIP-07 extension not available');
    return window.nostr.signEvent(event) as Promise<NostrEvent>;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    if (!window.nostr?.nip44?.encrypt) throw new Error('NIP-44 not supported by extension');
    return window.nostr.nip44.encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!window.nostr?.nip44?.decrypt) throw new Error('NIP-44 decrypt not supported by extension');
    return window.nostr.nip44.decrypt(senderPubkey, ciphertext);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    if (!window.nostr?.nip04?.encrypt) throw new Error('NIP-04 not supported by extension');
    return window.nostr.nip04.encrypt(recipientPubkey, plaintext);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!window.nostr?.nip04?.decrypt) throw new Error('NIP-04 decrypt not supported by extension');
    return window.nostr.nip04.decrypt(senderPubkey, ciphertext);
  }

  destroy(): void {
    this.activePublicKeyHex = '';
  }
}
