import { describe, expect, it } from 'vitest';
import { parseKeepPairLink } from './keep-link';

const K = 'ab'.repeat(32);
const C = 'cd'.repeat(16);
const link = (extra = '') => `signet-keep:pair?k=${K}&c=${C}&n=Home%20Keep&r=wss%3A%2F%2Frelay.example.com${extra}`;

describe('parseKeepPairLink', () => {
  it('reads a Keep link', () => {
    expect(parseKeepPairLink(link())).toEqual({ keep: K, code: C, name: 'Home Keep', relays: ['wss://relay.example.com'] });
  });
  it('trims, lowercases the hex and takes up to three relays', () => {
    const text = `  signet-keep:pair?k=${K.toUpperCase()}&c=${C}&r=wss://a.example&r=wss://b.example&r=wss://c.example\n`;
    const parsed = parseKeepPairLink(text);
    expect(parsed?.keep).toBe(K);
    expect(parsed?.relays).toEqual(['wss://a.example', 'wss://b.example', 'wss://c.example']);
    expect(parsed?.name).toBe('Your Keep');
  });
  it('cuts the name to 40 characters and strips control characters', () => {
    const name = encodeURIComponent('‮Evil' + 'x'.repeat(60));
    const parsed = parseKeepPairLink(`signet-keep:pair?k=${K}&c=${C}&n=${name}&r=wss://a.example`);
    expect(parsed!.name.length).toBeLessThanOrEqual(40);
    expect(parsed!.name).not.toContain('‮');
  });
  it.each([
    ['another scheme', link().replace('signet-keep', 'https')],
    ['no relays', `signet-keep:pair?k=${K}&c=${C}`],
    ['four relays', link('&r=wss://b.example&r=wss://c.example&r=wss://d.example')],
    ['a ws relay', `signet-keep:pair?k=${K}&c=${C}&r=ws://relay.example`],
    ['a repeated relay', link('&r=wss%3A%2F%2Frelay.example.com')],
    ['a short key', `signet-keep:pair?k=${K.slice(2)}&c=${C}&r=wss://a.example`],
    ['a short code', `signet-keep:pair?k=${K}&c=${C.slice(2)}&r=wss://a.example`],
    ['two keys', link(`&k=${K}`)],
    ['not hex', `signet-keep:pair?k=${'zz'.repeat(32)}&c=${C}&r=wss://a.example`],
    ['empty', ''],
  ])('refuses %s', (_label, text) => {
    expect(parseKeepPairLink(text)).toBeNull();
  });
});
