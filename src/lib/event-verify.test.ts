import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { verifiedAuthoredEvents, verifiedAuthoredEvent } from './event-verify';

function signEvent(content: string, kind = 1) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ev = finalizeEvent({ kind, content, created_at: Math.floor(Date.now() / 1000), tags: [] }, sk);
  return { ev, pk };
}

/**
 * Build a plain (non-verified-cached) tampered event from a signed one.
 * `finalizeEvent` sets an internal `verifiedSymbol: true` on the returned
 * object that `verifyEvent` short-circuits on; without stripping it,
 * tampered-sig tests would falsely pass.
 */
function tamperedCopy(signed: ReturnType<typeof signEvent>['ev'], overrides: Partial<{ sig: string; id: string; pubkey: string; content: string }>) {
  return {
    kind: signed.kind,
    pubkey: overrides.pubkey ?? signed.pubkey,
    created_at: signed.created_at,
    tags: signed.tags,
    content: overrides.content ?? signed.content,
    id: overrides.id ?? signed.id,
    sig: overrides.sig ?? signed.sig,
  };
}

describe('event-verify', () => {
  describe('verifiedAuthoredEvents', () => {
    it('keeps a valid signed event', () => {
      const { ev } = signEvent('hello');
      const out = verifiedAuthoredEvents([ev]);
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(ev);
    });

    it('drops an event whose signature is invalid', () => {
      const { ev } = signEvent('hello');
      const tampered = tamperedCopy(ev, { sig: '00'.repeat(64) });
      const out = verifiedAuthoredEvents([tampered]);
      expect(out).toHaveLength(0);
    });

    it('drops an event whose pubkey does not match expectedAuthor', () => {
      const { ev } = signEvent('hello');
      const { pk: otherPk } = signEvent('other');
      const out = verifiedAuthoredEvents([ev], otherPk);
      expect(out).toHaveLength(0);
    });

    it('keeps an event whose pubkey matches expectedAuthor (case-insensitive)', () => {
      const { ev, pk } = signEvent('hello');
      // Caller might pass the pubkey upper-cased — helper should normalise.
      const out = verifiedAuthoredEvents([ev], pk.toUpperCase());
      expect(out).toHaveLength(1);
    });

    it('mixes: keeps valid, drops invalid, drops wrong-author in one call', () => {
      const { ev: good, pk } = signEvent('keep');
      const { ev: badSig } = signEvent('drop1');
      const tampered = tamperedCopy(badSig, { sig: '00'.repeat(64) });
      const { ev: wrongAuthor } = signEvent('drop2'); // different pk
      const out = verifiedAuthoredEvents([good, tampered, wrongAuthor], pk);
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(good);
    });

    it('returns empty array on empty input', () => {
      expect(verifiedAuthoredEvents([])).toEqual([]);
    });
  });

  describe('verifiedAuthoredEvent', () => {
    it('returns the event when valid', () => {
      const { ev } = signEvent('hello');
      expect(verifiedAuthoredEvent(ev)).toBe(ev);
    });

    it('returns null on null/undefined input', () => {
      expect(verifiedAuthoredEvent(null)).toBeNull();
      expect(verifiedAuthoredEvent(undefined)).toBeNull();
    });

    it('returns null on bad signature', () => {
      const { ev } = signEvent('hello');
      const tampered = tamperedCopy(ev, { sig: '00'.repeat(64) });
      expect(verifiedAuthoredEvent(tampered)).toBeNull();
    });

    it('returns null on wrong author', () => {
      const { ev } = signEvent('hello');
      const { pk: otherPk } = signEvent('other');
      expect(verifiedAuthoredEvent(ev, otherPk)).toBeNull();
    });
  });
});
