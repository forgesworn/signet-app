import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNativeApp: vi.fn(() => false),
  httpGet: vi.fn(),
}));
vi.mock('./native', () => ({ isNativeApp: mocks.isNativeApp }));
vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: mocks.httpGet } }));

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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isNativeApp.mockReturnValue(false);
  });

  it('fetches the public manifest with cache disabled on the web', async () => {
    const fetcher = vi.fn(async () => okResponse(manifest(1200)));
    await expect(fetchUpdateManifest(fetcher as unknown as typeof fetch)).resolves.toEqual(manifest(1200));
    expect(fetcher).toHaveBeenCalledWith(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    expect(mocks.httpGet).not.toHaveBeenCalled();
  });

  it('is null on a non-2xx, on bad JSON, on a bad shape, and on a thrown fetch (web)', async () => {
    await expect(fetchUpdateManifest((async () => okResponse({}, false)) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchUpdateManifest((async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) as unknown as Response) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchUpdateManifest((async () => okResponse({ versionName: 'x' })) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchUpdateManifest((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).resolves.toBeNull();
  });

  describe('native (Capacitor) path', () => {
    beforeEach(() => {
      mocks.isNativeApp.mockReturnValue(true);
    });

    it('fetches via CapacitorHttp.get and never touches the web fetcher', async () => {
      mocks.httpGet.mockResolvedValue({ status: 200, data: manifest(1200), headers: {}, url: UPDATE_MANIFEST_URL });
      const fetcher = vi.fn();
      await expect(fetchUpdateManifest(fetcher as unknown as typeof fetch)).resolves.toEqual(manifest(1200));
      expect(fetcher).not.toHaveBeenCalled();
      expect(mocks.httpGet).toHaveBeenCalledWith(expect.objectContaining({ url: UPDATE_MANIFEST_URL }));
    });

    it('parses a stringified JSON body the same as an already-parsed object', async () => {
      mocks.httpGet.mockResolvedValue({ status: 200, data: JSON.stringify(manifest(1200)), headers: {}, url: UPDATE_MANIFEST_URL });
      await expect(fetchUpdateManifest()).resolves.toEqual(manifest(1200));
    });

    it('is null on a non-2xx status — never "behind", never a thrown response', async () => {
      mocks.httpGet.mockResolvedValue({ status: 404, data: manifest(1200), headers: {}, url: UPDATE_MANIFEST_URL });
      await expect(fetchUpdateManifest()).resolves.toBeNull();
      mocks.httpGet.mockResolvedValue({ status: 500, data: '', headers: {}, url: UPDATE_MANIFEST_URL });
      await expect(fetchUpdateManifest()).resolves.toBeNull();
    });

    it('is null on a bad shape, unparsable string body, or a thrown request', async () => {
      mocks.httpGet.mockResolvedValue({ status: 200, data: { versionName: 'x' }, headers: {}, url: UPDATE_MANIFEST_URL });
      await expect(fetchUpdateManifest()).resolves.toBeNull();
      mocks.httpGet.mockResolvedValue({ status: 200, data: 'not json', headers: {}, url: UPDATE_MANIFEST_URL });
      await expect(fetchUpdateManifest()).resolves.toBeNull();
      mocks.httpGet.mockRejectedValue(new Error('native http failed'));
      await expect(fetchUpdateManifest()).resolves.toBeNull();
    });
  });
});
