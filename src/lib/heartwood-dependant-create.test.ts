import { describe, it, expect, vi } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { encodeNpub } from './signet';
import { nextDependantIndex, deriveDependantOnDevice, deriveExtraPersonaOnDevice, HeartwoodDeriveError, trackDeviceDerive } from './heartwood-dependant-create';

const NP = '1'.repeat(64);
const PERSONA = '2'.repeat(64);
const reply = (pk: string, purpose: string) => JSON.stringify({ npub: encodeNpub(hexToBytes(pk)), purpose, index: 0, personaName: purpose });

describe('nextDependantIndex', () => {
  it('is 0 for an empty roster', () => { expect(nextDependantIndex([])).toBe(0); });
  it('is max(derived index)+1 — never reuses a removed index', () => {
    expect(nextDependantIndex([{ derivationPath: 'dependant-0' }, { derivationPath: 'dependant-2' }])).toBe(3);
  });
  it('ignores imported / view-only paths', () => {
    expect(nextDependantIndex([{ derivationPath: 'imported-abcd1234' }, { derivationPath: 'imported-view-abcd1234' }])).toBe(0);
  });
});

describe('deriveDependantOnDevice', () => {
  it('derives NP then persona and returns keyless slots', async () => {
    const requestFn = vi.fn(async (_m: string, p: string[]) => p[0].endsWith('-np') ? reply(NP, p[0]) : reply(PERSONA, p[0]));
    const out = await deriveDependantOnDevice(requestFn, 'dependant-3');
    expect(out).toEqual({ naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' } });
    expect(requestFn.mock.calls.map((c) => c[1][0])).toEqual(['dependant-3-np', 'dependant-3-persona']);
  });
  it('rejects a malformed derivation path without touching the device', async () => {
    const requestFn = vi.fn();
    await expect(deriveDependantOnDevice(requestFn, 'imported-x')).rejects.toThrow(/derivation path/);
    expect(requestFn).not.toHaveBeenCalled();
  });
  it('surfaces storage-full as a typed error naming the token', async () => {
    const requestFn = vi.fn(async () => { throw new Error('identity storage full'); });
    const err = await deriveDependantOnDevice(requestFn, 'dependant-0').catch((e) => e);
    expect(err).toBeInstanceOf(HeartwoodDeriveError);
    expect((err as HeartwoodDeriveError).code).toBe('storage-full');
    expect((err as HeartwoodDeriveError).token).toBe('dependant-0-np');
  });
});

describe('deriveExtraPersonaOnDevice', () => {
  it('derives the raw derivationName token', async () => {
    const requestFn = vi.fn(async (_m: string, p: string[]) => reply(PERSONA, p[0]));
    expect(await deriveExtraPersonaOnDevice(requestFn, 'dependant-1-persona-2')).toEqual({ publicKey: PERSONA, privateKey: '' });
    expect(requestFn).toHaveBeenCalledWith('heartwood_derive_persona', ['dependant-1-persona-2']);
  });
});

describe('trackDeviceDerive (the "press and hold" hint shows only while the Heartwood is asked)', () => {
  it('brackets each call, success or failure', async () => {
    const seen: number[] = [];
    const ok = trackDeviceDerive(async (_name: string) => ({ publicKey: PERSONA, privateKey: '' as const }), d => seen.push(d));
    await expect(ok('persona-1')).resolves.toEqual({ publicKey: PERSONA, privateKey: '' });
    const bad = trackDeviceDerive(async (_name: string): Promise<never> => { throw new Error('denied'); }, d => seen.push(d));
    await expect(bad('persona-2')).rejects.toThrow('denied');
    expect(seen).toEqual([1, -1, 1, -1]);
  });
  it('signals before the device is asked, not after', async () => {
    const seen: number[] = [];
    let release!: () => void;
    const derive = trackDeviceDerive((_name: string) => new Promise(r => { release = () => r({ publicKey: PERSONA, privateKey: '' }); }), d => seen.push(d));
    const p = derive('persona-1');
    expect(seen).toEqual([1]);
    release(); await p;
    expect(seen).toEqual([1, -1]);
  });
});
