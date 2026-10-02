// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../relay-service', () => ({
  publishEvent: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
}));
const existing = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('../existing-profile', () => ({
  fetchExistingProfile: vi.fn(async () => existing.result),
}));

import { publishEvent } from '../relay-service';
import { publishProNameOnly } from './pro-persona';
import { renameOnlyKindZero } from '../public-profile-publish';
import type { SigningBackend } from '../signing-backend';

const PUB = 'b'.repeat(64);
const backend = {
  signEvent: vi.fn(async (t: Record<string, unknown>) => ({ ...t, id: 'i'.repeat(64), sig: 's'.repeat(128) })),
} as unknown as SigningBackend;
const published = () => (vi.mocked(publishEvent).mock.calls[0][0] as unknown as { content: string; tags: string[][]; created_at: number });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(publishEvent).mockResolvedValue({ ok: true, message: 'ok' });
  existing.result = null;
});

describe('renameOnlyKindZero', () => {
  it('sets display_name, keeps a handle, every other key and the tags verbatim', () => {
    const out = renameOnlyKindZero(
      { content: JSON.stringify({ name: 'handle', display_name: 'Old', bot: true, lud06: 'x' }), tags: [['t', 'a']] },
      'New Name',
    )!;
    expect(JSON.parse(out.content)).toEqual({ name: 'handle', display_name: 'New Name', bot: true, lud06: 'x' });
    expect(out.tags).toEqual([['t', 'a']]);
  });

  it('sets name only when the base has none', () => {
    const out = renameOnlyKindZero({ content: JSON.stringify({ about: 'hi' }), tags: [] }, 'New')!;
    expect(JSON.parse(out.content)).toEqual({ about: 'hi', name: 'New', display_name: 'New' });
  });

  it('falls back to name + display_name, no tags, for absent / non-object / tombstone bases', () => {
    for (const base of [undefined, { content: 'nope', tags: [['t', 'a']] }, { content: '[]', tags: [] }, { content: '{}', tags: [['t', 'a']] }]) {
      expect(renameOnlyKindZero(base, 'New')).toEqual({ content: '{"name":"New","display_name":"New"}', tags: [] });
    }
  });

  it('returns null for a name that sanitises to nothing', () => {
    expect(renameOnlyKindZero(undefined, '  ​ ')).toBeNull();
  });
});

describe('publishProNameOnly (Pro profile not enabled)', () => {
  it('renames within the existing kind-0 and never emits card fields', async () => {
    existing.result = { event: { content: JSON.stringify({ name: 'doc', about: 'Their own bio', picture: 'https://img.example/p.png' }), tags: [['client', 'x']], created_at: 5_000_000_000 } };
    await publishProNameOnly(PUB, 'Dr New', backend, ['wss://r.example']);
    const ev = published();
    expect(JSON.parse(ev.content)).toEqual({ name: 'doc', about: 'Their own bio', picture: 'https://img.example/p.png', display_name: 'Dr New' });
    expect(ev.tags).toEqual([['client', 'x']]);
    expect(ev.created_at).toBe(5_000_000_001);
  });

  it('publishes just name + display_name when there is no kind-0 or relays are unreachable', async () => {
    for (const result of [null, 'unreachable']) {
      vi.mocked(publishEvent).mockClear();
      existing.result = result;
      await publishProNameOnly(PUB, 'Dr New', backend, []);
      const ev = published();
      expect(JSON.parse(ev.content)).toEqual({ name: 'Dr New', display_name: 'Dr New' });
      expect(ev.tags).toEqual([]);
    }
  });

  it('throws when the publish fails', async () => {
    vi.mocked(publishEvent).mockResolvedValue({ ok: false, message: 'relay rejected' });
    await expect(publishProNameOnly(PUB, 'Dr New', backend, [])).rejects.toThrow('relay rejected');
  });
});
