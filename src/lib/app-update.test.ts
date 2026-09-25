import { describe, expect, it, vi } from 'vitest';
import {
  UPDATE_MANIFEST_URL,
  appUpdateState,
  fetchUpdateManifest,
  parseInstalledVersion,
  parseUpdateManifest,
  type UpdateManifest,
} from './app-update';

// The APK is a SNAPSHOT of dist/, not a window onto mysignet.app — deploying
// the site changes nothing on an installed APK. These pin the one honest
// answer to "am I current?" for each thing that can go wrong.

const HEX = 'a'.repeat(64);
const manifest = (versionCode: number, versionName = '0.12.0'): UpdateManifest => ({
  versionName,
  versionCode,
  apkSha256: HEX,
  certSha256: 'b'.repeat(64),
  sizeBytes: 4634868,
  builtAt: '2026-09-02T12:00:00Z',
  url: `https://mysignet.app/get/signet-app-v${versionName}.apk`,
});
const installed = { versionName: '0.11.1', versionCode: 1101 };

describe('parseUpdateManifest', () => {
  it('reads a well-formed manifest', () => {
    expect(parseUpdateManifest(manifest(1200))).toEqual(manifest(1200));
  });

  it('rejects anything malformed rather than half-reading it', () => {
    expect(parseUpdateManifest(null)).toBeNull();
    expect(parseUpdateManifest('{}')).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), versionName: '' })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), versionCode: 0 })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), versionCode: '1200' })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), versionCode: 1.5 })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), apkSha256: HEX.toUpperCase() })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), apkSha256: HEX.slice(1) })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), certSha256: 'nope' })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), sizeBytes: 0 })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), builtAt: 5 })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), url: 'http://mysignet.app/get/x.apk' })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), url: undefined })).toBeNull();
  });

  it('pins url to the mysignet.app origin exactly', () => {
    expect(parseUpdateManifest({ ...manifest(1200), url: 'https://evil.example/x.apk' })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), url: 'https://mysignet.app.evil.example/x.apk' })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), url: 'https://' })).toBeNull();
    expect(
      parseUpdateManifest({ ...manifest(1200), url: 'https://mysignet.app/get/signet-app-v0.12.0.apk' }),
    ).toEqual({ ...manifest(1200), url: 'https://mysignet.app/get/signet-app-v0.12.0.apk' });
  });

  it('bounds versionName to a safe, release-script-shaped token', () => {
    expect(parseUpdateManifest({ ...manifest(1200), versionName: 'a'.repeat(33) })).toBeNull();
    expect(parseUpdateManifest({ ...manifest(1200), versionName: '0.12 .0' })).toBeNull();
  });

  it('drops unknown fields', () => {
    const parsed = parseUpdateManifest({ ...manifest(1200), extra: 1 });
    expect(parsed).toEqual(manifest(1200));
  });
});

describe('parseInstalledVersion', () => {
  it('reads @capacitor/app getInfo() — build is the versionCode as a STRING', () => {
    expect(parseInstalledVersion({ name: 'MySignet', id: 'app.mysignet', version: '0.11.1', build: '1101' }))
      .toEqual(installed);
  });

  it('treats anything partial as no answer, not a partial one', () => {
    expect(parseInstalledVersion({ version: '0.11.1' })).toBeNull();
    expect(parseInstalledVersion({ build: '1101' })).toBeNull();
    expect(parseInstalledVersion({ version: '', build: '1101' })).toBeNull();
    expect(parseInstalledVersion({ version: '0.11.1', build: '0' })).toBeNull();
    expect(parseInstalledVersion({ version: '0.11.1', build: 'abc' })).toBeNull();
    expect(parseInstalledVersion({ version: '0.11.1', build: '11.5' })).toBeNull();
    expect(parseInstalledVersion(undefined)).toBeNull();
  });
});

describe('appUpdateState', () => {
  it('says nothing on the web — there is no APK to be behind', () => {
    expect(appUpdateState(false, installed, manifest(9999))).toEqual({ kind: 'not-native' });
  });

  it('never calls an APK that could not report itself out of date', () => {
    expect(appUpdateState(true, null, manifest(9999))).toEqual({ kind: 'unreadable' });
    expect(appUpdateState(true, null, null)).toEqual({ kind: 'unreadable' });
  });

  it('says "could not check", not "behind", when the manifest is unreachable', () => {
    expect(appUpdateState(true, installed, null)).toEqual({ kind: 'unknown', installed });
  });

  it('is current when installed >= latest (a dev build ahead of the release is current)', () => {
    expect(appUpdateState(true, installed, manifest(1101))).toEqual({ kind: 'current', installed });
    expect(appUpdateState(true, installed, manifest(2, '0.11.1'))).toEqual({ kind: 'current', installed });
  });

  it('is behind only when the manifest versionCode is strictly greater', () => {
    expect(appUpdateState(true, installed, manifest(1200))).toEqual({
      kind: 'behind',
      installed,
      latest: manifest(1200),
    });
  });
});

describe('fetchUpdateManifest', () => {
  const okResponse = (body: unknown, ok = true) =>
    ({ ok, json: async () => body }) as unknown as Response;

  it('fetches the public manifest with cache disabled', async () => {
    const fetcher = vi.fn(async () => okResponse(manifest(1200)));
    await expect(fetchUpdateManifest(fetcher as unknown as typeof fetch)).resolves.toEqual(manifest(1200));
    expect(fetcher).toHaveBeenCalledWith(UPDATE_MANIFEST_URL, { cache: 'no-store' });
  });

  it('is null on a non-2xx, on bad JSON, on a bad shape, and on a thrown fetch', async () => {
    await expect(fetchUpdateManifest((async () => okResponse({}, false)) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchUpdateManifest((async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) as unknown as Response) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchUpdateManifest((async () => okResponse({ versionName: 'x' })) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchUpdateManifest((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).resolves.toBeNull();
  });
});
