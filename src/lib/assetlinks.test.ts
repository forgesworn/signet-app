// src/lib/assetlinks.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// /.well-known/assetlinks.json is what makes https://mysignet.app App Links
// open the APK with no chooser. A typo here fails SILENTLY on the phone (the
// link just goes to the browser), so pin the shape and the canonical release
// cert; more may be appended, none may be malformed.
const RELEASE_CERT = '7F:99:94:A0:CF:C6:05:7A:3D:98:AA:5E:44:C4:BD:DB:B0:53:CF:F3:C9:C3:11:FD:43:91:88:64:22:CA:37:30';
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

describe('public/.well-known/assetlinks.json', () => {
  const raw = readFileSync(resolve(__dirname, '../../public/.well-known/assetlinks.json'), 'utf8');
  const doc = JSON.parse(raw) as Array<{ relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } }>;

  it('declares handle_all_urls for app.mysignet', () => {
    expect(doc).toHaveLength(1);
    expect(doc[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(doc[0].target.namespace).toBe('android_app');
    expect(doc[0].target.package_name).toBe('app.mysignet');
  });

  it('pins the canonical release cert first and every fingerprint is well-formed', () => {
    const fps = doc[0].target.sha256_cert_fingerprints;
    expect(fps[0]).toBe(RELEASE_CERT);
    for (const fp of fps) expect(fp).toMatch(FINGERPRINT);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
