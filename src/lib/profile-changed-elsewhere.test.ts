// A first publish from a persona card must not silently replace a profile
// made in another Nostr app (signet-app-internal#194).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./relay-service', () => ({
  publishEvent: vi.fn().mockResolvedValue({ ok: true, message: '1/1 relays accepted' }),
  fetchEvents: vi.fn().mockResolvedValue([]),
  getRelayUrl: vi.fn(() => 'wss://relay.example'),
}));
const existingMock = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('./existing-profile', () => ({
  fetchExistingProfile: vi.fn(async () => existingMock.result),
}));

import { publishEvent } from './relay-service';
import { adoptRelayProfile, publishPublicProfile, type RelayProfileChange } from './public-profile-publish';
import type { PersonaPublicProfile, PublicProfileBase, PublicProfileConfig } from '../types';
import type { SigningBackend } from './signing-backend';

const BARK_CONTENT = JSON.stringify({ name: 'casey', display_name: 'Casey', about: 'Set in a web client', picture: 'https://img.example/c.png' });
const BARK_EVENT = { id: 'f'.repeat(64), created_at: 5000, content: BARK_CONTENT, tags: [] as string[][] };
const BARK_BASE: PublicProfileBase = { eventId: BARK_EVENT.id, createdAt: 5000, content: BARK_CONTENT, tags: [] };
const fromBark = () => ({
  event: BARK_EVENT,
  profile: { displayName: 'Casey', about: 'Set in a web client', pictureUrl: 'https://img.example/c.png' },
  base: BARK_BASE,
  relay: 'wss://relay.example',
});
// The card as My Signet made it: a name, nothing else.
const card: PublicProfileConfig = { displayName: 'Old name' };

let signed: unknown[];
const backend = (): SigningBackend => ({
  activePublicKeyHex: 'c'.repeat(64),
  signEvent: vi.fn(async (u: object) => { signed.push(u); return { ...u, id: 'd'.repeat(64), sig: 'e'.repeat(128), pubkey: 'c'.repeat(64) }; }),
  nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn(), destroy: vi.fn(),
}) as unknown as SigningBackend;

beforeEach(() => {
  signed = [];
  existingMock.result = null;
  vi.mocked(publishEvent).mockClear();
});

describe('publishPublicProfile, unbasedRelayChange', () => {
  it('"ask": no base and a profile made elsewhere returns relayChange and publishes nothing', async () => {
    existingMock.result = fromBark();
    const res = await publishPublicProfile(card, undefined, 'Old name', backend(), 'wss://relay.example', undefined, { unbasedRelayChange: 'ask' });
    expect(res.ok).toBe(false);
    expect(res.relayChange?.event.id).toBe(BARK_EVENT.id);
    expect(res.relayChange?.event.created_at).toBe(5000);
    expect(signed).toHaveLength(0);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('"replace" (and the default) publishes as before', async () => {
    for (const unbased of ['replace', undefined] as const) {
      existingMock.result = fromBark();
      signed = [];
      const res = await publishPublicProfile(card, undefined, 'Old name', backend(), 'wss://relay.example', undefined, { unbasedRelayChange: unbased });
      expect(res.ok).toBe(true);
      expect(res.relayChange).toBeUndefined();
      expect(signed).toHaveLength(1);
    }
  });

  it('does not ask when a stored base exists: the three-way merge keeps the other app\'s edit', async () => {
    existingMock.result = fromBark();
    const stored: PublicProfileBase = { eventId: 'a'.repeat(64), createdAt: 4000, content: JSON.stringify({ display_name: 'Old name' }), tags: [] };
    const res = await publishPublicProfile(card, undefined, 'Old name', backend(), 'wss://relay.example', undefined, { storedBase: stored, unbasedRelayChange: 'ask' });
    expect(res.relayChange).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('does not ask when the relay\'s copy is this device\'s own last publish', async () => {
    existingMock.result = fromBark();
    const state: PersonaPublicProfile = { enabled: true, lastEventId: BARK_EVENT.id, lastPublishedAt: 5000, lastPublishedRelay: 'wss://relay.example' };
    const res = await publishPublicProfile(card, state, 'Old name', backend(), 'wss://relay.example', undefined, { unbasedRelayChange: 'ask' });
    expect(res.relayChange).toBeUndefined();
  });

  it('does not ask when publishing would not change the relay\'s profile', async () => {
    existingMock.result = fromBark();
    const same: PublicProfileConfig = { displayName: 'Casey', about: 'Set in a web client', pictureUrl: 'https://img.example/c.png' };
    const res = await publishPublicProfile(same, undefined, 'Casey', backend(), 'wss://relay.example', undefined, { unbasedRelayChange: 'ask' });
    expect(res.relayChange).toBeUndefined();
  });

  it('does not ask when the relay has nothing', async () => {
    for (const looked of [null, 'unreachable']) {
      existingMock.result = looked;
      const res = await publishPublicProfile(card, undefined, 'Old name', backend(), 'wss://relay.example', undefined, { unbasedRelayChange: 'ask' });
      expect(res.relayChange).toBeUndefined();
    }
  });
});

describe('adoptRelayProfile ("Use that version")', () => {
  const change: RelayProfileChange = { event: { id: BARK_EVENT.id, created_at: 5000, content: BARK_CONTENT }, profile: fromBark().profile, base: BARK_BASE, relay: 'wss://relay.example' };

  it('makes the card the relay profile exactly, clearing fields it lacks', () => {
    const full: PublicProfileConfig = { displayName: 'Old name', nip05: 'old@example.com', website: 'https://old.example', pictureUrl: 'https://img.example/old.png', pictureBlossomHash: 'h'.repeat(64) };
    const { config } = adoptRelayProfile(change, full, { adoptName: true });
    expect(config.about).toBe('Set in a web client');
    expect(config.pictureUrl).toBe('https://img.example/c.png');
    expect(config.pictureBlossomHash).toBeUndefined();
    expect(config.nip05).toBeUndefined();
    expect(config.website).toBeUndefined();
  });

  it('records the slot as published with that event, so nothing is sent and the next publish merges onto it', () => {
    const { state, base } = adoptRelayProfile(change, card, { adoptName: true });
    expect(state).toMatchObject({ enabled: true, lastEventId: BARK_EVENT.id, lastPublishedAt: 5000, lastPublishedRelay: 'wss://relay.example' });
    expect(state.lastPublishedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(base).toEqual(BARK_BASE);
  });

  it('takes the name only when allowed', () => {
    expect(adoptRelayProfile(change, card, { adoptName: true }).name).toBe('Casey');
    const np = adoptRelayProfile(change, card, { adoptName: false });
    expect(np.name).toBeUndefined();
    expect(np.config.displayName).toBe('Old name');
  });
});
