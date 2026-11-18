import { describe, expect, it } from 'vitest';
import {
  absoluteTimeText, ageText, cryptoRequestLabel, declaredNameForDisplay, dTagOf, hostOf, isLate, LATE_AFTER_MS,
  lateNote, lookalikeNote, looksEncrypted, normaliseName, oneLine, pairedLookalike, declaredAppOf, previewOf, signRequestLabel,
  stripInvisible, summariseContent, tagSummary,
} from './bunker-request-detail';

const NOW = new Date(2026, 10, 18, 15, 0, 0).getTime();
const BIDI = '‮⁦​\u0007\u0000';

describe('late and age', () => {
  it('is late only after five minutes', () => {
    expect(LATE_AFTER_MS).toBe(300_000);
    expect(isLate(NOW - 300_000, NOW)).toBe(false);
    expect(isLate(NOW - 300_001, NOW)).toBe(true);
    expect(isLate(undefined, NOW)).toBe(false);
  });
  it('words the age', () => {
    expect(ageText(NOW - 5_000, NOW)).toBe('just now');
    expect(ageText(NOW - 59_000, NOW)).toBe('just now');
    expect(ageText(NOW - 120_000, NOW)).toBe('2 min ago');
    expect(ageText(NOW - 3_600_000, NOW)).toBe('1 h ago');
    expect(ageText(NOW - 5 * 3_600_000, NOW)).toBe('5 h ago');
    expect(ageText(NOW - 3 * 86_400_000, NOW)).toBe('3 d ago');
    expect(ageText(NOW + 10_000, NOW)).toBe('just now');
  });
  it('writes the late note', () => {
    expect(lateNote(NOW - 6 * 60_000, NOW)).toBe('Asked 6 min ago. The app has probably stopped waiting.');
  });
});

describe('absoluteTimeText', () => {
  it('says Today for today and the date otherwise', () => {
    const today = new Date(2026, 10, 18, 14, 2, 31).getTime();
    expect(absoluteTimeText(today, NOW)).toBe('Today 14:02:31');
    const earlier = new Date(2026, 10, 17, 9, 5, 7).getTime();
    expect(absoluteTimeText(earlier, NOW)).toBe('17 Nov, 09:05:07');
  });
});

describe('tags and d tag', () => {
  it('summarises names with repeat counts', () => {
    expect(tagSummary([['d', 'x'], ['p', 'a'], ['p', 'b']])).toBe('3: d, p ×2');
    expect(tagSummary([])).toBe('None');
    expect(tagSummary('nope')).toBe('None');
  });
  it('caps the distinct names and cleans them', () => {
    const many = Array.from({ length: 12 }, (_, i) => [`t${i}`]);
    expect(tagSummary(many)).toBe('12: t0, t1, t2, t3, t4, t5, t6, t7, …');
    expect(tagSummary([[`a${BIDI}b`]])).toBe('1: ab');
    expect(tagSummary([[7 as unknown as string]])).toBe('1: ?');
  });
  it('reads the first d tag, sanitised and cut to 80', () => {
    expect(dTagOf([['x', '1'], ['d', `my${BIDI} app/state`]])).toBe('my app/state');
    expect(dTagOf([['d', 'z'.repeat(200)]])).toHaveLength(80);
    expect(dTagOf([['p', 'x']])).toBeUndefined();
    expect(dTagOf([['d', '']])).toBeUndefined();
    expect(dTagOf(undefined)).toBeUndefined();
  });
});

describe('content', () => {
  const nip44 = 'AgEA' + 'A'.repeat(200);
  it('detects ciphertext', () => {
    expect(looksEncrypted(nip44)).toBe(true);
    expect(looksEncrypted('c29tZSBkYXRh?iv=aXZpdml2aXZpdg==')).toBe(true);
    expect(looksEncrypted('hello there')).toBe(false);
    expect(looksEncrypted('')).toBe(false);
  });
  it('summarises empty, encrypted and text', () => {
    expect(summariseContent('')).toEqual({ kind: 'empty' });
    expect(summariseContent(nip44)).toEqual({ kind: 'encrypted', length: nip44.length });
    expect(summariseContent('hi there')).toEqual({ kind: 'text', preview: { text: 'hi there', total: 8, cut: false } });
  });
  it('cuts a preview to 280 characters, one line, with the real length', () => {
    const big = `first line\nsecond ${BIDI}line ` + 'x'.repeat(5000);
    const p = previewOf(big);
    expect(p.total).toBe(big.length);
    expect(p.cut).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(280);
    expect(p.text.startsWith('first line second line xxx')).toBe(true);
    expect(p.text).not.toMatch(/[\n\r‮⁦​\u0000\u0007]/);
  });
  it('never mid-cuts a surrogate pair', () => {
    expect(previewOf('😀'.repeat(300)).text).toBe('😀'.repeat(280));
  });
  it('oneLine bounds work on a huge string', () => {
    expect(oneLine('a'.repeat(1_000_000), 10)).toBe('a'.repeat(10));
    expect(oneLine(undefined, 10)).toBe('');
  });
});

describe('request labels', () => {
  it('labels sign requests with the kind and its friendly name', () => {
    const t = { pubkey: '', created_at: 1, tags: [], content: '' };
    expect(signRequestLabel({ ...t, kind: 30078 })).toBe('Sign · kind 30078 (app state)');
    expect(signRequestLabel({ ...t, kind: 31337 })).toBe('Sign · kind 31337');
  });
  it('labels crypto requests', () => {
    expect(cryptoRequestLabel('nip44_encrypt')).toBe('Encrypt');
    expect(cryptoRequestLabel('nip44_decrypt')).toBe('Decrypt');
    expect(cryptoRequestLabel('nip04_decrypt')).toBe('Decrypt (older format)');
  });
});

describe('site and declared names', () => {
  it('takes only the hostname, as text', () => {
    expect(hostOf('https://app.example.com/path?x=1')).toBe('app.example.com');
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
  it('cuts a declared name for display', () => {
    expect(declaredNameForDisplay('KithMoot')).toBe('KithMoot');
    expect(declaredNameForDisplay(`A${BIDI}B`)).toBe('AB');
    expect(declaredNameForDisplay('n'.repeat(90))).toBe('n'.repeat(40) + '…');
  });
  it('cuts a declared name by code points, never inside a surrogate pair', () => {
    const cut = declaredNameForDisplay('\u{1F600}'.repeat(90));
    expect(Array.from(cut)).toHaveLength(41); // 40 emoji and the ellipsis
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(oneLine('x'.repeat(1023) + '\u{1F600}'.repeat(5), 2000)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it('strips invisible characters from a displayed declared name', () => {
    expect(declaredNameForDisplay('Kith\u2060Moot')).toBe('KithMoot');
    expect(declaredNameForDisplay('Kith\u00adMoot\u3164')).toBe('KithMoot');
  });
  it('cannot be made to close the quotes the card puts around it', () => {
    for (const q of ['"', '\u201c', '\u201d', '\uff02']) {
      expect(declaredNameForDisplay(`KithMoot${q} · paired`)).toBe("KithMoot' · paired");
    }
  });
  it('finds a paired app of the same name under another key only', () => {
    const clients = [{ clientPubkey: 'a'.repeat(64), appName: ' KithMoot ' }, { clientPubkey: 'b'.repeat(64), appName: 'Other' }];
    expect(pairedLookalike({ name: 'kithmoot' }, 'c'.repeat(64), clients)).toBe(' KithMoot ');
    expect(pairedLookalike({ name: 'KITHMOOT' }, 'A'.repeat(64), clients)).toBeUndefined();
    expect(pairedLookalike({ name: 'Nobody' }, 'c'.repeat(64), clients)).toBeUndefined();
    expect(pairedLookalike({}, 'c'.repeat(64), clients)).toBeUndefined();
    expect(pairedLookalike({ name: 'x' }, 'c'.repeat(64), undefined)).toBeUndefined();
    expect(lookalikeNote('KithMoot')).toBe('Not the KithMoot paired on this phone: different app key.');
  });
  it('is not beaten by invisible characters or width forms (word joiner, soft hyphen, fullwidth)', () => {
    const clients = [{ clientPubkey: 'a'.repeat(64), appName: 'KithMoot' }];
    for (const name of ['Kith\u2060Moot', 'Kith\u00adMoot', 'Kith\u200bMoot', '\ufeffKithMoot', '\uff2b\uff49\uff54\uff48Moot', 'Kith  Moot'.replace('  ', '\u2060')]) {
      expect(pairedLookalike({ name }, 'c'.repeat(64), clients), JSON.stringify(name)).toBe('KithMoot');
    }
    expect(stripInvisible('a\u2060b\u00adc\u034fd\u180be\u{e0041}f')).toBe('abcdef');
    expect(normaliseName(' Kith\u2060 Moot ')).toBe('kith moot');
  });
  it('also fires when the declared site is a paired app\'s site under another key', () => {
    const clients = [
      { clientPubkey: 'a'.repeat(64), appName: 'Paired Game', appUrl: 'https://game.example/play' },
      { clientPubkey: 'b'.repeat(64), appName: 'Other', appUrl: 'https://other.example' },
    ];
    expect(pairedLookalike({ url: 'https://game.example' }, 'c'.repeat(64), clients)).toBe('Paired Game');
    expect(pairedLookalike({ name: 'Different', url: 'https://GAME.example' }, 'c'.repeat(64), clients)).toBe('Paired Game');
    expect(pairedLookalike({ url: 'https://game.example' }, 'a'.repeat(64), clients)).toBeUndefined();
    expect(pairedLookalike({ url: 'https://elsewhere.example' }, 'c'.repeat(64), clients)).toBeUndefined();
  });
});

describe('declaredAppOf', () => {
  it('reads name and url from the fourth or third param, like a saved client', () => {
    const meta = JSON.stringify({ name: `Kith${BIDI}Moot`, url: 'https://kithmoot.example/some/path' });
    expect(declaredAppOf(['pk', 'secret', 'sign_event', meta])).toEqual({ name: 'KithMoot', url: 'https://kithmoot.example' });
    expect(declaredAppOf(['pk', 'secret', meta])).toEqual({ name: 'KithMoot', url: 'https://kithmoot.example' });
  });
  it('applies the ConnectedClient limits', () => {
    const meta = JSON.stringify({ name: 'n'.repeat(500), url: 'http://plain.example' });
    expect(declaredAppOf(['pk', 's', '', meta])).toEqual({ name: 'n'.repeat(100) });
  });
  it('takes invisible characters out of the name, and a name that is only those is no name', () => {
    expect(declaredAppOf(['pk', 's', '', JSON.stringify({ name: 'Kith\u2060Moot' })])).toEqual({ name: 'KithMoot' });
    expect(declaredAppOf(['pk', 's', '', JSON.stringify({ name: '\u2060\u00ad' })])).toEqual({});
  });
  it('returns nothing for junk, arrays, oversize or no blob', () => {
    expect(declaredAppOf(['pk', 's', '', '{nope'])).toEqual({});
    expect(declaredAppOf(['pk', 's', '', '[1]'])).toEqual({});
    expect(declaredAppOf(['pk', 's', '', `{"name":"${'a'.repeat(5000)}"}`])).toEqual({});
    expect(declaredAppOf(['pk', 's', 'sign_event'])).toEqual({});
  });
});
