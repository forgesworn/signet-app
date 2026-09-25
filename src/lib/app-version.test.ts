// src/lib/app-version.test.ts
import { describe, expect, it } from 'vitest';
import { versionCodeFor } from './app-version';

// The ONE numeric the update check compares. Gradle derives the same number
// in android/app/build.gradle — if you change the rule here, change it there.
describe('versionCodeFor', () => {
  it('is major*10000 + minor*100 + patch', () => {
    expect(versionCodeFor('0.11.1')).toBe(1101);
    expect(versionCodeFor('0.12.0')).toBe(1200);
    expect(versionCodeFor('1.0.0')).toBe(10000);
    expect(versionCodeFor('2.34.56')).toBe(23456);
  });

  it('ignores a pre-release suffix', () => {
    expect(versionCodeFor('0.12.0-beta.1')).toBe(1200);
  });

  it('is strictly increasing across the releases we have shipped', () => {
    // v0.11.1 shipped with a hand-set versionCode of 2; the derived code must
    // exceed it or Android will refuse the upgrade.
    expect(versionCodeFor('0.11.1')).toBeGreaterThan(2);
  });

  it('rejects anything that is not a semver triple', () => {
    expect(() => versionCodeFor('0.11')).toThrow(/bad semver/);
    expect(() => versionCodeFor('v0.11.1')).toThrow(/bad semver/);
    expect(() => versionCodeFor('')).toThrow(/bad semver/);
  });
});
