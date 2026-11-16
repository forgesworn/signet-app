/**
 * Unit tests for the pure helpers in usePersonaInventory.ts.
 *
 * The hook itself (subscribe + merge into IDB) is exercised end-to-end via
 * Playwright; here we cover the synchronous merge logic that decides how
 * guardian-owned config and kid-owned publication state combine on a slot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeSlotPublicConfig, mergeInventory } from './usePersonaInventory';
import type { SignetIdentity } from '../types';
import type { PersonaInventoryPayload } from '../lib/persona-inventory-sync';

vi.mock('../lib/db', () => ({
  loadPairedChildPersonaRevision: vi.fn(),
  loadIdentityDecrypted: vi.fn(),
  saveIdentityEncrypted: vi.fn(),
  savePairedChildPersonaRevision: vi.fn(),
}));

import * as db from '../lib/db';
const mockLoadRev = vi.mocked(db.loadPairedChildPersonaRevision);
const mockLoadId = vi.mocked(db.loadIdentityDecrypted);
const mockSaveId = vi.mocked(db.saveIdentityEncrypted);
const mockSaveRev = vi.mocked(db.savePairedChildPersonaRevision);

describe('mergeSlotPublicConfig', () => {
  it('returns undefined config + undefined state when wire absent and local absent', () => {
    const { config, state } = mergeSlotPublicConfig(undefined, undefined, undefined);
    expect(config).toBeUndefined();
    expect(state).toBeUndefined();
  });

  it('returns local config + local state verbatim when wire is absent (eg older guardian publish)', () => {
    const localConfig = { displayName: 'Kid Local', about: 'a bio' };
    const localState = {
      enabled: true,
      lastEventId: 'b'.repeat(64),
      lastPublishedAt: 1700000000,
    };
    const { config, state } = mergeSlotPublicConfig(undefined, localConfig, localState);
    expect(config).toBe(localConfig);
    expect(state).toBe(localState);
  });

  it('takes config from wire and preserves local state when both present', () => {
    const { config, state } = mergeSlotPublicConfig(
      { enabled: true, displayName: 'Updated Display', about: 'New bio' },
      { displayName: 'Old', about: 'Old bio' },
      {
        enabled: true,
        lastEventId: 'a'.repeat(64),
        lastPublishedAt: 1700000000,
        lastPublishedRelay: 'wss://relay.example.com',
      },
    );
    expect(config).toBeDefined();
    expect(config!.displayName).toBe('Updated Display');
    expect(config!.about).toBe('New bio');
    // State preserved verbatim apart from `enabled` taking wire's value.
    expect(state).toBeDefined();
    expect(state!.enabled).toBe(true);
    expect(state!.lastEventId).toBe('a'.repeat(64));
    expect(state!.lastPublishedAt).toBe(1700000000);
    expect(state!.lastPublishedRelay).toBe('wss://relay.example.com');
  });

  it('reflects wire enabled=false on state (guardian disabled propagates)', () => {
    const { state } = mergeSlotPublicConfig(
      { enabled: false, displayName: 'Whatever' },
      { displayName: 'Whatever' },
      {
        enabled: true,
        lastEventId: 'c'.repeat(64),
        lastPublishedAt: 1700000000,
        lastPublishedRelay: 'wss://relay.example.com',
      },
    );
    expect(state!.enabled).toBe(false);
    // State preserved so kid can later retract referencing the last event id.
    expect(state!.lastEventId).toBe('c'.repeat(64));
  });

  it('takes config from wire when local config is absent', () => {
    const { config, state } = mergeSlotPublicConfig(
      { enabled: true, displayName: 'Wire-only', about: 'Wire bio', nip05: 'wire@example.com' },
      undefined,
      undefined,
    );
    expect(config!.displayName).toBe('Wire-only');
    expect(config!.about).toBe('Wire bio');
    expect(config!.nip05).toBe('wire@example.com');
    expect(state!.enabled).toBe(true);
    expect(state!.lastEventId).toBeUndefined();
    expect(state!.lastPublishedAt).toBeUndefined();
    expect(state!.lastPublishedRelay).toBeUndefined();
  });

  it('clears local config fields the guardian dropped (wire-wins-wipes)', () => {
    // Wire carries enabled + displayName only — guardian cleared `about`
    // and `nip05` on their device. The merged record must drop those fields
    // so deletions propagate to the kid (matches original mergePublicProfile
    // behaviour pre Phase 1 T6 split).
    const { config } = mergeSlotPublicConfig(
      { enabled: true, displayName: 'Still set' },
      { displayName: 'Still set', about: 'used to have an about line', nip05: 'used@example.com' },
      { enabled: true },
    );
    expect(config!.displayName).toBe('Still set');
    expect(config!.about).toBeUndefined();
    expect(config!.nip05).toBeUndefined();
  });

  it('falls back to legacy `name` wire field when `displayName` is absent', () => {
    // Older guardian payloads carried `name` instead of `displayName`. The
    // wire interface keeps both keys so older publishers don't wipe the kid's
    // displayName during the migration window.
    const { config } = mergeSlotPublicConfig(
      { enabled: true, name: 'Legacy Name' },
      { displayName: 'Local' },
      undefined,
    );
    expect(config!.displayName).toBe('Legacy Name');
  });
});

describe('mergeInventory persona slot preserves local config (sweep-2 low)', () => {
  const DEP_PUB = 'a'.repeat(64);
  const NP_PUB = 'b'.repeat(64);
  const PERSONA_PUB = 'c'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadRev.mockResolvedValue(0);
    mockSaveId.mockResolvedValue(undefined as never);
    mockSaveRev.mockResolvedValue(undefined as never);
  });

  it('preserves kid persona local kind-0 config when guardian inventory omits persona.publicProfile block', async () => {
    // Older guardian (or mid-rollout) publishes the inventory with a persona
    // entry but WITHOUT a `publicProfile` block. Before fix, the persona slot
    // was rebuilt from scratch and `applyConfigWithWipes(false, _) => {}`
    // silently wiped the kid's locally-cached config fields (about, pictureUrl,
    // etc.). With fix, `...stored.persona` is spread first so unwiped fields
    // survive.
    const stored: SignetIdentity = {
      id: DEP_PUB,
      mnemonic: '',
      naturalPerson: { publicKey: NP_PUB, privateKey: '', displayName: 'Kid NP' },
      persona: {
        publicKey: PERSONA_PUB,
        privateKey: '',
        displayName: 'Kid Persona',
        about: 'preserved-about',
        pictureUrl: 'https://preserved.example/pic.jpg',
        nip05: 'preserved@example.com',
      },
      extraPersonas: [],
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity;
    mockLoadId.mockResolvedValue(stored);

    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Kid NP' },
      // Persona is present on the wire, but with NO `publicProfile` block.
      persona: { publicKey: PERSONA_PUB, displayName: 'Kid Persona' },
      extraPersonas: [],
    };

    await mergeInventory(payload, DEP_PUB, 'test-key');

    expect(mockSaveId).toHaveBeenCalledOnce();
    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    // The persona's local config must persist when wire omits publicProfile.
    expect(savedIdentity.persona.about).toBe('preserved-about');
    expect(savedIdentity.persona.pictureUrl).toBe('https://preserved.example/pic.jpg');
    expect(savedIdentity.persona.nip05).toBe('preserved@example.com');
  });
});

describe('mergeInventory clears stale NIP-05 check result on nip05 change (review fix)', () => {
  const DEP_PUB = 'a'.repeat(64);
  const NP_PUB = 'b'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadRev.mockResolvedValue(0);
    mockSaveId.mockResolvedValue(undefined as never);
    mockSaveRev.mockResolvedValue(undefined as never);
  });

  it("clears the kid's stored NIP-05 check result when the guardian's wire nip05 differs from the stored one", async () => {
    const stored: SignetIdentity = {
      id: DEP_PUB,
      mnemonic: '',
      naturalPerson: {
        publicKey: NP_PUB,
        privateKey: '',
        displayName: 'Kid NP',
        nip05: 'old@example.com',
        nip05CheckResult: 'match',
        nip05CheckedAt: 1_700_000_000_000,
      },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      extraPersonas: [],
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity;
    mockLoadId.mockResolvedValue(stored);

    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      naturalPerson: {
        publicKey: NP_PUB,
        displayName: 'Kid NP',
        publicProfile: { enabled: true, displayName: 'Kid NP', nip05: 'new@example.com' },
      },
      extraPersonas: [],
    };

    await mergeInventory(payload, DEP_PUB, 'test-key');

    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    expect(savedIdentity.naturalPerson.nip05).toBe('new@example.com');
    expect(savedIdentity.naturalPerson.nip05CheckResult).toBeUndefined();
    expect(savedIdentity.naturalPerson.nip05CheckedAt).toBeUndefined();
  });

  it("preserves the kid's stored NIP-05 check result when the guardian's wire nip05 is unchanged", async () => {
    const stored: SignetIdentity = {
      id: DEP_PUB,
      mnemonic: '',
      naturalPerson: {
        publicKey: NP_PUB,
        privateKey: '',
        displayName: 'Kid NP',
        nip05: 'same@example.com',
        nip05CheckResult: 'match',
        nip05CheckedAt: 1_700_000_000_000,
      },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      extraPersonas: [],
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity;
    mockLoadId.mockResolvedValue(stored);

    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      naturalPerson: {
        publicKey: NP_PUB,
        displayName: 'Kid NP Renamed',
        publicProfile: { enabled: true, displayName: 'Kid NP Renamed', nip05: 'same@example.com' },
      },
      extraPersonas: [],
    };

    await mergeInventory(payload, DEP_PUB, 'test-key');

    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    expect(savedIdentity.naturalPerson.nip05).toBe('same@example.com');
    expect(savedIdentity.naturalPerson.nip05CheckResult).toBe('match');
    expect(savedIdentity.naturalPerson.nip05CheckedAt).toBe(1_700_000_000_000);
  });

  it("preserves a stored publicProfileBase (device-local kind-0 base) when the wire carries new config", async () => {
    const base = { eventId: 'e'.repeat(64), createdAt: 1, content: '{"bot":true}', tags: [] };
    const stored = {
      id: DEP_PUB,
      mnemonic: '',
      naturalPerson: { publicKey: NP_PUB, privateKey: '', displayName: 'Kid NP', about: 'old', publicProfileBase: base },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      extraPersonas: [],
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity;
    mockLoadId.mockResolvedValue(stored);
    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Kid NP', publicProfile: { enabled: true, displayName: 'Kid NP', about: 'new' } },
      extraPersonas: [],
    };
    await mergeInventory(payload, DEP_PUB, 'test-key');
    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    expect(savedIdentity.naturalPerson.about).toBe('new');
    expect(savedIdentity.naturalPerson.publicProfileBase).toEqual(base);
  });

  it("preserves a stored followsImport (device-local follow import) when the wire carries new config", async () => {
    const base = { eventId: 'e'.repeat(64), createdAt: 1_700_000_000, importedAt: 1_700_000_100_000, count: 321 };
    const stored = {
      id: DEP_PUB,
      mnemonic: '',
      naturalPerson: { publicKey: NP_PUB, privateKey: '', displayName: 'Kid NP', about: 'old', followsImport: base },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      extraPersonas: [],
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity;
    mockLoadId.mockResolvedValue(stored);
    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Kid NP', publicProfile: { enabled: true, displayName: 'Kid NP', about: 'new' } },
      extraPersonas: [],
    };
    await mergeInventory(payload, DEP_PUB, 'test-key');
    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    expect(savedIdentity.naturalPerson.about).toBe('new');
    expect(savedIdentity.naturalPerson.followsImport).toEqual(base);
  });
});

describe('mergeInventory omits a dormant real identity (spec §7.6)', () => {
  const DEP_PUB = 'a'.repeat(64);
  // Persona-first dependant: `id` IS the persona pubkey.
  const PERSONA_PUB = DEP_PUB;
  const NP_PUB = 'b'.repeat(64);

  // App.tsx's pair-time seed writes `naturalPerson.publicKey =
  // parsed.dependantPubkey`, which for a persona-first dependant equals the
  // persona pubkey — the "pair-time NP stub" this fix clears.
  const pairTimeStub: SignetIdentity = {
    id: DEP_PUB,
    mnemonic: '',
    naturalPerson: { publicKey: PERSONA_PUB, privateKey: '', displayName: '' },
    persona: { publicKey: PERSONA_PUB, privateKey: '', displayName: 'Lily' },
    extraPersonas: [],
    primaryKeypair: 'natural-person',
  } as unknown as SignetIdentity;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadRev.mockResolvedValue(0);
    mockSaveId.mockResolvedValue(undefined as never);
    mockSaveRev.mockResolvedValue(undefined as never);
  });

  it('clears the pair-time NP stub and flips primary to persona when the wire omits naturalPerson', async () => {
    mockLoadId.mockResolvedValue(pairTimeStub);

    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      persona: { publicKey: PERSONA_PUB, displayName: 'Lily' },
      extraPersonas: [],
    };

    await mergeInventory(payload, DEP_PUB, 'test-key');

    expect(mockSaveId).toHaveBeenCalledOnce();
    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    expect(savedIdentity.naturalPerson).toEqual({ publicKey: '', privateKey: '', displayName: '' });
    expect(savedIdentity.primaryKeypair).toBe('persona');
    expect(savedIdentity.naturalPersonActive).toBe(false);
    // Persona slot is untouched by the NP-omission branch.
    expect(savedIdentity.persona.publicKey).toBe(PERSONA_PUB);
    expect(savedIdentity.persona.displayName).toBe('Lily');
  });

  it('A61: a dormant (empty-key) NP takes the active NP key from the payload', async () => {
    mockLoadId.mockResolvedValue({
      ...pairTimeStub,
      naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
      naturalPersonActive: false,
    } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 1,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Lily Rivera' },
      persona: { publicKey: PERSONA_PUB, displayName: 'Lily' },
      extraPersonas: [],
    } as PersonaInventoryPayload, DEP_PUB, 'test-key');
    const saved = mockSaveId.mock.calls[0][0] as SignetIdentity;
    expect(saved.naturalPerson.publicKey).toBe(NP_PUB);
    expect(saved.naturalPersonActive).toBe(true);
  });

  it('leaves the naturalPerson merge and primaryKeypair exactly as before this task when the wire carries naturalPerson', async () => {
    mockLoadId.mockResolvedValue(pairTimeStub);

    // Wire naturalPerson.publicKey matches the stub's (as it always would
    // for a real device — the kid's NP publicKey is seeded at pair time and
    // never changes). NP `publicKey`/`privateKey`/`displayName` are pinned
    // to the stored seed by design (see mergeInventory's doc comment); only
    // avatar + publicProfile config flow through from the wire — same as
    // before this task.
    const payload: PersonaInventoryPayload = {
      v: 1,
      revision: 1,
      naturalPerson: {
        publicKey: NP_PUB,
        displayName: 'Lily Rivera',
        avatarHash: 'c'.repeat(64),
        avatarBlossomUrl: 'https://blossom.example/pic',
        avatarKey: 'd'.repeat(64),
        publicProfile: { enabled: true, displayName: 'Lily Rivera' },
      },
      persona: { publicKey: PERSONA_PUB, displayName: 'Lily' },
      extraPersonas: [],
    };

    await mergeInventory(payload, DEP_PUB, 'test-key');

    const savedIdentity = mockSaveId.mock.calls[0][0] as SignetIdentity;
    // publicKey/privateKey/displayName untouched — still the stored stub.
    expect(savedIdentity.naturalPerson.publicKey).toBe(NP_PUB);
    expect(savedIdentity.naturalPerson.displayName).toBe('');
    // Avatar + publicProfile config DO flow through from the wire.
    expect(savedIdentity.naturalPerson.avatarHash).toBe('c'.repeat(64));
    expect(savedIdentity.naturalPerson.publicProfile?.enabled).toBe(true);
    expect(savedIdentity.primaryKeypair).toBe('natural-person');
    expect(savedIdentity.naturalPersonActive).toBe(true);
  });
});

describe('mergeInventory on a child-direct install (bound persona pinned, A26/A50/A51)', () => {
  const DEP_PUB = 'a'.repeat(64);
  const BOUND = 'b'.repeat(64);
  const NP_PUB = 'c'.repeat(64);
  const EXTRA = 'e'.repeat(64);
  const NEW_EXTRA = 'f'.repeat(64);
  const direct = { boundPersona: BOUND };

  // The stub a direct pairing writes (childDirectStubIdentity), after one
  // earlier merge brought in an extra.
  const directStub = (): SignetIdentity => ({
    id: DEP_PUB,
    mnemonic: '',
    naturalPerson: { publicKey: '', privateKey: '', displayName: 'Lily' },
    persona: { publicKey: BOUND, privateKey: '', displayName: 'Lily', about: 'kept-about' },
    extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer', derivationName: '' }],
    primaryKeypair: 'persona',
    naturalPersonActive: false,
  } as unknown as SignetIdentity);

  const saved = () => mockSaveId.mock.calls[0][0] as SignetIdentity;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadRev.mockResolvedValue(0);
    mockSaveId.mockResolvedValue(undefined as never);
    mockSaveRev.mockResolvedValue(undefined as never);
  });

  it('a persona added after pairing is merged in as an extra with no private key', async () => {
    mockLoadId.mockResolvedValue(directStub());
    await mergeInventory({
      v: 1, revision: 2,
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [{ publicKey: EXTRA, displayName: 'Gamer' }, { publicKey: NEW_EXTRA, displayName: 'Artist' }],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().extraPersonas?.map(x => [x.publicKey, x.displayName, x.privateKey])).toEqual([
      [EXTRA, 'Gamer', ''], [NEW_EXTRA, 'Artist', ''],
    ]);
    expect(saved().persona.publicKey).toBe(BOUND);
    expect(saved().naturalPerson.publicKey).toBe('');
    expect(saved().naturalPersonActive).toBe(false);
    expect(saved().primaryKeypair).toBe('persona');
  });

  it('keeps the stored bound persona when the guardian hides it from the phone', async () => {
    mockLoadId.mockResolvedValue(directStub());
    await mergeInventory({
      v: 1, revision: 2,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Lily Rivera' },
      extraPersonas: [{ publicKey: EXTRA, displayName: 'Gamer' }],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().persona.publicKey).toBe(BOUND);
    expect(saved().persona.displayName).toBe('Lily');
    expect(saved().persona.about).toBe('kept-about');
    expect(saved().persona.privateKey).toBe('');
    expect(saved().primaryKeypair).toBe('persona');
  });

  it('keeps the bound persona when the persona slot names another key, and drops that key', async () => {
    const OTHER = '7'.repeat(64);
    mockLoadId.mockResolvedValue(directStub());
    await mergeInventory({
      v: 1, revision: 2,
      persona: { publicKey: OTHER, displayName: 'Someone else' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().persona.publicKey).toBe(BOUND);
    expect(saved().persona.displayName).toBe('Lily');
    expect(saved().extraPersonas?.map(x => x.publicKey)).not.toContain(OTHER);
  });

  it('never lists the bound persona a second time as an extra', async () => {
    mockLoadId.mockResolvedValue(directStub());
    await mergeInventory({
      v: 1, revision: 2,
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [{ publicKey: BOUND, displayName: 'Lily again' }, { publicKey: EXTRA, displayName: 'Gamer' }],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().extraPersonas?.map(x => x.publicKey)).toEqual([EXTRA]);
  });

  it('a real-identity entry carrying the bound key is treated as absent (A50)', async () => {
    mockLoadId.mockResolvedValue(directStub());
    await mergeInventory({
      v: 1, revision: 2,
      naturalPerson: { publicKey: BOUND, displayName: 'Lily' },
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().naturalPerson).toEqual({ publicKey: '', privateKey: '', displayName: '' });
    expect(saved().naturalPersonActive).toBe(false);
    expect(saved().primaryKeypair).toBe('persona');
  });

  it('a vanished primary extra falls back to the bound persona, never the real-identity slot', async () => {
    mockLoadId.mockResolvedValue({ ...directStub(), primaryKeypair: EXTRA } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 2,
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().primaryKeypair).toBe('persona');
  });

  it('a primary extra that vanishes while the real identity is active still falls back to the bound persona', async () => {
    mockLoadId.mockResolvedValue({ ...directStub(), primaryKeypair: EXTRA } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 2,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Lily Rivera' },
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().primaryKeypair).toBe('persona');
    expect(saved().naturalPerson.publicKey).toBe(NP_PUB);
    expect(saved().naturalPersonActive).toBe(true);
  });

  it('a real-identity primary is moved to the bound persona once the inventory says it is dormant', async () => {
    mockLoadId.mockResolvedValue({
      ...directStub(),
      naturalPerson: { publicKey: NP_PUB, privateKey: '', displayName: 'Lily Rivera' },
      naturalPersonActive: true,
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 2,
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().naturalPerson.publicKey).toBe('');
    expect(saved().naturalPersonActive).toBe(false);
    expect(saved().primaryKeypair).toBe('persona');
  });

  it('an active real-identity primary stays primary', async () => {
    mockLoadId.mockResolvedValue({
      ...directStub(),
      naturalPerson: { publicKey: NP_PUB, privateKey: '', displayName: 'Lily Rivera' },
      naturalPersonActive: true,
      primaryKeypair: 'natural-person',
    } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 2,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Lily Rivera' },
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().primaryKeypair).toBe('natural-person');
  });

  it('private keys stay empty in every slot, even if the stored record held one', async () => {
    mockLoadId.mockResolvedValue({
      ...directStub(),
      naturalPerson: { publicKey: NP_PUB, privateKey: '9'.repeat(64), displayName: 'Lily Rivera' },
      persona: { publicKey: BOUND, privateKey: '9'.repeat(64), displayName: 'Lily' },
      naturalPersonActive: true,
    } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 2,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Lily Rivera' },
      extraPersonas: [{ publicKey: NEW_EXTRA, displayName: 'Artist' }],
    }, DEP_PUB, 'test-key', direct);
    expect(saved().naturalPerson.privateKey).toBe('');
    expect(saved().persona.privateKey).toBe('');
    expect(saved().extraPersonas?.every(x => x.privateKey === '')).toBe(true);
  });

  it('an invalid bound persona merges nothing', async () => {
    mockLoadId.mockResolvedValue(directStub());
    await mergeInventory({
      v: 1, revision: 2,
      persona: { publicKey: BOUND, displayName: 'Lily' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key', { boundPersona: 'not-a-key' });
    expect(mockSaveId).not.toHaveBeenCalled();
    expect(mockSaveRev).not.toHaveBeenCalled();
  });

  it('legacy (no direct option): a hidden persona is still blanked and primary falls back to the real identity', async () => {
    mockLoadId.mockResolvedValue({
      ...directStub(),
      naturalPerson: { publicKey: NP_PUB, privateKey: '', displayName: 'Lily Rivera' },
      naturalPersonActive: true,
    } as unknown as SignetIdentity);
    await mergeInventory({
      v: 1, revision: 2,
      naturalPerson: { publicKey: NP_PUB, displayName: 'Lily Rivera' },
      extraPersonas: [],
    }, DEP_PUB, 'test-key');
    expect(saved().persona.publicKey).toBe('');
    expect(saved().primaryKeypair).toBe('natural-person');
  });
});
