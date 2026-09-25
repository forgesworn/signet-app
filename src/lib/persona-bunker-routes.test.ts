// src/lib/persona-bunker-routes.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildOwnerPersonaRoutes,
  ownerRoutePubkeyMismatch,
  ownerRouteNip44Authorised,
  type OwnerPersonaRouteInputs,
} from './persona-bunker-routes';
import type { DecryptingSigningBackend } from './signing-backend';

// Minimal stub — only `activePublicKeyHex` is read by the builder. Cast through
// `unknown` because we don't exercise the crypto methods here.
const fakeBackend = (pubkey: string): DecryptingSigningBackend =>
  ({
    type: 'local',
    activePublicKeyHex: pubkey,
    signEvent: async (e: unknown) => e,
    nip44Encrypt: async () => '',
    nip44Decrypt: async () => '',
    destroy: () => {},
  } as unknown as DecryptingSigningBackend);

// Injected factory: returns a sentinel backend tagged with the private key, so
// tests can assert which key each route's backend was built from. Throws for the
// literal 'bad' key to exercise the malformed-key skip path.
const makeBackend = (priv: string): DecryptingSigningBackend => {
  if (priv === 'bad') throw new Error('malformed key');
  return fakeBackend(`bk:${priv}`);
};

const base: OwnerPersonaRouteInputs = {
  primaryBackend: null,
  unlocked: false,
  personaBackend: null,
  extraPersonas: undefined,
  professionalPersona: null,
};

describe('buildOwnerPersonaRoutes — natural-person route under a persona primary (§8)', () => {
  // §8: the transport follows `primaryKeypair`, so on a persona-primary install
  // `primaryBackend` is the PERSONA. The NP therefore needs its own input, or a
  // client paired to the NP pubkey would find no route after a reload.
  it('adds an NP route when the real identity is active (caller supplies the backend)', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('PE'),
        naturalPersonBackend: fakeBackend('NP'),
        unlocked: true,
        personaBackend: fakeBackend('PE'),
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['PE', 'NP']);
  });

  it('omits the NP route while the real identity is dormant (caller passes null)', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('PE'),
        naturalPersonBackend: null,
        unlocked: true,
        personaBackend: fakeBackend('PE'),
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['PE']);
    expect(routes.some(r => r.pubkey === 'NP')).toBe(false);
  });

  it('emits exactly one NP route on an NP-primary install (dedupe, not a duplicate)', () => {
    const np = fakeBackend('NP');
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: np,
        naturalPersonBackend: np,
        unlocked: true,
        personaBackend: fakeBackend('PE'),
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP', 'PE']);
    expect(routes.filter(r => r.pubkey === 'NP')).toHaveLength(1);
  });

  it('dedupes case-insensitively when the two inputs differ only in case', () => {
    const routes = buildOwnerPersonaRoutes(
      { ...base, primaryBackend: fakeBackend('npkey'), naturalPersonBackend: fakeBackend('NPKEY') },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['npkey']);
  });

  it('builds the NP route while still locked, like the primary route', () => {
    const routes = buildOwnerPersonaRoutes(
      { ...base, primaryBackend: fakeBackend('PE'), naturalPersonBackend: fakeBackend('NP'), unlocked: false },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['PE', 'NP']);
  });

  it('ignores an NP backend with no pubkey', () => {
    const routes = buildOwnerPersonaRoutes(
      { ...base, primaryBackend: fakeBackend('PE'), naturalPersonBackend: fakeBackend('') },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['PE']);
  });
});

describe('buildOwnerPersonaRoutes', () => {
  it('returns no routes when there is no primary backend and still locked', () => {
    expect(buildOwnerPersonaRoutes(base, makeBackend)).toEqual([]);
  });

  it('builds the NP route even while locked, and ignores persona/extra/pro until unlocked', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: false,
        personaBackend: fakeBackend('PE'),
        extraPersonas: [{ publicKey: 'EX1', privateKey: 'k1' }],
        professionalPersona: { publicKey: 'PRO', privateKey: 'kp' },
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP']);
  });

  it('adds the persona route when unlocked and distinct from NP, in NP→persona order', () => {
    const routes = buildOwnerPersonaRoutes(
      { ...base, primaryBackend: fakeBackend('NP'), unlocked: true, personaBackend: fakeBackend('PE') },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP', 'PE']);
  });

  it('dedupes the persona route when its pubkey equals NP', () => {
    const routes = buildOwnerPersonaRoutes(
      { ...base, primaryBackend: fakeBackend('NP'), unlocked: true, personaBackend: fakeBackend('NP') },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP']);
  });

  it('dedupes the persona route when its pubkey equals NP case-insensitively', () => {
    const routes = buildOwnerPersonaRoutes(
      { ...base, primaryBackend: fakeBackend('np'), unlocked: true, personaBackend: fakeBackend('NP') },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['np']);
  });

  it('builds extra-persona routes (using the slot pubkey) in order after persona, via the injected factory', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: true,
        personaBackend: fakeBackend('PE'),
        extraPersonas: [
          { publicKey: 'EX1', privateKey: 'k1' },
          { publicKey: 'EX2', privateKey: 'k2' },
        ],
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP', 'PE', 'EX1', 'EX2']);
    expect(routes[2].backend.activePublicKeyHex).toBe('bk:k1');
    expect(routes[3].backend.activePublicKeyHex).toBe('bk:k2');
  });

  it('skips an extra persona whose pubkey is already routed (case-insensitive) and one missing a key', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: true,
        personaBackend: null,
        extraPersonas: [
          { publicKey: 'np', privateKey: 'k1' },        // dup of NP (case-insensitive) → skip
          { publicKey: 'EX2', privateKey: '' },         // missing private key → skip
          { publicKey: '', privateKey: 'k3' },          // missing public key → skip
          { publicKey: 'EX4', privateKey: 'k4' },       // kept
        ],
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP', 'EX4']);
  });

  it('dedupes two extra personas that share a pubkey (case-insensitively), keeping the first', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: true,
        extraPersonas: [
          { publicKey: 'EX1', privateKey: 'k1' },
          { publicKey: 'ex1', privateKey: 'k2' }, // same pubkey, different case → skip
        ],
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP', 'EX1']);
    expect(routes[1].backend.activePublicKeyHex).toBe('bk:k1'); // first one wins
  });

  it('skips an extra persona whose key the factory rejects, keeping the others', () => {
    const routes = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: true,
        extraPersonas: [
          { publicKey: 'EX1', privateKey: 'bad' }, // factory throws → skip
          { publicKey: 'EX2', privateKey: 'k2' },
        ],
      },
      makeBackend,
    );
    expect(routes.map(r => r.pubkey)).toEqual(['NP', 'EX2']);
  });

  it('appends the professional route last and dedupes it when already routed', () => {
    const withPro = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: true,
        professionalPersona: { publicKey: 'PRO', privateKey: 'kp' },
      },
      makeBackend,
    );
    expect(withPro.map(r => r.pubkey)).toEqual(['NP', 'PRO']);

    const dupPro = buildOwnerPersonaRoutes(
      {
        ...base,
        primaryBackend: fakeBackend('NP'),
        unlocked: true,
        extraPersonas: [{ publicKey: 'PRO', privateKey: 'k1' }],
        professionalPersona: { publicKey: 'PRO', privateKey: 'kp' },
      },
      makeBackend,
    );
    expect(dupPro.map(r => r.pubkey)).toEqual(['NP', 'PRO']); // pro deduped against the extra
  });
});

describe('ownerRoutePubkeyMismatch', () => {
  it('is false when the template has no pubkey (standard NIP-46 — sign as the route persona)', () => {
    expect(ownerRoutePubkeyMismatch('ABC', undefined)).toBe(false);
    expect(ownerRoutePubkeyMismatch('ABC', '')).toBe(false);
  });
  it('is false when the template pubkey matches the route (case-insensitive)', () => {
    expect(ownerRoutePubkeyMismatch('abc', 'abc')).toBe(false);
    expect(ownerRoutePubkeyMismatch('ABC', 'abc')).toBe(false);
  });
  it('is true when the template names a different pubkey than the route is bound to', () => {
    expect(ownerRoutePubkeyMismatch('ABC', 'DEF')).toBe(true);
  });
});

describe('ownerRouteNip44Authorised (security audit 2026-06-15 — nip44 oracle gate)', () => {
  it('rejects an owner-route nip44 request from a client with no ConnectedClient record', () => {
    expect(ownerRouteNip44Authorised(undefined, undefined)).toBe(false);
    expect(ownerRouteNip44Authorised(undefined, null)).toBe(false);
  });
  it('rejects an owner-route nip44 request from a connected client WITHOUT allowAlways', () => {
    expect(ownerRouteNip44Authorised(undefined, { allowAlways: false })).toBe(false);
    expect(ownerRouteNip44Authorised(undefined, {})).toBe(false);
  });
  it('allows an owner-route nip44 request only when the client has allowAlways: true', () => {
    expect(ownerRouteNip44Authorised(undefined, { allowAlways: true })).toBe(true);
  });
  it('is exempt for dependant/app routes (they run their own policy gate)', () => {
    // routeDependantId set → returns true regardless of the connected-client state,
    // because the autonomy-stage/charter/rate-limit gate governs those routes.
    expect(ownerRouteNip44Authorised('dep-pubkey', undefined)).toBe(true);
    expect(ownerRouteNip44Authorised('dep-pubkey', { allowAlways: false })).toBe(true);
  });
});
