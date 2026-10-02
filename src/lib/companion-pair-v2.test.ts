import { describe, it, expect } from 'vitest';
import {
  parseContactsPairingRequestV2, isContactsPairingV2, buildPairingAckV2Content,
  newGrantId, newRailKeypair,
} from './companion-pair-v2';
import { buildPairingUriV2, parsePairingAckV2, projectionTag, proposalTag } from '@forgesworn/signet-contacts/wire';
import { LocalSigningBackend } from './signing-backend';
import { routeQR } from './qr-router';
import { pairingUriForRequestV2, pairingRequestExpiresAtSec } from './companion-pair-v2';

const NOW = 1_700_000_000;
const APP = 'a'.repeat(64);
const CHALLENGE = 'D'.repeat(32);

function uri(): string {
  return buildPairingUriV2({
    appPubkey: APP, appName: 'Flock',
    capabilities: ['signet.contacts.read:directory', 'signet.contacts.blocks.read'],
    directory: 'owner', relay: 'wss://relay.example.com', nowSec: NOW, challenge: CHALLENGE,
  });
}

describe('isContactsPairingV2', () => {
  it('recognises v=2 in every carrier and rejects v1', () => {
    const q = uri().slice(uri().indexOf('?') + 1);
    expect(isContactsPairingV2(uri())).toBe(true);
    expect(isContactsPairingV2(q)).toBe(true);
    expect(isContactsPairingV2(`https://mysignet.app/pair?${q}`)).toBe(true);
    expect(isContactsPairingV2('signet-grant://pair?app=' + APP + '&scope=kin')).toBe(false);
    expect(isContactsPairingV2('nonsense')).toBe(false);
  });
});

describe('parseContactsPairingRequestV2', () => {
  it('parses a fresh request', () => {
    const { request } = parseContactsPairingRequestV2(uri(), { nowSec: NOW });
    expect(request?.appName).toBe('Flock');
    expect(request?.capabilities).toEqual(['signet.contacts.read:directory', 'signet.contacts.blocks.read']);
  });

  it('rejects a v1 request', () => {
    expect(parseContactsPairingRequestV2('signet-grant://pair?app=' + APP, { nowSec: NOW }).request).toBeNull();
  });
});

describe('newGrantId and newRailKeypair', () => {
  it('mints a 32-hex grant id that differs every call', () => {
    expect(newGrantId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newGrantId()).not.toBe(newGrantId());
  });

  it('mints a fresh random rail keypair whose pubkey matches the private key', () => {
    const rail = newRailKeypair();
    expect(rail.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(new LocalSigningBackend(rail.privateKey).activePublicKeyHex).toBe(rail.publicKey);
    expect(newRailKeypair().privateKey).not.toBe(rail.privateKey);
  });
});

describe('buildPairingAckV2Content', () => {
  it('encrypts an ack the app can decrypt and validate', async () => {
    const grantId = newGrantId();
    const rail = newRailKeypair();
    const app = new LocalSigningBackend('7'.repeat(63) + '1');
    const ephemeral = new LocalSigningBackend('6'.repeat(63) + '1');
    const content = await buildPairingAckV2Content({
      v: 2, grantId, railPubkey: rail.publicKey,
      projectionTag: projectionTag(grantId), proposalTag: proposalTag(grantId, app.activePublicKeyHex),
      relay: 'wss://relay.example.com',
      grantedCapabilities: ['signet.contacts.read:directory'],
      maxStalenessSeconds: 21600, challenge: CHALLENGE,
    }, ephemeral, app.activePublicKeyHex);

    const plaintext = await app.nip44Decrypt(ephemeral.activePublicKeyHex, content);
    const ack = parsePairingAckV2(plaintext, CHALLENGE);
    expect(ack?.grantId).toBe(grantId);
    expect(ack?.railPubkey).toBe(rail.publicKey);
    expect(ack?.grantedCapabilities).toEqual(['signet.contacts.read:directory']);
  });
});

describe('pairingUriForRequestV2 (paired-child hand-off code)', () => {
  const fresh = () => Math.floor(Date.now() / 1000);

  it('round-trips through the guardian home scanner, always as a dependant request', () => {
    for (const directory of ['owner', 'dependant'] as const) {
      const original = parseContactsPairingRequestV2(buildPairingUriV2({
        appPubkey: APP, appName: 'Flock & Co \u00e9',
        capabilities: ['signet.contacts.read:directory', 'signet.contacts.blocks.read', 'signet.contacts.propose:add-ken'],
        directory, relay: 'wss://relay.example.com', nowSec: fresh(), challenge: CHALLENGE,
      })).request;
      expect(original).not.toBeNull();

      const rebuilt = pairingUriForRequestV2(original!);
      expect(rebuilt).not.toBeNull();

      // The exact entry point the guardian's home-screen scanner uses.
      const action = routeQR(rebuilt!);
      expect(action.type).toBe('contacts-pair-v2');
      if (action.type !== 'contacts-pair-v2') throw new Error('unreachable');
      // 'owner' on the child's phone means the CHILD's contacts; the guardian
      // would read it as their own, so the code always says 'dependant'.
      expect(action.request).toEqual({ ...original, directory: 'dependant' });
      // Spell the load-bearing fields out so a failure names the one that drifted.
      expect(action.request.appPubkey).toBe(original!.appPubkey);
      expect(action.request.challenge).toBe(original!.challenge);
      expect(action.request.capabilities).toEqual(original!.capabilities);
      expect(action.request.directory).toBe('dependant');
      expect(action.request.rendezvousRelay).toBe(original!.rendezvousRelay);
      expect(action.request.t).toBe(original!.t);
      expect(action.request.appName).toBe(original!.appName);
    }
  });

  it('returns null rather than throwing when the SDK refuses to build', () => {
    const request = parseContactsPairingRequestV2(uri(), { nowSec: NOW }).request!;
    expect(pairingUriForRequestV2({ ...request, rendezvousRelay: 'not a relay' })).toBeNull();
  });

  it('expires at t + the SDK freshness window (300 s)', () => {
    const request = parseContactsPairingRequestV2(uri(), { nowSec: NOW }).request!;
    expect(pairingRequestExpiresAtSec(request)).toBe(NOW + 300);
  });
});
