import { describe, it, expect } from 'vitest';
import { encrypt as nip49Encrypt } from 'nostr-tools/nip49';
import * as nip19 from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
// TEST-ONLY imports (transitive deps) — used to independently verify the
// NIP-06 derivation path against a second implementation.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  HEARTWOOD_HANDOFF_RELAY_CAP,
  HEARTWOOD_OPERATOR_PIN_MIN,
  buildOperatorCredential,
  decryptOperatorLink,
  isHeartwoodOperatorCredential,
  isSafeHandoffRelay,
  normaliseOperatorPhrase,
  operatorFromPhrase,
  operatorPubkeyFromSecret,
  parseHeartwoodImportLink,
} from './heartwood-operator';

const SK = '7f3c9a1e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a';
const PUB = getPublicKey(hexToBytes(SK));
const DEV = 'a'.repeat(63) + 'b';
const DEV_NPUB = nip19.npubEncode(DEV);
const RELAYS = 'wss://relay.one.example,wss://relay.two.example';
const ORIGIN = 'https://sapwood.example';

// A fixed BIP-39 phrase — derivation must be stable across runs.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('parseHeartwoodImportLink', () => {
  it('parses a plain (op=) link with dev + relays', () => {
    const link = parseHeartwoodImportLink(`${ORIGIN}/#/import?op=${SK}&dev=${DEV}&relays=${RELAYS}`);
    expect(link).toEqual({
      op: SK,
      deviceHex: DEV,
      relays: ['wss://relay.one.example', 'wss://relay.two.example'],
    });
  });

  it('parses a PIN-protected (eop=) link', () => {
    const eop = nip49Encrypt(hexToBytes(SK), '123456', 8);
    const link = parseHeartwoodImportLink(`#/import?eop=${eop}&dev=${DEV}&relays=${RELAYS}`);
    expect(link?.eop).toBe(eop);
    expect(link?.op).toBeUndefined();
    expect(link?.deviceHex).toBe(DEV);
  });

  it('prefers op over eop when both are present', () => {
    const eop = nip49Encrypt(hexToBytes(SK), '123456', 8);
    const link = parseHeartwoodImportLink(`#/import?op=${SK}&eop=${eop}`);
    expect(link?.op).toBe(SK);
    expect(link?.eop).toBeUndefined();
  });

  it('lowercases an upper-case op and dev', () => {
    const link = parseHeartwoodImportLink(`#/import?op=${SK.toUpperCase()}&dev=${DEV.toUpperCase()}`);
    expect(link?.op).toBe(SK);
    expect(link?.deviceHex).toBe(DEV);
  });

  it('accepts an npub dev and decodes it to hex', () => {
    const link = parseHeartwoodImportLink(`#/import?op=${SK}&dev=${DEV_NPUB}`);
    expect(link?.deviceHex).toBe(DEV);
  });

  it('omits deviceHex when dev is garbage or a non-npub bech32', () => {
    expect(parseHeartwoodImportLink(`#/import?op=${SK}&dev=not-a-key`)?.deviceHex).toBeUndefined();
    const nsec = nip19.nsecEncode(hexToBytes(SK));
    expect(parseHeartwoodImportLink(`#/import?op=${SK}&dev=${nsec}`)?.deviceHex).toBeUndefined();
    expect(parseHeartwoodImportLink(`#/import?op=${SK}&dev=${DEV.slice(0, 63)}`)?.deviceHex).toBeUndefined();
  });

  it('filters unsafe relays: ws://, credentials, https, empty, oversize', () => {
    const relays = [
      'ws://plain.example',
      'wss://user:pw@creds.example',
      'wss://user@creds2.example',
      'https://not-a-relay.example',
      '',
      '   ',
      'wss://',
      `wss://${'x'.repeat(520)}.example`,
      'wss://good.example',
      ' wss://trimmed.example ',
    ].join(',');
    const link = parseHeartwoodImportLink(`#/import?op=${SK}&relays=${encodeURIComponent(relays)}`);
    expect(link?.relays).toEqual(['wss://good.example', 'wss://trimmed.example']);
  });

  it('caps relays at 8', () => {
    const relays = Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`).join(',');
    const link = parseHeartwoodImportLink(`#/import?op=${SK}&relays=${relays}`);
    expect(link?.relays).toHaveLength(HEARTWOOD_HANDOFF_RELAY_CAP);
    expect(link?.relays?.[0]).toBe('wss://r0.example');
    expect(link?.relays?.[7]).toBe('wss://r7.example');
  });

  it('omits relays when every candidate is filtered out', () => {
    const link = parseHeartwoodImportLink(`#/import?op=${SK}&relays=ws://a.example,http://b.example`);
    expect(link).toEqual({ op: SK });
  });

  it('accepts a bare fragment, a bare /import path, and a bare query', () => {
    expect(parseHeartwoodImportLink(`#/import?op=${SK}`)?.op).toBe(SK);
    expect(parseHeartwoodImportLink(`/import?op=${SK}`)?.op).toBe(SK);
    expect(parseHeartwoodImportLink(`?op=${SK}`)?.op).toBe(SK);
    expect(parseHeartwoodImportLink(`op=${SK}&dev=${DEV}`)?.deviceHex).toBe(DEV);
    expect(parseHeartwoodImportLink(`  ${ORIGIN}/#/import?op=${SK}  `)?.op).toBe(SK);
  });

  it('accepts a full URL that also carries a search string before the hash', () => {
    const link = parseHeartwoodImportLink(`${ORIGIN}/?utm=x#/import?op=${SK}&dev=${DEV}`);
    expect(link?.op).toBe(SK);
    expect(link?.deviceHex).toBe(DEV);
  });

  it('returns null for garbage / non-import routes / missing secret', () => {
    expect(parseHeartwoodImportLink('')).toBeNull();
    expect(parseHeartwoodImportLink('hello world')).toBeNull();
    expect(parseHeartwoodImportLink(`${ORIGIN}/`)).toBeNull();
    expect(parseHeartwoodImportLink(`${ORIGIN}/#/settings?op=${SK}`)).toBeNull();
    expect(parseHeartwoodImportLink(`${ORIGIN}/#/importer?op=${SK}`)).toBeNull();
    expect(parseHeartwoodImportLink('#/import')).toBeNull();
    expect(parseHeartwoodImportLink(`#/import?dev=${DEV}&relays=${RELAYS}`)).toBeNull();
    expect(parseHeartwoodImportLink(`#/import?op=${SK.slice(0, 62)}`)).toBeNull();
    expect(parseHeartwoodImportLink(`#/import?op=${'z'.repeat(64)}`)).toBeNull();
    expect(parseHeartwoodImportLink('#/import?eop=ncryptsec1notvalidbech32bio')).toBeNull();
    expect(parseHeartwoodImportLink('#/import?eop=nsec1abc')).toBeNull();
    // Non-string input never throws.
    expect(parseHeartwoodImportLink(undefined as unknown as string)).toBeNull();
  });
});

describe('isSafeHandoffRelay', () => {
  it('accepts wss with hostname and no creds', () => {
    expect(isSafeHandoffRelay('wss://relay.example')).toBe(true);
    expect(isSafeHandoffRelay('wss://relay.example:7777/path')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isSafeHandoffRelay('ws://relay.example')).toBe(false);
    expect(isSafeHandoffRelay('wss://u:p@relay.example')).toBe(false);
    expect(isSafeHandoffRelay('wss://u@relay.example')).toBe(false);
    expect(isSafeHandoffRelay('relay.example')).toBe(false);
    expect(isSafeHandoffRelay('')).toBe(false);
    expect(isSafeHandoffRelay('wss://' + 'a'.repeat(510))).toBe(false);
  });
});

describe('decryptOperatorLink (NIP-49)', () => {
  it('round-trips a known secret through encrypt → decrypt', () => {
    const eop = nip49Encrypt(hexToBytes(SK), 'hunter22', 8);
    expect(eop.startsWith('ncryptsec1')).toBe(true);
    expect(decryptOperatorLink(eop, 'hunter22')).toBe(SK);
    // Whitespace around the ncryptsec is tolerated.
    expect(decryptOperatorLink(`  ${eop}\n`, 'hunter22')).toBe(SK);
  });

  it('throws on a wrong PIN', () => {
    const eop = nip49Encrypt(hexToBytes(SK), 'hunter22', 8);
    expect(() => decryptOperatorLink(eop, 'hunter23')).toThrow();
  });

  it('throws on malformed input', () => {
    expect(() => decryptOperatorLink('ncryptsec1garbage', 'hunter22')).toThrow();
    expect(() => decryptOperatorLink('', 'hunter22')).toThrow();
  });

  it('exports a 6-char minimum PIN length', () => {
    expect(HEARTWOOD_OPERATOR_PIN_MIN).toBe(6);
  });
});

describe('operatorFromPhrase (NIP-06 m/44\'/1237\'/0\'/0/0)', () => {
  it('derives a stable secret for a fixed phrase', () => {
    const a = operatorFromPhrase(PHRASE);
    const b = operatorFromPhrase(PHRASE);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('matches an independent @scure/bip32 derivation at the operator path', () => {
    const seed = mnemonicToSeedSync(PHRASE);
    const child = HDKey.fromMasterSeed(seed).derive("m/44'/1237'/0'/0/0");
    expect(child.privateKey).toBeTruthy();
    const expectedSk = bytesToHex(child.privateKey as Uint8Array);
    const expectedPub = getPublicKey(child.privateKey as Uint8Array);

    const sk = operatorFromPhrase(PHRASE);
    expect(sk).toBe(expectedSk);
    expect(operatorPubkeyFromSecret(sk)).toBe(expectedPub);
  });

  it('is NOT the device master path (m/44\'/1237\'/727\'/0\'/0)', () => {
    const seed = mnemonicToSeedSync(PHRASE);
    const master = HDKey.fromMasterSeed(seed).derive("m/44'/1237'/727'/0'/0");
    expect(operatorFromPhrase(PHRASE)).not.toBe(bytesToHex(master.privateKey as Uint8Array));
  });

  it('normalises whitespace and case before deriving', () => {
    const messy = `  Abandon   ABANDON abandon\tabandon\nabandon abandon abandon abandon abandon abandon abandon ABOUT `;
    expect(normaliseOperatorPhrase(messy)).toBe(PHRASE);
    expect(operatorFromPhrase(messy)).toBe(operatorFromPhrase(PHRASE));
  });

  it('throws "Not a valid recovery phrase" on garbage / bad checksum / empty', () => {
    expect(() => operatorFromPhrase('definitely not a phrase')).toThrow('Not a valid recovery phrase');
    // Valid words, wrong checksum.
    expect(() => operatorFromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'))
      .toThrow('Not a valid recovery phrase');
    expect(() => operatorFromPhrase('')).toThrow('Not a valid recovery phrase');
    expect(() => operatorFromPhrase(undefined as unknown as string)).toThrow('Not a valid recovery phrase');
  });
});

describe('operatorPubkeyFromSecret', () => {
  it('returns the x-only pubkey', () => {
    expect(operatorPubkeyFromSecret(SK)).toBe(PUB);
  });
  it('rejects non-64-hex and out-of-range scalars', () => {
    expect(() => operatorPubkeyFromSecret('abc')).toThrow();
    expect(() => operatorPubkeyFromSecret('0'.repeat(64))).toThrow();
  });
});

describe('buildOperatorCredential', () => {
  const link = parseHeartwoodImportLink(`#/import?op=${SK}&dev=${DEV}&relays=${RELAYS}`)!;

  it('assembles the credential from link + secret', () => {
    const cred = buildOperatorCredential(link, SK, 1_755_300_000.7);
    expect(cred).toEqual({
      skHex: SK,
      pubHex: PUB,
      deviceHex: DEV,
      relays: ['wss://relay.one.example', 'wss://relay.two.example'],
      importedAt: 1_755_300_000,
    });
    expect(isHeartwoodOperatorCredential(cred)).toBe(true);
    // relays are copied, not aliased
    expect(cred.relays).not.toBe(link.relays);
  });

  it('works for a PIN-protected link once the secret is resolved', () => {
    const eop = nip49Encrypt(hexToBytes(SK), 'hunter22', 8);
    const l = parseHeartwoodImportLink(`#/import?eop=${eop}&dev=${DEV_NPUB}&relays=${RELAYS}`)!;
    const cred = buildOperatorCredential(l, decryptOperatorLink(l.eop!, 'hunter22'), 1);
    expect(cred.skHex).toBe(SK);
    expect(cred.pubHex).toBe(PUB);
    expect(cred.deviceHex).toBe(DEV);
  });

  it('throws when the device address is missing', () => {
    expect(() => buildOperatorCredential({ op: SK, relays: ['wss://r.example'] }, SK, 1))
      .toThrow('Link is missing the device address');
  });

  it('throws when relays are missing or empty', () => {
    expect(() => buildOperatorCredential({ op: SK, deviceHex: DEV }, SK, 1)).toThrow('Link carries no relays');
    expect(() => buildOperatorCredential({ op: SK, deviceHex: DEV, relays: [] }, SK, 1)).toThrow('Link carries no relays');
  });

  it('throws when the secret is unusable', () => {
    expect(() => buildOperatorCredential(link, 'nope', 1)).toThrow();
  });
});

describe('isHeartwoodOperatorCredential', () => {
  it('rejects malformed shapes', () => {
    expect(isHeartwoodOperatorCredential(null)).toBe(false);
    expect(isHeartwoodOperatorCredential('x')).toBe(false);
    expect(isHeartwoodOperatorCredential({ skHex: SK })).toBe(false);
    expect(isHeartwoodOperatorCredential({ skHex: SK, pubHex: PUB, deviceHex: DEV, relays: 'wss://x', importedAt: 1 })).toBe(false);
    expect(isHeartwoodOperatorCredential({ skHex: SK, pubHex: PUB, deviceHex: DEV, relays: [1], importedAt: 1 })).toBe(false);
    expect(isHeartwoodOperatorCredential({ skHex: SK, pubHex: PUB, deviceHex: DEV, relays: [], importedAt: NaN })).toBe(false);
  });
});
