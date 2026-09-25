import { describe, it, expect } from 'vitest';
import { encrypt as nip49Encrypt } from 'nostr-tools/nip49';
import { getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  isHeartwoodImportLinkText,
  resolveImportInput,
  resolvePhraseInput,
  shortDeviceLabel,
} from './heartwood-operator-import';
import { operatorFromPhrase } from './heartwood-operator';

const SK = '1'.repeat(63) + '2';
const DEV = 'a'.repeat(64);
const NOW = 1_700_000_000;
const RELAYS = 'wss://relay.one,wss://relay.two';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('resolveImportInput', () => {
  it('plain op link → credential', () => {
    const r = resolveImportInput(`https://sapwood.local/#/import?op=${SK}&dev=${DEV}&relays=${RELAYS}`, undefined, NOW);
    expect(r.kind).toBe('credential');
    if (r.kind !== 'credential') return;
    expect(r.cred.skHex).toBe(SK);
    expect(r.cred.pubHex).toBe(getPublicKey(hexToBytes(SK)));
    expect(r.cred.deviceHex).toBe(DEV);
    expect(r.cred.relays).toEqual(['wss://relay.one', 'wss://relay.two']);
    expect(r.cred.importedAt).toBe(NOW);
  });

  it('eop link with no PIN → needs-pin; with the right PIN → credential; wrong PIN → error', () => {
    const eop = nip49Encrypt(hexToBytes(SK), 'hunter22', 8);
    const link = `#/import?eop=${eop}&dev=${DEV}&relays=${RELAYS}`;
    expect(resolveImportInput(link, undefined, NOW)).toEqual({ kind: 'needs-pin' });
    expect(resolveImportInput(link, '   ', NOW)).toEqual({ kind: 'needs-pin' });
    const ok = resolveImportInput(link, 'hunter22', NOW);
    expect(ok.kind).toBe('credential');
    if (ok.kind === 'credential') expect(ok.cred.skHex).toBe(SK);
    const bad = resolveImportInput(link, 'hunter23', NOW);
    expect(bad.kind).toBe('error');
    if (bad.kind === 'error') expect(bad.message).toMatch(/wrong pin/i);
  });

  it('short PIN is rejected before decrypt', () => {
    const eop = nip49Encrypt(hexToBytes(SK), 'hunter22', 8);
    const r = resolveImportInput(`#/import?eop=${eop}&dev=${DEV}&relays=${RELAYS}`, 'abc', NOW);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/at least 6/);
  });

  it('non-link text → error', () => {
    const r = resolveImportInput('bunker://abc?relay=wss://x', undefined, NOW);
    expect(r.kind).toBe('error');
  });

  it('link missing dev or relays → error from buildOperatorCredential', () => {
    const noDev = resolveImportInput(`#/import?op=${SK}&relays=${RELAYS}`, undefined, NOW);
    expect(noDev).toEqual({ kind: 'error', message: 'Link is missing the device address' });
    const noRelays = resolveImportInput(`#/import?op=${SK}&dev=${DEV}&relays=ws://insecure`, undefined, NOW);
    expect(noRelays).toEqual({ kind: 'error', message: 'Link carries no relays' });
  });
});

describe('resolvePhraseInput', () => {
  it('phrase + npub + relays (newline separated) → credential matching operatorFromPhrase', () => {
    const npub = nip19.npubEncode(DEV);
    const r = resolvePhraseInput(PHRASE, npub, 'wss://relay.one\nwss://relay.two', NOW);
    expect(r.kind).toBe('credential');
    if (r.kind !== 'credential') return;
    expect(r.cred.skHex).toBe(operatorFromPhrase(PHRASE));
    expect(r.cred.deviceHex).toBe(DEV);
    expect(r.cred.relays).toEqual(['wss://relay.one', 'wss://relay.two']);
  });

  it('accepts hex device address and comma-separated relays; drops unsafe relays', () => {
    const r = resolvePhraseInput(PHRASE, DEV.toUpperCase(), 'ws://plain, wss://ok.example', NOW);
    expect(r.kind).toBe('credential');
    if (r.kind === 'credential') {
      expect(r.cred.deviceHex).toBe(DEV);
      expect(r.cred.relays).toEqual(['wss://ok.example']);
    }
  });

  it('bad phrase → error', () => {
    const r = resolvePhraseInput('not a phrase at all', DEV, 'wss://ok.example', NOW);
    expect(r).toEqual({ kind: 'error', message: 'Not a valid recovery phrase' });
  });

  it('bad device → error; no safe relay → error', () => {
    expect(resolvePhraseInput(PHRASE, 'nope', 'wss://ok.example', NOW).kind).toBe('error');
    const noRelay = resolvePhraseInput(PHRASE, DEV, 'ws://plain', NOW);
    expect(noRelay.kind).toBe('error');
    if (noRelay.kind === 'error') expect(noRelay.message).toMatch(/wss:\/\//);
  });
});

describe('helpers', () => {
  it('isHeartwoodImportLinkText prefilters', () => {
    expect(isHeartwoodImportLinkText(`#/import?op=${SK}`)).toBe(true);
    expect(isHeartwoodImportLinkText(`https://x/#/import?op=${SK}&dev=${DEV}`)).toBe(true);
    expect(isHeartwoodImportLinkText('nostrconnect://abc')).toBe(false);
    expect(isHeartwoodImportLinkText('')).toBe(false);
  });

  it('shortDeviceLabel', () => {
    expect(shortDeviceLabel(DEV)).toBe('aaaaaaaa…');
  });
});
