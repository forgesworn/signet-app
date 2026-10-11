import { expect, it } from 'vitest';
import { DP_PER_MM, mmToDp, SEAM_GAP_DEFAULT_MM, SEAM_GAP_DP, seamGapDp, validSeamGapMm } from './handshake-seam-gap';
import { parsePortableSettings, portableSettingsValues } from './portable-settings';
import type { AppPreferences } from '../types';

it('converts millimetres to dp at 160 dp per inch', () => {
  expect(mmToDp(25.4)).toBeCloseTo(160, 10);
  expect(mmToDp(10)).toBeCloseTo(62.992, 3);
  expect(DP_PER_MM).toBeCloseTo(6.2992, 4);
  expect(mmToDp(0)).toBe(0);
});
it('uses the 80 dp default (about 12.7 mm) when unset or invalid, and the setting otherwise, zero included', () => {
  expect(SEAM_GAP_DEFAULT_MM).toBeCloseTo(12.7, 10);
  expect(seamGapDp(undefined)).toBe(SEAM_GAP_DP);
  expect(seamGapDp(-1)).toBe(SEAM_GAP_DP); expect(seamGapDp(31)).toBe(SEAM_GAP_DP); expect(seamGapDp(Number.NaN)).toBe(SEAM_GAP_DP);
  expect(seamGapDp(0)).toBe(0);
  expect(seamGapDp(20)).toBeCloseTo(125.98, 2);
});
it('accepts 0 to 30 mm only', () => {
  for (const ok of [0, 0.5, 12.7, 30]) expect(validSeamGapMm(ok)).toBe(true);
  for (const bad of [-0.5, 30.5, Number.NaN, Infinity, '12', null, undefined]) expect(validSeamGapMm(bad)).toBe(false);
});
it('is a property of this handset: it never rides the portable settings', () => {
  const prefs = { theme: 'dark', handshakeSeamGapMm: 14 } as AppPreferences;
  expect(portableSettingsValues(prefs)).toEqual({ theme: 'dark' });
  const parsed = parsePortableSettings(JSON.stringify({ v: 1, updatedAt: 1, values: { theme: 'dark', handshakeSeamGapMm: 14 } }));
  expect(parsed?.values).toEqual({ theme: 'dark' });
});
