import { describe, it, expect } from 'vitest';
import {
  parseContactsPairingRequestV2, isContactsPairingV2, buildPairingAckV2Content,
  newGrantId, newRailKeypair,
} from './companion-pair-v2';
import { buildPairingUriV2, parsePairingAckV2, projectionTag, proposalTag } from '@forgesworn/signet-contacts/wire';
import { LocalSigningBackend } from './signing-backend';

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
