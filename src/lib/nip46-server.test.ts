import { describe, it, expect, vi } from 'vitest';
import { parseSignEventTemplate, describeEventTemplate, parseInboundRequest, MAX_NIP46_CONTENT, MAX_NIP46_PARAMS } from './nip46-server';
import type { NostrEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';

describe('parseInboundRequest — input bounds (security audit 2026-06-15)', () => {
  const makeEvent = (content: string): NostrEvent => ({
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: 24133,
    created_at: 1,
    tags: [],
    content,
    sig: 's'.repeat(128),
  } as NostrEvent);

  it('rejects oversized envelope content WITHOUT attempting to decrypt', async () => {
    const nip44Decrypt = vi.fn(async () => '{}');
    const backend = { nip44Decrypt } as unknown as DecryptingSigningBackend;
    const oversized = 'x'.repeat(MAX_NIP46_CONTENT + 1);
    const result = await parseInboundRequest(makeEvent(oversized), backend);
    expect(result).toBeNull();
    expect(nip44Decrypt).not.toHaveBeenCalled();
  });

  it('rejects a request with too many params', async () => {
    const tooMany = JSON.stringify({
      id: '1', method: 'sign_event',
      params: Array.from({ length: MAX_NIP46_PARAMS + 1 }, (_, i) => String(i)),
    });
    const backend = { nip44Decrypt: async () => tooMany } as unknown as DecryptingSigningBackend;
    const result = await parseInboundRequest(makeEvent('cipher'), backend);
    expect(result).toBeNull();
  });

  it('accepts a normal in-bounds request', async () => {
    const ok = JSON.stringify({ id: '1', method: 'sign_event', params: ['{}'] });
    const backend = { nip44Decrypt: async () => ok } as unknown as DecryptingSigningBackend;
    const result = await parseInboundRequest(makeEvent('cipher'), backend);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('sign_event');
  });
});

describe('parseSignEventTemplate', () => {
  const valid = {
    kind: 1,
    pubkey: 'a'.repeat(64),
    created_at: 123,
    tags: [['t', 'test']],
    content: 'hello',
  };

  it('accepts a well-formed template', () => {
    const parsed = parseSignEventTemplate(JSON.stringify(valid));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe(1);
    expect(parsed!.content).toBe('hello');
  });

  it('rejects non-JSON', () => {
    expect(parseSignEventTemplate('not json')).toBeNull();
  });

  it('rejects non-object', () => {
    expect(parseSignEventTemplate('[]')).toBeNull();
    expect(parseSignEventTemplate('"string"')).toBeNull();
    expect(parseSignEventTemplate('42')).toBeNull();
    expect(parseSignEventTemplate('null')).toBeNull();
  });

  it('rejects missing kind', () => {
    const bad = { ...valid, kind: undefined as unknown as number };
    expect(parseSignEventTemplate(JSON.stringify(bad))).toBeNull();
  });

  it('rejects missing content', () => {
    const bad = { ...valid };
    delete (bad as { content?: string }).content;
    expect(parseSignEventTemplate(JSON.stringify(bad))).toBeNull();
  });

  it('rejects missing created_at', () => {
    const bad = { ...valid };
    delete (bad as { created_at?: number }).created_at;
    expect(parseSignEventTemplate(JSON.stringify(bad))).toBeNull();
  });

  it('rejects non-array tags', () => {
    const bad = { ...valid, tags: 'not-an-array' };
    expect(parseSignEventTemplate(JSON.stringify(bad))).toBeNull();
  });

  it('rejects tags with non-string members', () => {
    const bad = { ...valid, tags: [['t', 42]] };
    expect(parseSignEventTemplate(JSON.stringify(bad))).toBeNull();
  });

  it('rejects tags with non-array entries', () => {
    const bad = { ...valid, tags: ['oops'] };
    expect(parseSignEventTemplate(JSON.stringify(bad))).toBeNull();
  });

  it('tolerates missing pubkey (client might leave it to the signer to fill)', () => {
    const bad = { ...valid };
    delete (bad as { pubkey?: string }).pubkey;
    const parsed = parseSignEventTemplate(JSON.stringify(bad));
    expect(parsed).not.toBeNull();
    expect(parsed!.pubkey).toBe('');
  });

  it('rejects non-integer or out-of-range kinds', () => {
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, kind: 1.5 }))).toBeNull();
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, kind: -1 }))).toBeNull();
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, kind: 65536 }))).toBeNull();
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, kind: 999_999 }))).toBeNull();
  });

  it('rejects non-finite or non-positive created_at', () => {
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, created_at: Number.NaN }))).toBeNull();
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, created_at: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, created_at: 0 }))).toBeNull();
    expect(parseSignEventTemplate(JSON.stringify({ ...valid, created_at: -1 }))).toBeNull();
  });
});

describe('describeEventTemplate', () => {
  function tpl(kind: number): import('signet-protocol').UnsignedEvent {
    return { kind, pubkey: 'a'.repeat(64), created_at: 0, tags: [], content: '' };
  }

  it('labels well-known kinds with friendly names', () => {
    expect(describeEventTemplate(tpl(1))).toContain('note');
    expect(describeEventTemplate(tpl(7))).toContain('reaction');
    expect(describeEventTemplate(tpl(21236))).toContain('sign-in challenge');
    expect(describeEventTemplate(tpl(30078))).toContain('app state');
  });

  it('labels kind 0 correctly (not falsy-rejected by the lookup)', () => {
    expect(describeEventTemplate(tpl(0))).toContain('profile update');
  });

  it('falls back to "kind N event" for unknown kinds', () => {
    expect(describeEventTemplate(tpl(99999))).toBe('kind 99999 event');
  });
});
