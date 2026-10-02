import { describe, expect, it } from 'vitest';
import { contactDisplayName, fullNpub, isHexPrefixLabel } from './contacts-v2-name';
import { shortNpub } from './nostr-follows';

const KEY = '66dd41aa' + 'b'.repeat(56);
const OTHER = '12345678' + 'c'.repeat(56);
const id = (pubkey: string, itemId = 'a'.repeat(32)) => ({ pubkey, itemId }) as never;

describe('contactDisplayName', () => {
  it('shows the short npub for an empty name', () => {
    expect(contactDisplayName({ displayName: '', identities: [id(KEY)] })).toBe(shortNpub(KEY));
    expect(shortNpub(KEY)).toMatch(/^npub1.{5}….{6}$/);
  });
  it('shows the short npub when the name is a hex-prefix label of its own key', () => {
    expect(contactDisplayName({ displayName: '66dd41aa…', identities: [id(KEY)] })).toBe(shortNpub(KEY));
    expect(contactDisplayName({ displayName: '66dd41aabbbb…', identities: [id(KEY)] })).toBe(shortNpub(KEY));
    expect(contactDisplayName({ displayName: '66DD41AA', identities: [id(OTHER, 'b'.repeat(32)), id(KEY)] })).toBe(shortNpub(KEY));
  });
  it('keeps a hex-looking name that matches none of its keys', () => {
    expect(contactDisplayName({ displayName: 'deadbeef', identities: [id(KEY)] })).toBe('deadbeef');
    expect(contactDisplayName({ displayName: 'beef…', identities: [id(KEY)] })).toBe('beef…');
  });
  it('keeps a normal name', () => {
    expect(contactDisplayName({ displayName: 'Ada', identities: [id(KEY)] })).toBe('Ada');
    expect(contactDisplayName({ displayName: 'Ada', identities: [] })).toBe('Ada');
  });
  it('leaves an empty keyless name alone', () => {
    expect(contactDisplayName({ displayName: '', identities: [] })).toBe('');
  });
});

describe('helpers', () => {
  it('isHexPrefixLabel needs six or more hex characters that start a key', () => {
    expect(isHexPrefixLabel('66dd4…', [KEY])).toBe(false);
    expect(isHexPrefixLabel('66dd41…', [KEY])).toBe(true);
  });
  it('fullNpub encodes a key and rejects junk', () => {
    expect(fullNpub(KEY)).toMatch(/^npub1/);
    expect(fullNpub('nope')).toBe('');
  });
});
