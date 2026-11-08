import { describe, it, expect } from 'vitest';
import { referrerPackageFor } from './launch-referrer';

const URL_A = 'https://mysignet.app/?auth=1&challenge=x';

describe('referrerPackageFor', () => {
  it('returns the package when the recorded url matches', async () => {
    expect(await referrerPackageFor(URL_A, async () => ({ package: 'com.game.app', url: URL_A }))).toBe('com.game.app');
  });
  it('ignores a referrer recorded for a different url', async () => {
    expect(await referrerPackageFor(URL_A, async () => ({ package: 'com.game.app', url: 'https://mysignet.app/?auth=1&challenge=y' }))).toBeUndefined();
  });
  it('ignores a null package or null url', async () => {
    expect(await referrerPackageFor(URL_A, async () => ({ package: null, url: URL_A }))).toBeUndefined();
    expect(await referrerPackageFor(URL_A, async () => ({ package: 'com.game.app', url: null }))).toBeUndefined();
  });
  it('drops a value that is not a package name', async () => {
    expect(await referrerPackageFor(URL_A, async () => ({ package: 'https://evil.example/', url: URL_A }))).toBeUndefined();
    expect(await referrerPackageFor(URL_A, async () => ({ package: 'x'.repeat(300) + '.a', url: URL_A }))).toBeUndefined();
  });
  it('never throws when the native method is missing or rejects', async () => {
    expect(await referrerPackageFor(URL_A, async () => { throw new Error('not implemented'); })).toBeUndefined();
    expect(await referrerPackageFor(URL_A, (() => { throw new Error('sync'); }) as never)).toBeUndefined();
  });
});
