/**
 * Unit tests for relay-publish.ts
 *
 * The three public publishers (publishVerifyResponseToRelay,
 * publishVerifyRejectionToRelay, publishAuthResponseToRelay) gift-wrap
 * (NIP-17 / NIP-59) to a required `recipientPubkey`. Tests cover:
 *   - URL validation (invalid → false, valid → reaches WebSocket)
 *   - Recipient validation (missing/malformed → false, no publish attempt)
 *   - WebSocket error handling
 *   - Signing-failure handling
 *   - Wrap shape (kind 1059 + `p` tag for recipient + non-empty ciphertext)
 *
 * The cleartext fallback that previously existed was deleted; tests for
 * the inner-event tag shape moved to signet-protocol where the template
 * builders live.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  publishVerifyResponseToRelay,
  publishVerifyRejectionToRelay,
  publishAuthResponseToRelay,
} from './relay-publish';
import type { SigningBackend } from './signing-backend';
import { LocalSigningBackend } from './signing-backend';
import type { VerifyResponse } from './presentation';
import type { AuthResponse } from './relay-publish';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

/** A known 32-byte private key (all-zeros is rejected by secp256k1 — use 0x01…) */
const TEST_PRIV_HEX = '0101010101010101010101010101010101010101010101010101010101010101';
const RECIPIENT_PRIV_HEX = '0202020202020202020202020202020202020202020202020202020202020202';
const RECIPIENT_PUB = new LocalSigningBackend(RECIPIENT_PRIV_HEX).activePublicKeyHex;

function makeBackend(): LocalSigningBackend {
  return new LocalSigningBackend(TEST_PRIV_HEX);
}

function makeVerifyResponse(overrides: Partial<VerifyResponse> = {}): VerifyResponse {
  return {
    type: 'signet-verify-response',
    requestId: 'a'.repeat(32),
    credential: {
      id: 'cred-1',
      kind: 29999,
      pubkey: 'b'.repeat(64),
      tags: [
        ['age-range', '18+'],
        ['tier', 'gold'],
        ['entity-type', 'natural-person'],
      ],
      content: '',
      sig: 'c'.repeat(128),
      created_at: now,
    },
    subjectPubkey: 'd'.repeat(64),
    ...overrides,
  };
}

function makeAuthResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
  return {
    type: 'signet-auth-response',
    requestId: 'e'.repeat(32),
    authEvent: {
      id: '1'.repeat(64),
      pubkey: 'f'.repeat(64),
      kind: 21236,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'e'.repeat(32)],
        ['origin', 'https://example.com'],
      ],
      content: '',
      sig: '0'.repeat(128),
    },
    ...overrides,
  };
}

// ── Recipient pubkey validation ───────────────────────────────────────────────
//
// The whole point of this layer is that nothing user-attesting hits a relay
// without a recipient envelope. These cases all fail-closed.

describe('recipientPubkey validation — missing or malformed → false', () => {
  const invalidRecipients: Array<{ val: string; label: string }> = [
    { val: '', label: 'empty string' },
    { val: 'not-hex', label: 'non-hex string' },
    { val: '0'.repeat(63), label: '63 chars (too short)' },
    { val: '0'.repeat(65), label: '65 chars (too long)' },
    { val: 'g'.repeat(64), label: '64 non-hex chars' },
  ];

  for (const { val, label } of invalidRecipients) {
    it(`publishVerifyResponseToRelay rejects "${label}"`, async () => {
      const backend = makeBackend();
      expect(await publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, val)).toBe(false);
    });

    it(`publishVerifyRejectionToRelay rejects "${label}"`, async () => {
      const backend = makeBackend();
      expect(await publishVerifyRejectionToRelay('req-id', 'wss://relay.example.com', backend, val)).toBe(false);
    });

    it(`publishAuthResponseToRelay rejects "${label}"`, async () => {
      const backend = makeBackend();
      expect(await publishAuthResponseToRelay(makeAuthResponse(), 'wss://relay.example.com', backend, val)).toBe(false);
    });
  }
});

// ── Relay URL validation ──────────────────────────────────────────────────────

describe('relay URL validation — invalid URLs return false immediately', () => {
  const backend = makeBackend();
  const response = makeVerifyResponse();
  const authResponse = makeAuthResponse();

  const invalidUrls: Array<{ url: string; label: string }> = [
    { url: '', label: 'empty string' },
    { url: 'ws://example.com', label: 'ws:// non-localhost' },
    { url: 'http://relay.example.com', label: 'http://' },
    { url: 'https://relay.example.com', label: 'https://' },
    { url: 'ftp://relay.example.com', label: 'ftp://' },
  ];

  for (const { url, label } of invalidUrls) {
    it(`publishVerifyResponseToRelay rejects "${label}"`, async () => {
      expect(await publishVerifyResponseToRelay(response, url, backend, RECIPIENT_PUB)).toBe(false);
    });

    it(`publishVerifyRejectionToRelay rejects "${label}"`, async () => {
      expect(await publishVerifyRejectionToRelay('req-id', url, backend, RECIPIENT_PUB)).toBe(false);
    });

    it(`publishAuthResponseToRelay rejects "${label}"`, async () => {
      expect(await publishAuthResponseToRelay(authResponse, url, backend, RECIPIENT_PUB)).toBe(false);
    });
  }
});

describe('relay URL validation — valid URLs pass through to WebSocket', () => {
  const validUrls: Array<{ url: string; label: string }> = [
    { url: 'wss://relay.example.com', label: 'wss://' },
    { url: 'WSS://relay.example.com', label: 'WSS:// case-insensitive' },
    { url: 'ws://localhost:7777', label: 'ws://localhost' },
    { url: 'ws://127.0.0.1:7777', label: 'ws://127.0.0.1' },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', buildErrorWsMock());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const { url, label } of validUrls) {
    it(`publishVerifyResponseToRelay accepts "${label}"`, async () => {
      const backend = makeBackend();
      const promise = publishVerifyResponseToRelay(makeVerifyResponse(), url, backend, RECIPIENT_PUB);
      await vi.runAllTimersAsync();
      expect(typeof (await promise)).toBe('boolean');
    });

    it(`publishVerifyRejectionToRelay accepts "${label}"`, async () => {
      const backend = makeBackend();
      const promise = publishVerifyRejectionToRelay('req-id', url, backend, RECIPIENT_PUB);
      await vi.runAllTimersAsync();
      expect(typeof (await promise)).toBe('boolean');
    });

    it(`publishAuthResponseToRelay accepts "${label}"`, async () => {
      const backend = makeBackend();
      const promise = publishAuthResponseToRelay(makeAuthResponse(), url, backend, RECIPIENT_PUB);
      await vi.runAllTimersAsync();
      expect(typeof (await promise)).toBe('boolean');
    });
  }
});

// ── WebSocket mock helpers ────────────────────────────────────────────────────

function buildErrorWsMock() {
  return class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((msg: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    send = vi.fn();
    constructor(_url: string) {
      setTimeout(() => { this.onerror?.(); }, 0);
    }
  };
}

/**
 * NIP-20-compliant relay mock. Fires onopen, captures the EVENT frame the
 * client sends, then schedules an `OK` reply addressed to the captured
 * event id. Default ok-status is true; pass `okStatus: false` to simulate
 * a relay rejection (rate-limited, blocked, malformed, etc.).
 */
function buildOpenWsMock(sent: { value: string | null }, okStatus = true) {
  return class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((msg: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    send = vi.fn((msg: string) => {
      sent.value = msg;
      // Look up the event id from the EVENT frame we just received and
      // schedule the matching OK reply on the next tick.
      try {
        const parsed = JSON.parse(msg);
        const eventId = parsed?.[1]?.id;
        if (typeof eventId === 'string') {
          setTimeout(() => {
            this.onmessage?.({ data: JSON.stringify(['OK', eventId, okStatus, '']) });
          }, 0);
        }
      } catch { /* non-JSON send — let the publish-side timeout */ }
    });
    constructor(_url: string) {
      setTimeout(() => { this.onopen?.(); }, 0);
    }
  };
}

/**
 * Open-but-silent mock — fires onopen, receives the EVENT, then never
 * sends OK. Used to verify the publish-side timeout fires `false`.
 */
function buildSilentWsMock(sent: { value: string | null }) {
  return class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((msg: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    send = vi.fn((msg: string) => { sent.value = msg; });
    constructor(_url: string) {
      setTimeout(() => { this.onopen?.(); }, 0);
    }
  };
}

// ── WebSocket error path ──────────────────────────────────────────────────────

describe('publishVerifyResponseToRelay — WebSocket error returns false', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', buildErrorWsMock());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves false when WebSocket fires onerror', async () => {
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });
});

describe('publishVerifyRejectionToRelay — WebSocket error returns false', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', buildErrorWsMock());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves false when WebSocket fires onerror', async () => {
    const backend = makeBackend();
    const promise = publishVerifyRejectionToRelay('req-id', 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });
});

describe('publishAuthResponseToRelay — WebSocket error returns false', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', buildErrorWsMock());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves false when WebSocket fires onerror', async () => {
    const backend = makeBackend();
    const promise = publishAuthResponseToRelay(makeAuthResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });
});

// ── Happy-path: gift-wrap shape ───────────────────────────────────────────────
//
// Inner-event tag assertions (status, session, etc.) used to live here.
// They were really testing the protocol's template builders — those tests
// belong in signet-protocol now that the inner content is hidden behind
// NIP-44 ciphertext. Here we verify only the wrap envelope.

function assertWrapShape(rawMsg: string): { wrap: { kind: number; tags: string[][]; content: string; pubkey: string } } {
  const msg = JSON.parse(rawMsg);
  expect(msg[0]).toBe('EVENT');
  const wrap = msg[1];
  expect(wrap.kind).toBe(1059);
  const pTag = wrap.tags.find((t: string[]) => t[0] === 'p');
  expect(pTag?.[1]).toBe(RECIPIENT_PUB);
  // Content is opaque NIP-44 ciphertext — by-design unreadable to the relay.
  expect(typeof wrap.content).toBe('string');
  expect(wrap.content.length).toBeGreaterThan(0);
  // Wrap is signed by an ephemeral key, NOT the sender's identity key.
  // The ephemeral pubkey is what the relay sees as the publisher.
  expect(wrap.pubkey).not.toBe(makeBackend().activePublicKeyHex);
  return { wrap };
}

describe('publishVerifyResponseToRelay — wraps to recipient', () => {
  let sent: { value: string | null };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = { value: null };
    vi.stubGlobal('WebSocket', buildOpenWsMock(sent));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes a kind-1059 wrap p-tagged to the recipient', async () => {
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
    expect(sent.value).not.toBeNull();
    assertWrapShape(sent.value!);
  });
});

describe('publishVerifyRejectionToRelay — wraps to recipient', () => {
  let sent: { value: string | null };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = { value: null };
    vi.stubGlobal('WebSocket', buildOpenWsMock(sent));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes a kind-1059 wrap p-tagged to the recipient', async () => {
    const backend = makeBackend();
    const promise = publishVerifyRejectionToRelay('rej-req-id', 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
    expect(sent.value).not.toBeNull();
    assertWrapShape(sent.value!);
  });
});

describe('publishAuthResponseToRelay — wraps to recipient', () => {
  let sent: { value: string | null };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = { value: null };
    vi.stubGlobal('WebSocket', buildOpenWsMock(sent));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes a kind-1059 wrap p-tagged to the recipient', async () => {
    const backend = makeBackend();
    const promise = publishAuthResponseToRelay(makeAuthResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
    expect(sent.value).not.toBeNull();
    assertWrapShape(sent.value!);
  });
});

// ── Relay OK-frame handling ────────────────────────────────────────────
//
// Regression: prior behaviour resolved `true` 1 s after `onopen` regardless
// of what the relay said. An `OK ... false` (rate-limited, AUTH required,
// blocked, malformed) looked identical to acceptance. The new behaviour
// waits for the matching `["OK", <event-id>, <bool>]` frame and reports
// the actual outcome — including a hard `false` on missing OK / WS close.

describe('publishToRelay — OK frame handling', () => {
  let sent: { value: string | null };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves true on `OK <id> true`', async () => {
    vi.useFakeTimers();
    sent = { value: null };
    vi.stubGlobal('WebSocket', buildOpenWsMock(sent, true));
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });

  it('resolves false on `OK <id> false` (relay rejected)', async () => {
    vi.useFakeTimers();
    sent = { value: null };
    vi.stubGlobal('WebSocket', buildOpenWsMock(sent, false));
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });

  it('resolves false when the relay never sends an OK frame (timeout)', async () => {
    vi.useFakeTimers();
    sent = { value: null };
    vi.stubGlobal('WebSocket', buildSilentWsMock(sent));
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    // Advance well past the 10 s publish timeout so the watchdog fires.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await promise).toBe(false);
  });

  it('ignores OK frames addressed to a different event id', async () => {
    vi.useFakeTimers();
    sent = { value: null };
    // Mock that always replies OK for a wrong event id, never our own.
    const WrongIdMock = class MockWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((msg: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      send = vi.fn((msg: string) => {
        sent.value = msg;
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify(['OK', 'f'.repeat(64), true, '']) });
        }, 0);
      });
      constructor(_url: string) {
        setTimeout(() => { this.onopen?.(); }, 0);
      }
    };
    vi.stubGlobal('WebSocket', WrongIdMock);
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    // Wrong id should be ignored, then the publish-side timeout fires false.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await promise).toBe(false);
  });

  it('ignores NOTICE frames and waits for OK', async () => {
    vi.useFakeTimers();
    sent = { value: null };
    const NoticeThenOkMock = class MockWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((msg: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      send = vi.fn((msg: string) => {
        sent.value = msg;
        const parsed = JSON.parse(msg);
        const eventId = parsed?.[1]?.id;
        // NOTICE first, then OK true — the publisher must skip the NOTICE
        // and resolve on the OK.
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify(['NOTICE', 'rate-limit warning']) });
          this.onmessage?.({ data: JSON.stringify(['OK', eventId, true, '']) });
        }, 0);
      });
      constructor(_url: string) {
        setTimeout(() => { this.onopen?.(); }, 0);
      }
    };
    vi.stubGlobal('WebSocket', NoticeThenOkMock);
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });

  it('resolves false when the WebSocket closes before any OK frame', async () => {
    vi.useFakeTimers();
    sent = { value: null };
    const CloseBeforeOkMock = class MockWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((msg: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      send = vi.fn();
      constructor(_url: string) {
        setTimeout(() => { this.onopen?.(); }, 0);
        setTimeout(() => { this.onclose?.(); }, 1);
      }
    };
    vi.stubGlobal('WebSocket', CloseBeforeOkMock);
    const backend = makeBackend();
    const promise = publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', backend, RECIPIENT_PUB);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });
});

// ── Signing failure paths ─────────────────────────────────────────────────────

describe('publish functions — signing failure returns false', () => {
  const broken: SigningBackend = {
    type: 'local',
    activePublicKeyHex: 'a'.repeat(64),
    signEvent: vi.fn().mockRejectedValue(new Error('key destroyed')),
    nip44Encrypt: vi.fn().mockRejectedValue(new Error('key destroyed')),
    destroy: vi.fn(),
  };

  it('publishVerifyResponseToRelay returns false when signing throws', async () => {
    const result = await publishVerifyResponseToRelay(makeVerifyResponse(), 'wss://relay.example.com', broken, RECIPIENT_PUB);
    expect(result).toBe(false);
  });

  it('publishVerifyRejectionToRelay returns false when signing throws', async () => {
    const result = await publishVerifyRejectionToRelay('req-id', 'wss://relay.example.com', broken, RECIPIENT_PUB);
    expect(result).toBe(false);
  });

  it('publishAuthResponseToRelay returns false when signing throws', async () => {
    const result = await publishAuthResponseToRelay(makeAuthResponse(), 'wss://relay.example.com', broken, RECIPIENT_PUB);
    expect(result).toBe(false);
  });
});

// ── publishVerifyResponseToRelay — ZKP pre-publish verification ───────────────
//
// ZKP verification happens BEFORE the wrap, so a malformed range proof
// must propagate as a thrown 'credential-zkp-invalid' error rather than
// be obscured by the encryption layer.

describe('publishVerifyResponseToRelay — ZKP pre-publish verification', () => {
  it('throws credential-zkp-invalid when the embedded range proof is malformed', async () => {
    const response = {
      type: 'signet-verify-response' as const,
      requestId: 'a'.repeat(32),
      credential: {
        id: 'cred-bad',
        kind: 30470,
        pubkey: '00'.repeat(32),
        tags: [['age-range', '18+'], ['zk-age', '1']],
        content: JSON.stringify({ rangeProof: 'not-a-proof-object' }),
        sig: 'sig',
        created_at: 1000,
      },
      subjectPubkey: '00'.repeat(32),
    };
    const stubBackend = {
      signEvent: async () => { throw new Error('should not reach signing'); },
      nip44Encrypt: async () => { throw new Error('unused'); },
    } as unknown as Parameters<typeof publishVerifyResponseToRelay>[2];

    await expect(
      publishVerifyResponseToRelay(response, 'wss://relay.example', stubBackend, RECIPIENT_PUB),
    ).rejects.toThrow('credential-zkp-invalid');
  });

  it('publishes legacy credentials (no zk-age tag) without attempting ZKP verification', async () => {
    const response = {
      type: 'signet-verify-response' as const,
      requestId: 'a'.repeat(32),
      credential: {
        id: 'cred-legacy',
        kind: 30470,
        pubkey: '00'.repeat(32),
        tags: [['age-range', '18+']],
        content: '',
        sig: 'sig',
        created_at: 1000,
      },
      subjectPubkey: '00'.repeat(32),
    };
    // Stub signEvent throws to confirm it was reached. The outer try/catch in
    // publishVerifyResponseToRelay swallows signing errors and returns false —
    // so `false` here means the ZKP guard was skipped (no credential-zkp-invalid
    // throw) and execution reached the normal signing path.
    const stubBackend = {
      signEvent: async () => { throw new Error('reached-signing'); },
      nip44Encrypt: async () => { throw new Error('reached-encrypt'); },
    } as unknown as Parameters<typeof publishVerifyResponseToRelay>[2];

    await expect(
      publishVerifyResponseToRelay(response, 'wss://relay.example', stubBackend, RECIPIENT_PUB),
    ).resolves.toBe(false);
  });
});
