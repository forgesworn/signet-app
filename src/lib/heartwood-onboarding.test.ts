import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveOnboardingKeys, HeartwoodOnboardingError, HEARTWOOD_ONBOARDING_COPY } from './heartwood-onboarding';
import { encodeNpub, hexToBytes } from './signet';

const MASTER = '0'.repeat(63) + '1';
const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);

const listJson = (rows: Array<{ pubkey: string; purpose: string }>) =>
  JSON.stringify(rows.map((r) => ({ npub: 'x', pubkey: r.pubkey, purpose: r.purpose, index: 0 })));
const deriveJson = (hex: string, purpose: string) =>
  JSON.stringify({ npub: encodeNpub(hexToBytes(hex)), purpose, index: 0, personaName: 'x' });

type Handler = (method: string, params: string[]) => Promise<string>;
const fake = (h: Handler) => vi.fn(h);

afterEach(() => { vi.useRealTimers(); });

describe('resolveOnboardingKeys', () => {
  it('uses an already-listed NP and persona without deriving', async () => {
    const rf = fake(async (m) => {
      if (m === 'heartwood_list_identities') {
        return listJson([
          { pubkey: NP, purpose: 'nostr:persona:natural-person' },
          { pubkey: PERSONA, purpose: 'nostr:persona:persona' },
        ]);
      }
      throw new Error('unexpected ' + m);
    });
    expect(await resolveOnboardingKeys(rf, MASTER)).toEqual({ kind: 'heartwood', naturalPerson: NP, persona: PERSONA });
    expect(rf.mock.calls.filter(c => c[0] === 'heartwood_derive_persona')).toHaveLength(0);
  });

  it('derives both when the list is empty', async () => {
    const rf = fake(async (m, p) => {
      if (m === 'heartwood_list_identities') return '[]';
      if (m === 'heartwood_derive_persona') {
        return p[0] === 'natural-person' ? deriveJson(NP, 'natural-person') : deriveJson(PERSONA, 'persona');
      }
      throw new Error('unexpected ' + m);
    });
    expect(await resolveOnboardingKeys(rf, MASTER)).toEqual({ kind: 'heartwood', naturalPerson: NP, persona: PERSONA });
    expect(rf.mock.calls.filter(c => c[0] === 'heartwood_derive_persona').map(c => c[1][0])).toEqual(['natural-person', 'persona']);
  });

  it('derives only the missing persona when NP is listed', async () => {
    const rf = fake(async (m, p) => {
      if (m === 'heartwood_list_identities') return listJson([{ pubkey: NP, purpose: 'nostr:persona:natural-person' }]);
      return deriveJson(PERSONA, p[0]);
    });
    expect(await resolveOnboardingKeys(rf, MASTER)).toEqual({ kind: 'heartwood', naturalPerson: NP, persona: PERSONA });
    expect(rf.mock.calls.filter(c => c[0] === 'heartwood_derive_persona').map(c => c[1][0])).toEqual(['persona']);
  });

  it('throws unreachable when the list call times out (never generic)', async () => {
    vi.useFakeTimers();
    const rf = fake(() => new Promise<string>(() => {}));
    const p = resolveOnboardingKeys(rf, MASTER);
    const assertion = expect(p).rejects.toMatchObject({ reason: 'unreachable', message: HEARTWOOD_ONBOARDING_COPY.unreachable });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(rf).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown method', 'Method not supported', 'not implemented'])('returns generic when the device replies "%s"', async (msg) => {
    const rf = fake(() => Promise.reject(msg));
    expect(await resolveOnboardingKeys(rf, MASTER)).toEqual({ kind: 'generic' });
  });

  it.each(['user denied', 'timeout', 'unauthorised'])('throws not-approved when the device refuses the list with "%s"', async (msg) => {
    const rf = fake(() => Promise.reject(msg));
    await expect(resolveOnboardingKeys(rf, MASTER)).rejects.toMatchObject({ reason: 'not-approved' });
  });

  it('throws unreachable when the list call fails with an Error (transport failure)', async () => {
    const rf = fake(async () => { throw new Error('Not connected to bunker'); });
    await expect(resolveOnboardingKeys(rf, MASTER)).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('throws not-approved when the NP derive times out, and never derives the persona', async () => {
    vi.useFakeTimers();
    const rf = fake((m) => (m === 'heartwood_list_identities' ? Promise.resolve('[]') : new Promise<string>(() => {})));
    const p = resolveOnboardingKeys(rf, MASTER, { deriveTimeoutMs: 5_000 });
    const assertion = expect(p).rejects.toMatchObject({ reason: 'not-approved' });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(rf.mock.calls.filter(c => c[0] === 'heartwood_derive_persona').map(c => c[1][0])).toEqual(['natural-person']);
  });

  it('throws storage-full when the device reports -4', async () => {
    const rf = fake(async (m) => {
      if (m === 'heartwood_list_identities') return '[]';
      return Promise.reject('identity storage full (-4)');
    });
    await expect(resolveOnboardingKeys(rf, MASTER)).rejects.toMatchObject({ reason: 'storage-full' });
  });

  it('throws bad-key when a derived key equals the master', async () => {
    const rf = fake(async (m, p) => {
      if (m === 'heartwood_list_identities') return '[]';
      return p[0] === 'natural-person' ? deriveJson(MASTER, 'natural-person') : deriveJson(PERSONA, 'persona');
    });
    const err = await resolveOnboardingKeys(rf, MASTER).catch((e) => e);
    expect(err).toBeInstanceOf(HeartwoodOnboardingError);
    expect(err.reason).toBe('bad-key');
  });

  it('throws bad-key when a listed key equals the master (case-insensitive)', async () => {
    const rf = fake(async () => listJson([
      { pubkey: MASTER.toUpperCase(), purpose: 'natural-person' },
      { pubkey: PERSONA, purpose: 'persona' },
    ]));
    await expect(resolveOnboardingKeys(rf, MASTER)).rejects.toMatchObject({ reason: 'bad-key' });
  });

  it('throws bad-key when NP equals persona', async () => {
    const rf = fake(async () => listJson([
      { pubkey: NP, purpose: 'natural-person' },
      { pubkey: NP, purpose: 'persona' },
    ]));
    await expect(resolveOnboardingKeys(rf, MASTER)).rejects.toMatchObject({ reason: 'bad-key' });
  });
});
