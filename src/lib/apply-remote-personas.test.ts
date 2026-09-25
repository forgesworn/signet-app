import { describe, it, expect } from 'vitest';
import type { ExtraPersona, RemotePersonasPatch, SignetIdentity } from '../types';
import { applyRemotePersonasPatch } from './apply-remote-personas';

function extra(overrides: Partial<ExtraPersona> = {}): ExtraPersona {
  return {
    publicKey: 'f'.repeat(64),
    privateKey: '',
    displayName: 'Persona One',
    derivationName: 'persona-1',
    updatedAt: 500,
    ...overrides,
  };
}

function identity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: 'test mnemonic',
    naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: 'Alice' },
    persona: { publicKey: 'd'.repeat(64), privateKey: 'e'.repeat(64), displayName: 'Anon' },
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: 1000,
    ...overrides,
  };
}

function patch(overrides: Partial<RemotePersonasPatch> = {}): RemotePersonasPatch {
  return { extraPersonas: [], tombstones: [], ...overrides };
}

describe('applyRemotePersonasPatch — private key preservation', () => {
  it('keeps a real local private key when the incoming record is keyless', () => {
    const local = identity({ extraPersonas: [extra({ privateKey: '1'.repeat(64) })] });
    const result = applyRemotePersonasPatch(local, patch({
      extraPersonas: [extra({ privateKey: '', displayName: 'Renamed Remotely', updatedAt: 900 })],
    }));
    expect(result.extraPersonas?.[0].privateKey).toBe('1'.repeat(64));
    expect(result.extraPersonas?.[0].displayName).toBe('Renamed Remotely');
  });

  it('does not invent a key when neither side has one', () => {
    const local = identity({ extraPersonas: [extra({ privateKey: '' })] });
    const result = applyRemotePersonasPatch(local, patch({ extraPersonas: [extra({ privateKey: '' })] }));
    expect(result.extraPersonas?.[0].privateKey).toBe('');
  });

  it('leaves a non-empty incoming key alone', () => {
    const local = identity({ extraPersonas: [extra({ privateKey: '1'.repeat(64) })] });
    const result = applyRemotePersonasPatch(local, patch({
      extraPersonas: [extra({ privateKey: '2'.repeat(64) })],
    }));
    expect(result.extraPersonas?.[0].privateKey).toBe('2'.repeat(64));
  });

  it('matches by derivationName, not array position', () => {
    const local = identity({
      extraPersonas: [
        extra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64), privateKey: '1'.repeat(64) }),
        extra({ derivationName: 'persona-2', publicKey: '9'.repeat(64), privateKey: '2'.repeat(64) }),
      ],
    });
    const result = applyRemotePersonasPatch(local, patch({
      extraPersonas: [
        extra({ derivationName: 'persona-2', publicKey: '9'.repeat(64), privateKey: '' }),
        extra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64), privateKey: '' }),
      ],
    }));
    expect(result.extraPersonas?.[0].privateKey).toBe('2'.repeat(64));
    expect(result.extraPersonas?.[1].privateKey).toBe('1'.repeat(64));
  });

  it('replaces the tombstone list wholesale', () => {
    const local = identity({ extraPersonaTombstones: [{ derivationName: 'persona-9', removedAt: 1 }] });
    const result = applyRemotePersonasPatch(local, patch({
      tombstones: [{ derivationName: 'persona-2', removedAt: 42 }],
    }));
    expect(result.extraPersonaTombstones).toEqual([{ derivationName: 'persona-2', removedAt: 42 }]);
  });
});

describe('applyRemotePersonasPatch — professional stamp', () => {
  const pro = {
    publicKey: '7'.repeat(64),
    privateKey: '8'.repeat(64),
    displayName: 'Dr Local',
    updatedAt: 100,
  };

  it('stamps EXACTLY the remote updatedAt, never "now"', () => {
    const local = identity({ professionalPersona: pro });
    const result = applyRemotePersonasPatch(local, patch({
      professional: { displayName: 'Dr Remote', updatedAt: 12345 },
    }));
    expect(result.professionalPersona?.displayName).toBe('Dr Remote');
    expect(result.professionalPersona?.updatedAt).toBe(12345);
  });

  it('leaves the professional slot untouched when the patch carries no pair', () => {
    const local = identity({ professionalPersona: pro });
    const result = applyRemotePersonasPatch(local, patch());
    expect(result.professionalPersona).toEqual(pro);
  });

  it('preserves the rest of the professional slot (keys are never overwritten)', () => {
    const local = identity({ professionalPersona: pro });
    const result = applyRemotePersonasPatch(local, patch({
      professional: { displayName: 'Dr Remote', updatedAt: 12345 },
    }));
    expect(result.professionalPersona?.publicKey).toBe(pro.publicKey);
    expect(result.professionalPersona?.privateKey).toBe(pro.privateKey);
  });

  it('does not create a professional slot on an identity that has none, with no key material offered', () => {
    const local = identity();
    const result = applyRemotePersonasPatch(local, patch({
      professional: { displayName: 'Dr Remote', updatedAt: 12345 },
    }));
    expect(result.professionalPersona).toBeUndefined();
  });

  it('conjures the slot from professionalSlot when the identity has none', () => {
    const local = identity();
    const result = applyRemotePersonasPatch(local, patch({
      professional: { displayName: 'Dr Remote', updatedAt: 12345 },
      professionalSlot: { publicKey: '7'.repeat(64), privateKey: '8'.repeat(64) },
    }));
    expect(result.professionalPersona).toEqual({
      publicKey: '7'.repeat(64),
      privateKey: '8'.repeat(64),
      displayName: 'Dr Remote',
      updatedAt: 12345,
    });
  });

  it('conjures keylessly (device-held keys)', () => {
    const result = applyRemotePersonasPatch(identity(), patch({
      professional: { displayName: 'Dr Remote', updatedAt: 7 },
      professionalSlot: { publicKey: '7'.repeat(64), privateKey: '' },
    }));
    expect(result.professionalPersona?.privateKey).toBe('');
    expect(result.professionalPersona?.publicKey).toBe('7'.repeat(64));
  });

  it('never conjures over an existing slot — local key material wins', () => {
    const local = identity({ professionalPersona: pro });
    const result = applyRemotePersonasPatch(local, patch({
      professional: { displayName: 'Dr Remote', updatedAt: 12345 },
      professionalSlot: { publicKey: 'e'.repeat(64), privateKey: 'f'.repeat(64) },
    }));
    expect(result.professionalPersona?.publicKey).toBe(pro.publicKey);
    expect(result.professionalPersona?.privateKey).toBe(pro.privateKey);
    expect(result.professionalPersona?.displayName).toBe('Dr Remote');
  });

  it('ignores professionalSlot when the patch carries no professional pair', () => {
    const result = applyRemotePersonasPatch(identity(), patch({
      professionalSlot: { publicKey: '7'.repeat(64), privateKey: '8'.repeat(64) },
    }));
    expect(result.professionalPersona).toBeUndefined();
  });
});

describe('naturalPersonActive', () => {
  it('activates a dormant local slot when the patch carries the flag', () => {
    const decrypted = identity({ naturalPersonActive: false });
    const result = applyRemotePersonasPatch(decrypted, {
      extraPersonas: [], tombstones: [], naturalPersonActive: true,
    });
    expect(result.naturalPersonActive).toBe(true);
  });

  it('leaves an already-active slot alone when the patch omits the flag', () => {
    const decrypted = identity({ naturalPersonActive: true });
    const result = applyRemotePersonasPatch(decrypted, { extraPersonas: [], tombstones: [] });
    expect(result.naturalPersonActive).toBe(true);
  });

  it('never deactivates — an omitted flag is not a deactivation', () => {
    const decrypted = identity({ naturalPersonActive: true });
    const result = applyRemotePersonasPatch(decrypted, { extraPersonas: [], tombstones: [] });
    expect(result.naturalPersonActive).not.toBe(false);
  });

  it('does not invent a name for a slot it activates', () => {
    const decrypted = identity({ naturalPersonActive: false });
    const result = applyRemotePersonasPatch(decrypted, {
      extraPersonas: [], tombstones: [], naturalPersonActive: true,
    });
    expect(result.naturalPerson.displayName).toBe(decrypted.naturalPerson.displayName);
  });
});

describe('naturalPersonDisplayName', () => {
  it('names a nameless real identity from the patch', () => {
    const decrypted = identity({
      naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: '' },
    });
    const result = applyRemotePersonasPatch(decrypted, patch({
      naturalPersonActive: true,
      naturalPersonDisplayName: 'Alice',
    }));
    expect(result.naturalPerson.displayName).toBe('Alice');
    expect(result.naturalPersonActive).toBe(true);
  });

  it('treats a whitespace-only local name as nameless', () => {
    const decrypted = identity({
      naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: '   ' },
    });
    const result = applyRemotePersonasPatch(decrypted, patch({ naturalPersonDisplayName: 'Alice' }));
    expect(result.naturalPerson.displayName).toBe('Alice');
  });

  it('never overwrites a name the decrypted record already holds', () => {
    const decrypted = identity();
    const result = applyRemotePersonasPatch(decrypted, patch({ naturalPersonDisplayName: 'Someone Else' }));
    expect(result.naturalPerson.displayName).toBe('Alice');
  });

  it('leaves the slot untouched when the patch carries no name', () => {
    const decrypted = identity({
      naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: '' },
    });
    const result = applyRemotePersonasPatch(decrypted, patch({ naturalPersonActive: true }));
    expect(result.naturalPerson.displayName).toBe('');
  });

  it('keeps the rest of the slot (keys, avatar/publication fields) intact', () => {
    const decrypted = identity({
      naturalPerson: {
        publicKey: 'b'.repeat(64),
        privateKey: 'c'.repeat(64),
        displayName: '',
        nip05: 'alice@example.com',
      },
    });
    const result = applyRemotePersonasPatch(decrypted, patch({ naturalPersonDisplayName: 'Alice' }));
    expect(result.naturalPerson.publicKey).toBe('b'.repeat(64));
    expect(result.naturalPerson.privateKey).toBe('c'.repeat(64));
    expect(result.naturalPerson.nip05).toBe('alice@example.com');
  });
});
