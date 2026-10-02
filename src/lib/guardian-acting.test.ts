import { describe, it, expect, vi } from 'vitest';
import type { DecryptingSigningBackend } from './signing-backend';
import { guardianActingBackend, pruneGuardianActing, parseGuardianActingEntry, GUARDIAN_ACTING_KEEP_S, type GuardianActingEntry } from './guardian-acting';
import { reserveRequestCreatedAt, resetRequestCreatedAtForTests } from '../hooks/useChildGate';

const P = 'b'.repeat(64);

class FakeRouted {
  activePublicKeyHex = P;
  isDestroyed = false;
  stampedWith: number[] = [];
  signEvent = vi.fn(async (e: { kind: number }) => ({ ...e, id: 'x', sig: 'y', pubkey: P }));
  nip44Encrypt = vi.fn(async () => 'ct');
  nip44Decrypt = vi.fn(async () => 'pt');
  stamped(n: number) {
    this.stampedWith.push(n);
    return { signEvent: this.signEvent, nip44Encrypt: this.nip44Encrypt, nip44Decrypt: this.nip44Decrypt };
  }
  destroy() { this.isDestroyed = true; }
}

describe('guardianActingBackend (A48)', () => {
  it('stamps each call strictly increasing per persona and records it after success', async () => {
    resetRequestCreatedAtForTests();
    const inner = new FakeRouted();
    const rows: GuardianActingEntry[] = [];
    const b = guardianActingBackend(inner as unknown as DecryptingSigningBackend, P, {
      stamp: (p) => reserveRequestCreatedAt(p, { now: () => 1_000_000_000, sleep: async () => {} }), record: (e) => rows.push(e), nowS: () => 1_000_000_050,
    });
    await b.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: P });
    await b.nip44Encrypt('c'.repeat(64), 'hi');
    expect(inner.stampedWith).toEqual([1_000_000, 1_000_001]);
    expect(rows).toEqual([
      { source: 'guardian', persona: P, kind: 1, method: 'sign_event', requestCreatedAt: 1_000_000, at: 1_000_000_050 },
      { source: 'guardian', persona: P, kind: null, method: 'nip44_encrypt', requestCreatedAt: 1_000_001, at: 1_000_000_050 },
    ]);
  });

  it('records nothing when the call fails', async () => {
    const inner = new FakeRouted();
    inner.signEvent.mockRejectedValueOnce(new Error('denied'));
    const record = vi.fn();
    const b = guardianActingBackend(inner as unknown as DecryptingSigningBackend, P, { stamp: () => 5, record });
    await expect(b.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: P })).rejects.toThrow('denied');
    expect(record).not.toHaveBeenCalled();
  });

  it('passes everything else through, instanceof included', () => {
    const inner = new FakeRouted();
    const b = guardianActingBackend(inner as unknown as DecryptingSigningBackend, P, { stamp: () => 1, record: () => {} });
    expect(b.activePublicKeyHex).toBe(P);
    expect(b instanceof FakeRouted).toBe(true);
    (b as unknown as FakeRouted).destroy();
    expect((b as unknown as FakeRouted).isDestroyed).toBe(true);
  });
});

describe('guardian acting rows', () => {
  it('keeps 7 days, newest first, and validates', () => {
    const row = (at: number): GuardianActingEntry => ({ source: 'guardian', persona: P, kind: 1, method: 'sign_event', requestCreatedAt: at, at });
    const now = 10_000_000;
    expect(pruneGuardianActing([row(now - GUARDIAN_ACTING_KEEP_S - 1), row(now - 5), row(now)], now).map(r => r.at)).toEqual([now, now - 5]);
    expect(parseGuardianActingEntry(row(5))).toEqual(row(5));
    expect(parseGuardianActingEntry({ ...row(5), persona: 'XY' })).toBeNull();
    expect(parseGuardianActingEntry({ ...row(5), method: 'connect' })).toBeNull();
  });
});
